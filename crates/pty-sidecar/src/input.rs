//! Bounds on what the parent's stdin can make the host hold: one unfinished frame, and the input
//! the command has not read yet.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};

/// Cuts stdin into frames (lines without their newline). A frame longer than `limit` is never held:
/// it is discarded up to its newline.
pub struct LineSplitter {
    limit: usize,
    partial: Vec<u8>,
    skipping: bool,
}

impl LineSplitter {
    pub fn new(limit: usize) -> Self {
        Self { limit, partial: Vec::new(), skipping: false }
    }

    /// Hands each frame `chunk` completes to `frame`, and returns how many frames it discarded.
    pub fn feed(&mut self, mut chunk: &[u8], mut frame: impl FnMut(&[u8])) -> usize {
        let mut dropped = 0;
        while let Some(end) = chunk.iter().position(|&byte| byte == b'\n') {
            let line = &chunk[..end];
            if self.skipping {
                self.skipping = false;
            } else if self.partial.is_empty() {
                if line.len() <= self.limit {
                    frame(line);
                } else {
                    dropped += 1;
                }
            } else if self.partial.len() + line.len() <= self.limit {
                self.partial.extend_from_slice(line);
                frame(&self.partial);
                // a frame can be 17 MiB: its memory goes with it
                self.partial = Vec::new();
            } else {
                self.partial = Vec::new();
                dropped += 1;
            }
            chunk = &chunk[end + 1..];
        }
        if !self.skipping && !chunk.is_empty() {
            if self.partial.len() + chunk.len() <= self.limit {
                self.partial.extend_from_slice(chunk);
            } else {
                self.partial = Vec::new();
                self.skipping = true;
                dropped += 1;
            }
        }
        dropped
    }
}

struct Queued {
    frames: VecDeque<Vec<u8>>,
    /// queued and being written: a frame counts until the command has taken all of it
    bytes: usize,
}

/// Input waiting for the command, at most `limit` bytes; a frame always fits into an empty queue.
pub struct InputQueue {
    limit: usize,
    queued: Mutex<Queued>,
    arrived: Condvar,
}

impl InputQueue {
    pub fn new(limit: usize) -> Self {
        Self { limit, queued: Mutex::new(Queued { frames: VecDeque::new(), bytes: 0 }), arrived: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Queued> {
        self.queued.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Queues `data` whole, or refuses it (false) when it would take the queue past its limit.
    pub fn push(&self, data: Vec<u8>) -> bool {
        let mut queued = self.lock();
        if queued.bytes > 0 && queued.bytes + data.len() > self.limit {
            return false;
        }
        queued.bytes += data.len();
        queued.frames.push_back(data);
        self.arrived.notify_one();
        true
    }

    pub fn next(&self) -> Vec<u8> {
        let mut queued = self.lock();
        loop {
            if let Some(data) = queued.frames.pop_front() {
                return data;
            }
            queued = self.arrived.wait(queued).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    /// The command has taken `len` bytes `next` gave out.
    pub fn written(&self, len: usize) {
        let mut queued = self.lock();
        queued.bytes = queued.bytes.saturating_sub(len);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(splitter: &mut LineSplitter, chunk: &[u8]) -> (Vec<Vec<u8>>, usize) {
        let mut frames = Vec::new();
        let dropped = splitter.feed(chunk, |frame| frames.push(frame.to_vec()));
        (frames, dropped)
    }

    #[test]
    fn joins_a_frame_split_across_reads() {
        let mut splitter = LineSplitter::new(16);
        assert_eq!(split(&mut splitter, b"{\"t\":"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"\"w\"}\nab"), (vec![b"{\"t\":\"w\"}".to_vec()], 0));
        assert_eq!(split(&mut splitter, b"c\n\n"), (vec![b"abc".to_vec(), b"".to_vec()], 0));
    }

    #[test]
    fn keeps_a_frame_of_exactly_the_limit() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"ab"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"cd\nwxyz\n"), (vec![b"abcd".to_vec(), b"wxyz".to_vec()], 0));
    }

    #[test]
    fn discards_an_unfinished_frame_past_the_limit_up_to_its_newline() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"abc"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"defgh"), (vec![], 1));
        assert_eq!(split(&mut splitter, b"ijklmnop"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"qr\nok\n"), (vec![b"ok".to_vec()], 0));
    }

    #[test]
    fn discards_a_whole_frame_past_the_limit_in_one_read() {
        let mut splitter = LineSplitter::new(4);
        assert_eq!(split(&mut splitter, b"abcdef\nok\n"), (vec![b"ok".to_vec()], 1));
        assert_eq!(split(&mut splitter, b"ab"), (vec![], 0));
        assert_eq!(split(&mut splitter, b"cde\nok\n"), (vec![b"ok".to_vec()], 1));
    }

    #[test]
    fn takes_a_frame_into_an_empty_queue_whatever_its_size() {
        let queue = InputQueue::new(4);
        assert!(queue.push(vec![0; 10]));
        assert!(!queue.push(vec![0; 1]));
    }

    #[test]
    fn refuses_input_past_the_limit_until_the_command_takes_some() {
        let queue = InputQueue::new(4);
        assert!(queue.push(vec![1; 3]));
        assert!(queue.push(vec![2; 1]));
        assert!(!queue.push(vec![3; 1]));
        let first = queue.next();
        assert_eq!(first, vec![1; 3]);
        // still counted while it is being written
        assert!(!queue.push(vec![3; 1]));
        queue.written(first.len());
        assert!(queue.push(vec![3; 3]));
        assert_eq!(queue.next(), vec![2; 1]);
        assert_eq!(queue.next(), vec![3; 3]);
    }
}

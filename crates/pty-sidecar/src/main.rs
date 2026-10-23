//! Runs ONE command on a pseudo-terminal and bridges it to its parent, with the protocol of
//! server/pty/pty-host.mjs:
//!   argv:   <cols> <rows> <command> [args...]
//!   stdin:  newline-delimited JSON control frames (see frames.rs)
//!   stdout: the pty's bytes
//!   stderr: diagnostics only
//!   exit:   the child's exit code, 0 when a signal ended it

mod frames;
mod pty;

use frames::Frame;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// After the child exits, what is left in the pty is read for at most this long, paused or not
/// (node-pty's DESTROY_SOCKET_TIMEOUT_MS): EOF usually comes first.
const EXIT_GRACE: Duration = Duration::from_millis(200);
const KILL_AFTER: Duration = Duration::from_secs(2);
const REAP_WAIT: Duration = Duration::from_secs(1);
const READ_CHUNK: usize = 64 * 1024;

struct State {
    paused: bool,
    stopping: bool,
    exit: Option<(i32, Instant)>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    pid: libc::pid_t,
    wake: OwnedFd,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Signals the child only while it has not been reaped (the waiter reaps under this lock).
    fn signal(&self, state: &State, signal: libc::c_int) {
        if state.exit.is_none() {
            unsafe { libc::kill(self.pid, signal) };
        }
    }

    fn notify(&self) {
        self.changed.notify_all();
        pty::wake(self.wake.as_raw_fd());
    }
}

/// The parent left or asked us to end: hang up the child, read on to its EOF, and give it KILL_AFTER.
fn stop(shared: &Arc<Shared>) {
    {
        let mut state = shared.lock();
        if state.exit.is_some() || state.stopping {
            return;
        }
        state.stopping = true;
        state.paused = false;
        shared.signal(&state, libc::SIGHUP);
    }
    shared.notify();
    let shared = Arc::clone(shared);
    thread::spawn(move || {
        thread::sleep(KILL_AFTER);
        let mut state = shared.lock();
        shared.signal(&state, libc::SIGKILL);
        // exit only once the child is reaped: herdr frees the attach slot when the attach is gone
        let deadline = Instant::now() + REAP_WAIT;
        while state.exit.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = shared.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        std::process::exit(0);
    });
}

fn main() {
    let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
    if argv.len() < 3 {
        eprintln!("pty-sidecar: usage: ovis-pty-sidecar <cols> <rows> <command> [args...]");
        std::process::exit(2);
    }
    let cols = frames::initial_size(&argv[0].to_string_lossy(), 80);
    let rows = frames::initial_size(&argv[1].to_string_lossy(), 24);

    // blocked before any thread starts, so only the signal thread takes them
    let stop_signals = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };

    let (master, pid) = match pty::spawn(&argv[2], &argv[3..], cols, rows) {
        Ok(started) => started,
        Err(error) => {
            eprintln!("pty-sidecar: {}: {error}", String::from_utf8_lossy(argv[2].as_bytes()));
            std::process::exit(1);
        }
    };
    let (wake_read, wake_write) = pty::wake_pipe().unwrap_or_else(|error| {
        eprintln!("pty-sidecar: {error}");
        std::process::exit(1);
    });
    let shared = Arc::new(Shared {
        state: Mutex::new(State { paused: false, stopping: false, exit: None }),
        changed: Condvar::new(),
        pid,
        wake: wake_write,
    });

    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            pty::wait_exited(shared.pid);
            {
                let mut state = shared.lock();
                let code = pty::reap(shared.pid);
                state.exit = Some((code, Instant::now()));
            }
            shared.notify();
        });
    }
    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || loop {
            let mut signal = 0;
            if unsafe { libc::sigwait(&stop_signals, &mut signal) } == 0 {
                stop(&shared);
            }
        });
    }
    let input = match master.try_clone() {
        Ok(writer) => spawn_writer(writer),
        Err(error) => {
            eprintln!("pty-sidecar: {error}");
            std::process::exit(1);
        }
    };
    {
        let shared = Arc::clone(&shared);
        let master = master.as_raw_fd();
        thread::spawn(move || control(&shared, &input, master));
    }

    let code = pump(&shared, master.as_raw_fd(), wake_read.as_raw_fd());
    std::process::exit(code);
}

/// Input goes through its own thread: a child that does not read must never hold up the control frames behind it.
fn spawn_writer(master: OwnedFd) -> mpsc::Sender<Vec<u8>> {
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut master = File::from(master);
        for data in receiver {
            let _ = master.write_all(&data);
        }
    });
    sender
}

fn control(shared: &Arc<Shared>, input: &mpsc::Sender<Vec<u8>>, master: RawFd) {
    let mut stdin = io::stdin().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        match stdin.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // a last line without its newline is not a frame (pty-host.mjs drops it too)
        if line.last() != Some(&b'\n') {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let Some(frame) = frames::parse(text.trim()) else { continue };
        match frame {
            Frame::Input(text) => {
                let _ = input.send(text.into_bytes());
            }
            Frame::Resize(cols, rows) => {
                if let Err(error) = pty::resize(master, cols, rows) {
                    eprintln!("pty-sidecar: {error}");
                }
            }
            Frame::Winch => shared.signal(&shared.lock(), libc::SIGWINCH),
            Frame::Pause(paused) => {
                let mut state = shared.lock();
                if !state.stopping {
                    state.paused = paused;
                    drop(state);
                    shared.changed.notify_all();
                }
            }
        }
    }
    stop(shared);
}

enum Gate {
    /// `left`: the time to read on, once the child has exited
    Read { left: Option<Duration> },
    Finish,
}

/// Holds reads while the parent has output paused (input stays live meanwhile).
fn gate(shared: &Shared) -> Gate {
    let mut state = shared.lock();
    loop {
        let left = match state.exit {
            None => None,
            Some((_, at)) => match EXIT_GRACE.checked_sub(at.elapsed()) {
                Some(left) if !left.is_zero() => Some(left),
                _ => return Gate::Finish,
            },
        };
        if !state.paused || state.stopping {
            return Gate::Read { left };
        }
        state = match left {
            None => shared.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner()),
            Some(left) => shared.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0,
        };
    }
}

/// Copies the pty to stdout until it ends, then returns the child's exit code. A blocking write to stdout
/// holds the reads, so a parent that stops reading stops the pty too.
fn pump(shared: &Arc<Shared>, master: RawFd, wake: RawFd) -> i32 {
    let mut stdout = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    let mut buf = vec![0u8; READ_CHUNK];
    let mut discard = false;
    loop {
        let left = match gate(shared) {
            Gate::Finish => break,
            Gate::Read { left } => left,
        };
        let ready = match pty::wait_readable(master, wake, left) {
            Ok(Some(ready)) => ready,
            Ok(None) => continue,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if ready.wake {
            pty::drain(wake);
        }
        if !ready.master {
            continue;
        }
        // a pause taken while waiting holds what arrived after it
        {
            let state = shared.lock();
            if state.paused && !state.stopping {
                continue;
            }
        }
        match pty::read(master, &mut buf) {
            Ok(0) => break,
            Ok(read) => {
                if !discard && stdout.write_all(&buf[..read]).is_err() {
                    // the parent is gone (EPIPE): end the child, and keep reading so it never blocks on output
                    discard = true;
                    stop(shared);
                }
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) => continue,
            // EIO: every slave descriptor is closed
            Err(_) => break,
        }
    }
    let mut state = shared.lock();
    loop {
        if let Some((code, _)) = state.exit {
            return code;
        }
        state = shared.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

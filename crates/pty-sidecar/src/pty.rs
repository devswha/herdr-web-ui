use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

/// node-pty 1.1.0's termios (src/unix/pty.cc), so a program sees the same line discipline under either host.
fn termios() -> libc::termios {
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    term.c_iflag = libc::ICRNL | libc::IXON | libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8;
    term.c_oflag = libc::OPOST | libc::ONLCR;
    term.c_cflag = libc::CREAD | libc::CS8 | libc::HUPCL;
    term.c_lflag = libc::ICANON | libc::ISIG | libc::IEXTEN | libc::ECHO | libc::ECHOE | libc::ECHOK | libc::ECHOKE | libc::ECHOCTL;
    let cc = &mut term.c_cc;
    cc[libc::VEOF] = 4;
    // node-pty assigns -1 to an unsigned cc_t
    cc[libc::VEOL] = 0xff;
    cc[libc::VEOL2] = 0xff;
    cc[libc::VERASE] = 0x7f;
    cc[libc::VWERASE] = 23;
    cc[libc::VKILL] = 21;
    cc[libc::VREPRINT] = 18;
    cc[libc::VINTR] = 3;
    cc[libc::VQUIT] = 0x1c;
    cc[libc::VSUSP] = 26;
    cc[libc::VSTART] = 17;
    cc[libc::VSTOP] = 19;
    cc[libc::VLNEXT] = 22;
    cc[libc::VDISCARD] = 15;
    cc[libc::VMIN] = 1;
    cc[libc::VTIME] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[libc::VDSUSP] = 25;
        cc[libc::VSTATUS] = 20;
    }
    unsafe {
        libc::cfsetispeed(&mut term, libc::B38400);
        libc::cfsetospeed(&mut term, libc::B38400);
    }
    term
}

fn set_flags(fd: &OwnedFd, nonblocking: bool) -> io::Result<()> {
    let fd = fd.as_raw_fd();
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFD) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) })?;
    if nonblocking {
        let status = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
        check(unsafe { libc::fcntl(fd, libc::F_SETFL, status | libc::O_NONBLOCK) })?;
    }
    Ok(())
}

/// pty-host.mjs runs the command in `HOME`, or `/` without one; node-pty takes an empty one as its own cwd.
fn working_directory() -> io::Result<PathBuf> {
    match std::env::var_os("HOME") {
        None => Ok(PathBuf::from("/")),
        Some(home) if home.is_empty() => std::env::current_dir(),
        Some(home) => Ok(PathBuf::from(home)),
    }
}

/// This process's environment as pty-host.mjs and node-pty hand it on: no bridge token under either name,
/// `TERM=xterm-256color`, `PWD` the working directory.
fn environment(cwd: &OsStr) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| key != "OVIS_TOKEN" && key != "HERDR_WEB_TOKEN" && key != "TERM" && key != "PWD")
        .collect();
    env.push(("PWD".into(), cwd.to_owned()));
    env.push(("TERM".into(), "xterm-256color".into()));
    env
}

/// Starts `command` as the session leader of a new pty, its controlling terminal: the master and the child's pid.
pub fn spawn(command: &OsStr, args: &[OsString], cols: u16, rows: u16) -> io::Result<(OwnedFd, libc::pid_t)> {
    let (mut master, mut slave): (RawFd, RawFd) = (-1, -1);
    let mut term = termios();
    let mut size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // *mut: macOS declares both mutable, Linux const
    check(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), &raw mut term, &raw mut size) })?;
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    set_flags(&master, false)?;
    set_flags(&slave, false)?;

    let cwd = working_directory()?;
    let mut cmd = Command::new(command);
    cmd.args(args)
        .env_clear()
        .envs(environment(cwd.as_os_str()))
        .current_dir(&cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    unsafe {
        // runs in the child after std has put the slave on 0, 1 and 2, and before exec
        cmd.pre_exec(|| {
            check(libc::setsid())?;
            check(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::pthread_sigmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(cmd);
    drop(slave);
    Ok((master, child.id() as libc::pid_t))
}

pub fn resize(master: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    check(unsafe { libc::ioctl(master, libc::TIOCSWINSZ as _, &size) }).map(drop)
}

pub fn wake_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds: [RawFd; 2] = [-1, -1];
    check(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    set_flags(&read, true)?;
    set_flags(&write, true)?;
    Ok((read, write))
}

pub struct Ready {
    pub master: bool,
    pub wake: bool,
}

/// Waits until the master or the wake pipe can be read, or `timeout` passes (None).
/// select, not poll: macOS's poll does not support terminal devices.
pub fn wait_readable(master: RawFd, wake: RawFd, timeout: Option<Duration>) -> io::Result<Option<Ready>> {
    if master.max(wake) >= libc::FD_SETSIZE as RawFd {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "descriptor above FD_SETSIZE"));
    }
    unsafe {
        let mut set: libc::fd_set = std::mem::zeroed();
        libc::FD_ZERO(&mut set);
        libc::FD_SET(master, &mut set);
        libc::FD_SET(wake, &mut set);
        let mut limit = timeout.map(|left| libc::timeval { tv_sec: left.as_secs() as _, tv_usec: left.subsec_micros() as _ });
        let limit = limit.as_mut().map_or(std::ptr::null_mut(), |limit| limit as *mut libc::timeval);
        let ready = check(libc::select(master.max(wake) + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), limit))?;
        if ready == 0 {
            return Ok(None);
        }
        Ok(Some(Ready { master: libc::FD_ISSET(master, &set), wake: libc::FD_ISSET(wake, &set) }))
    }
}

pub fn read(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if read < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(read as usize)
    }
}

pub fn drain(fd: RawFd) {
    let mut buf = [0u8; 64];
    while unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
}

pub fn wake(fd: RawFd) {
    let byte = 1u8;
    unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
}

/// Blocks until the child has exited, without reaping it: its pid cannot be reused before `reap`.
pub fn wait_exited(pid: libc::pid_t) {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if rc == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

/// Reaps an exited child: its exit code, or 0 when a signal ended it (node-pty reports it so).
pub fn reap(pid: libc::pid_t) -> i32 {
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(pid, &mut status, 0) };
        if rc == pid {
            break;
        }
        if rc == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return 0;
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        0
    }
}

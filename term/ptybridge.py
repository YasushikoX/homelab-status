#!/usr/bin/env python3
"""Run a command in a pseudo-terminal and relay it over plain pipes.

stdin  -> terminal input
stdout <- terminal output
fd 3   <- control lines: "resize <cols> <rows>\n"

Used by the status dashboard's web terminal (Node has no built-in pty).
Python 3.9+ standard library only. Usage: ptybridge.py <cmd> [args...]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: ptybridge.py <cmd> [args...]")
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.execvp(sys.argv[1], sys.argv[1:])
    set_size(master, 100, 30)
    ctl = 3
    try:
        os.fstat(ctl)
    except OSError:
        ctl = None
    ctl_buf = b""
    fds = [0, master] + ([ctl] if ctl is not None else [])
    while True:
        try:
            r, _, _ = select.select(fds, [], [], 1.0)
        except InterruptedError:
            continue
        if master in r:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO:  # child closed the terminal
                    break
                raise
            if not data:
                break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data:  # browser went away
                os.kill(pid, signal.SIGHUP)
                break
            os.write(master, data)
        if ctl is not None and ctl in r:
            chunk = os.read(ctl, 4096)
            if not chunk:
                fds.remove(ctl)
                ctl = None
                continue
            ctl_buf += chunk
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                parts = line.decode(errors="ignore").split()
                if len(parts) == 3 and parts[0] == "resize" and parts[1].isdigit() and parts[2].isdigit():
                    set_size(master, max(20, min(500, int(parts[1]))), max(5, min(200, int(parts[2]))))
                    os.kill(pid, signal.SIGWINCH)
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
    except ChildProcessError:
        sys.exit(0)


if __name__ == "__main__":
    main()

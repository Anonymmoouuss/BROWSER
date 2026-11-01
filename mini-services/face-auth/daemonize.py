#!/usr/bin/env python3
"""daemonize.py -- double-fork + setsid launcher.

Usage: python3 daemonize.py <logfile> <command> [args...]

Plain `&` / `setsid` children get killed at Bash-tool call boundaries in this
sandbox; a double-forked, reparented process survives.
"""
import os
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: daemonize.py <logfile> <command> [args...]", file=sys.stderr)
        return 2
    logfile = sys.argv[1]
    cmd = sys.argv[2:]

    pid = os.fork()
    if pid > 0:
        return 0
    try:
        os.setsid()
    except OSError:
        pass
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(fd)
    fd0 = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd0, 0)

    os.execvp(cmd[0], cmd)
    return 1


if __name__ == "__main__":
    sys.exit(main())

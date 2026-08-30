"""Run a command under a real pty and answer its passphrase prompt(s).

WHY THIS EXISTS AT ALL. `age` reads a passphrase from `/dev/tty` and from
nowhere else -- there is no `AGE_PASSPHRASE`, and piping to its stdin gets
"standard input is not a terminal, and /dev/tty is not available" (measured
against age 1.2.1). So the passphrase half of the differential test -- the ONLY
test that can catch a parameter defect in `crypto/age.ts` block #4, because six
of them are symmetric and round-trip through our own code perfectly -- cannot
run without a pty. `script(1)` is unavailable in some sandboxes; Python's `pty`
module is the portable answer on POSIX.

WHY `pty.fork()` AND NOT `pty.openpty()` + `subprocess`. `openpty` gives the
child a pty on fds 0/1/2, but the child is not a session leader, so `/dev/tty`
still resolves to the PARENT's controlling terminal -- which under CI is none at
all. `pty.fork()` does the `setsid` + TIOCSCTTY dance, so `/dev/tty` in the
child IS this pty. Getting that wrong makes the harness fail in a way that looks
like age rejecting the file, which is the direction that silently turns every
rejection assertion green.

WHY THE EXIT STATUS IS TAKEN FROM `waitpid`. The escrow investigation's own
harness reported ACCEPTED for cases that are impossible, because a shell
captured a PIPELINE's exit status instead of the child's. Here the status comes
from `os.waitpid` on the pid we forked and nothing else can stand in for it.

The passphrase arrives on THIS script's stdin -- never argv (visible in `ps`)
and never the environment (`/proc/<pid>/environ`, and inherited by the child).
It is read before the fork, so the child's pty stdin is free.

argv: pty-run.py <number-of-prompts-to-answer> <program> [args...]
exit: the child's exit code; the child's terminal output goes to stderr.
"""

import errno
import os
import pty
import select
import sys

TIMEOUT_SECONDS = 60

prompts_to_answer = int(sys.argv[1])
argv = sys.argv[2:]
secret = sys.stdin.buffer.read()

pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(argv[0], argv)
    finally:
        # execvp only returns on failure. 127 is the shell's own "not found",
        # and it must not be confused with age's 1 ("rejected").
        os._exit(127)

answered = 0
transcript = bytearray()
since_last_answer = bytearray()
while True:
    try:
        readable, _, _ = select.select([fd], [], [], TIMEOUT_SECONDS)
    except InterruptedError:
        continue
    if not readable:
        # A hung child is a failure, not a rejection: kill it and say so with a
        # status no age build produces.
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        sys.stderr.buffer.write(bytes(transcript))
        sys.stderr.write("\npty-run: timed out waiting for the child\n")
        sys.exit(99)
    try:
        data = os.read(fd, 4096)
    except OSError as e:
        # EIO is how a pty master reports "the slave side closed".
        if e.errno == errno.EIO:
            break
        raise
    if not data:
        break
    transcript += data
    since_last_answer += data
    # age's prompts all end in ": ". Answering on the colon is enough and does
    # not depend on the exact wording, which differs between `-p` (two prompts,
    # one of them a confirmation) and `-d -i` ("Enter passphrase for identity
    # file ...").
    while answered < prompts_to_answer and b":" in since_last_answer:
        os.write(fd, secret + b"\n")
        answered += 1
        since_last_answer = bytearray()

_, status = os.waitpid(pid, 0)
sys.stderr.buffer.write(bytes(transcript))
sys.exit(os.waitstatus_to_exitcode(status))

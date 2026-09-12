#!/usr/bin/env python3
"""
WHOSE CRASH WAS IT, AND WHAT DOES THAT MAKE INVALID.

verify-instrumentation-results.sh used to do this:

    if grep -n "FATAL EXCEPTION" "$LOGCAT"; then
      note "::error::the app under test hit an uncaught exception"
      FAILED=1

An emulator runs Gmail, Play services, a launcher and a wallpaper picker,
and any of them can crash while the suite is running. Run 34642729506 is
exactly that: the only FATAL EXCEPTION in the whole log was Gmail's, and
the run was failed for "the app under test hit an uncaught exception". A
red line that means nothing is worse than no line - it teaches whoever
reads it to discount the next one.

FOUR VERDICTS, BECAUSE "NOT OURS" IS NOT ONE THING.

  APP_FATAL         com.fpvarbcon, com.fpvarbcon.test, or a named
                    subprocess of either. FAILS as a defect in the
                    application, and the block is printed whole.

  PLATFORM_FATAL    system_server and the other processes the platform
                    itself is made of. FAILS - but as the TEST ENVIRONMENT
                    being invalid, not as our defect. When the platform
                    dies underneath a suite, every green case after it was
                    measured on a machine that was already broken, so it
                    cannot be waved through; and it is not our crash, so it
                    must not be reported as one. Both halves are said
                    explicitly.

  EXTERNAL_FATAL    any other process. Recorded in one line, does not fail,
                    and is never attributed to the application.

  UNRESOLVED_FATAL  the process could not be determined even after the
                    resolution below. FAILS THE EVIDENCE GATE, because a
                    crash nobody can attribute is a hole in the evidence -
                    and is NOT called an app crash, because guessing is how
                    the original defect got written.

HOW A PID IS RESOLVED BEFORE UNRESOLVED IS DECLARED. In order:

  1  the "Process: <name>, PID: <pid>" line the platform writes directly
     under the header, accepted only when its own PID matches the header's.
  2  the event log. am_crash, am_proc_start and am_proc_died all carry
     [.., pid, .., processName, ..], and ActivityManager writes
     "Start proc <pid>:<name>/<uid>" and "Process <name> (pid <pid>) has
     died" in plain text. Every such line in the WHOLE log is indexed.
  3  TIMING, when the index holds more than one name for a PID - the
     kernel reuses PIDs. The occurrence closest in the log to the crash
     header wins, and the distance is printed so a far-away match can be
     judged rather than trusted.

Usage:
  classify-fatal-blocks.py <logcat.txt>   read a log; non-zero unless every
                                          block is EXTERNAL_FATAL or there
                                          are none
  classify-fatal-blocks.py --self-test    run the planted controls

NOT VERIFIED ON REAL HARDWARE.
"""

from __future__ import annotations

import re
import sys

APP_PACKAGE = "com.fpvarbcon"

APP_FATAL = "APP_FATAL"
PLATFORM_FATAL = "PLATFORM_FATAL"
EXTERNAL_FATAL = "EXTERNAL_FATAL"
UNRESOLVED_FATAL = "UNRESOLVED_FATAL"

#: Verdicts that fail. EXTERNAL_FATAL is the only one that does not.
FAILING = {APP_FATAL, PLATFORM_FATAL, UNRESOLVED_FATAL}

#: The processes the platform itself is made of. Deliberately a short
#: explicit list rather than a pattern: "com.android.*" would capture
#: com.android.chrome, which is an ordinary application, and a rule that
#: silently reclassifies third-party crashes as platform ones would hide
#: exactly what EXTERNAL_FATAL exists to show.
PLATFORM_PROCESSES = frozenset(
    {
        "system_server",
        "zygote",
        "zygote64",
        "com.android.systemui",
        "com.android.phone",
    }
)

# "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
LOGCAT_LINE = re.compile(
    r"^\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+[VDIWEFS]\s+([^:]+):\s?(.*)$"
)
PROCESS_LINE = re.compile(r"\bProcess:\s*([A-Za-z0-9_.:]+)\s*,\s*PID:\s*(\d+)")

#: am_crash: [pid,uid,processName,...] - and am_proc_died is
#: [userId,pid,processName,...], so the pid is not always in the same slot.
#: Both shapes are read, and a token that is not a plausible process name
#: is ignored rather than guessed at.
EVENT_AM_CRASH = re.compile(r"\bam_crash\s*:\s*\[(\d+),\s*\d+,\s*([A-Za-z0-9_.:]+)")
EVENT_AM_PROC_START = re.compile(
    r"\bam_proc_start\s*:\s*\[\d+,\s*(\d+),\s*\d+,\s*([A-Za-z0-9_.:]+)"
)
EVENT_AM_PROC_DIED = re.compile(r"\bam_proc_died\s*:\s*\[\d+,\s*(\d+),\s*([A-Za-z0-9_.:]+)")
TEXT_START_PROC = re.compile(r"\bStart proc (\d+):([A-Za-z0-9_.:]+)/")
TEXT_PROC_DIED = re.compile(r"\bProcess ([A-Za-z0-9_.:]+) \(pid (\d+)\) has died")

PROCESS_SEARCH_LINES = 8
MAX_BLOCK_LINES = 60


def belongs_to_app(process: str) -> bool:
    """
    Our application, our instrumentation, or a named subprocess of either.

    Matched on the whole name or on a "package:suffix" subprocess, never on
    a prefix: com.fpvarbcon.debug would be a DIFFERENT application id and
    com.fpvarbconfuser is not ours at all.
    """
    return (
        process == APP_PACKAGE
        or process == f"{APP_PACKAGE}.test"
        or process.startswith(f"{APP_PACKAGE}:")
        or process.startswith(f"{APP_PACKAGE}.test:")
    )


def verdict_for(process: str) -> str:
    if belongs_to_app(process):
        return APP_FATAL
    if process in PLATFORM_PROCESSES:
        return PLATFORM_FATAL
    return EXTERNAL_FATAL


def pid_index(lines: list[str]) -> dict[str, list[tuple[int, str, str]]]:
    """
    {pid -> [(line index, process name, which pattern found it)]}

    Built from the WHOLE log, because the line that names a process is
    usually nowhere near the crash - it is written when the process starts.
    """
    found: dict[str, list[tuple[int, str, str]]] = {}

    def remember(index: int, pid: str, name: str, source: str) -> None:
        found.setdefault(pid, []).append((index, name, source))

    for index, line in enumerate(lines):
        for pattern, source in (
            (EVENT_AM_CRASH, "am_crash"),
            (EVENT_AM_PROC_START, "am_proc_start"),
            (EVENT_AM_PROC_DIED, "am_proc_died"),
            (TEXT_START_PROC, "Start proc"),
        ):
            match = pattern.search(line)
            if match:
                remember(index, match.group(1), match.group(2), source)
        died = TEXT_PROC_DIED.search(line)
        if died:
            remember(index, died.group(2), died.group(1), "has died")
        owner = PROCESS_LINE.search(line)
        if owner:
            remember(index, owner.group(2), owner.group(1), "Process:")
    return found


def resolve(pid: str | None, at_line: int, index: dict) -> tuple[str | None, str]:
    """
    The process name for [pid], chosen by closeness to [at_line].

    PIDs are reused, so when the index holds several names for one pid the
    nearest in the log wins and the distance travelled is reported - a
    match found four thousand lines away is a different quality of evidence
    from one found next door, and the reader should be able to see which
    they have.
    """
    if pid is None:
        return None, "no pid on the crash header"
    candidates = index.get(pid)
    if not candidates:
        return None, f"pid {pid} is named nowhere in this log"
    line, name, source = min(candidates, key=lambda entry: abs(entry[0] - at_line))
    distance = abs(line - at_line)
    return name, f"pid {pid} -> {name} via {source} at line {line + 1} ({distance} lines away)"


def parse(lines: list[str]) -> list[dict]:
    """Every FATAL EXCEPTION block, with whatever the log says about it."""
    index = pid_index(lines)
    blocks: list[dict] = []

    for position, line in enumerate(lines):
        if "FATAL EXCEPTION" not in line:
            continue

        header = LOGCAT_LINE.match(line)
        header_pid = header.group(1) if header else None

        # 1. The Process: line directly under the header.
        process = None
        how = ""
        for offset, candidate in enumerate(
            lines[position + 1 : position + 1 + PROCESS_SEARCH_LINES]
        ):
            if "FATAL EXCEPTION" in candidate:
                break
            owner = PROCESS_LINE.search(candidate)
            if not owner:
                continue
            candidate_match = LOGCAT_LINE.match(candidate)
            candidate_pid = candidate_match.group(1) if candidate_match else None
            if header_pid and candidate_pid and header_pid != candidate_pid:
                continue
            process = owner.group(1)
            how = f"Process: line {offset + 1} under the header"
            break

        # 2 and 3. The event log and plain-text process names, nearest first.
        if process is None:
            process, how = resolve(header_pid, position, index)

        verdict = verdict_for(process) if process else UNRESOLVED_FATAL

        body: list[str] = [line.rstrip("\n")]
        for candidate in lines[position + 1 : position + MAX_BLOCK_LINES]:
            if "FATAL EXCEPTION" in candidate:
                break
            candidate_match = LOGCAT_LINE.match(candidate)
            if header_pid and candidate_match and candidate_match.group(1) != header_pid:
                break
            body.append(candidate.rstrip("\n"))

        blocks.append(
            {
                "verdict": verdict,
                "process": process,
                "pid": header_pid,
                "line": position + 1,
                "how": how,
                "body": body,
            }
        )
    return blocks


def report(blocks: list[dict], out=sys.stdout) -> int:
    """Prints the verdicts. Returns the number of FAILING blocks."""
    if not blocks:
        print("no FATAL EXCEPTION in logcat", file=out)
        return 0

    counts: dict[str, int] = {}
    for block in blocks:
        counts[block["verdict"]] = counts.get(block["verdict"], 0) + 1

    summary = " ".join(
        f"{kind}={counts.get(kind, 0)}"
        for kind in (APP_FATAL, PLATFORM_FATAL, EXTERNAL_FATAL, UNRESOLVED_FATAL)
    )
    print(f"FATAL blocks: {len(blocks)} ({summary})", file=out)

    for block in blocks:
        where = f"at logcat line {block['line']}"
        if block["verdict"] == APP_FATAL:
            print(
                f"::error::{APP_FATAL} in {block['process']} (pid {block['pid']}) {where} - "
                f"this IS the application under test [{block['how']}]",
                file=out,
            )
            for entry in block["body"]:
                print(f"  {entry[:300]}", file=out)
        elif block["verdict"] == PLATFORM_FATAL:
            print(
                f"::error::{PLATFORM_FATAL} in {block['process']} (pid {block['pid']}) {where} - "
                "the PLATFORM crashed under the suite, so the test environment was not valid "
                f"for whatever ran after it. This is NOT a crash in {APP_PACKAGE} and is not "
                f"reported as one [{block['how']}]",
                file=out,
            )
            for entry in block["body"]:
                print(f"  {entry[:300]}", file=out)
        elif block["verdict"] == EXTERNAL_FATAL:
            print(
                f"{EXTERNAL_FATAL}: {block['process']} (pid {block['pid']}) {where} - another "
                f"process on the emulator, NOT attributed to {APP_PACKAGE} [{block['how']}]",
                file=out,
            )
        else:
            print(
                f"::error::{UNRESOLVED_FATAL} {where} - the process could not be determined "
                f"({block['how']}). A crash nobody can attribute is a hole in the evidence, so "
                f"this fails; it is NOT counted as a crash in {APP_PACKAGE}",
                file=out,
            )
            for entry in block["body"][:12]:
                print(f"  {entry[:300]}", file=out)

    return sum(counts.get(kind, 0) for kind in FAILING)


# ---------------------------------------------------------------------------
# THE PLANTED CONTROLS
#
# A classifier nobody tested is a guess with line numbers. These run in CI
# before the verdict on every instrumentation job - a control that only ran
# once, by hand, is not a control.
# ---------------------------------------------------------------------------

APP_CRASH = """\
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: Process: com.fpvarbcon, PID: 6941
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

APP_SUBPROCESS_CRASH = """\
09-11 20:39:15.619  7000  7000 E AndroidRuntime: FATAL EXCEPTION: worker
09-11 20:39:15.619  7000  7000 E AndroidRuntime: Process: com.fpvarbcon:transport, PID: 7000
09-11 20:39:15.619  7000  7000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

PLATFORM_CRASH = """\
09-11 20:39:15.619   530   642 E AndroidRuntime: FATAL EXCEPTION: Binder:530_4
09-11 20:39:15.619   530   642 E AndroidRuntime: Process: system_server, PID: 530
09-11 20:39:15.619   530   642 E AndroidRuntime: java.lang.NullPointerException: planted
"""

GMAIL_CRASH = """\
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: Process: com.google.android.gm, PID: 2866
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
"""

LOOKALIKE_CRASH = """\
09-11 20:39:15.619  8000  8000 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  8000  8000 E AndroidRuntime: Process: com.fpvarbconfuser, PID: 8000
09-11 20:39:15.619  8000  8000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: No Process line under the header, but the event log names the pid as
#: OURS. This must resolve to APP_FATAL rather than being written off.
UNKNOWN_PID_RESOLVING_TO_APP = """\
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10192,com.fpvarbcon,activity,x]
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
09-11 20:39:15.619  6941  7741 E AndroidRuntime: \tat com.fpvarbcon.MainActivity.onCreate(MainActivity.kt:1)
"""

#: The same shape, resolving to somebody else's process via am_crash.
UNKNOWN_PID_RESOLVING_TO_EXTERNAL = """\
09-11 20:38:01.100   530  1000 I am_crash: [2866,10144,com.google.android.gm,0,planted]
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
"""

#: And to the platform, via the plain-text "Start proc" line.
UNKNOWN_PID_RESOLVING_TO_PLATFORM = """\
09-11 20:38:01.100   530  1000 I ActivityManager: Start proc 530:system_server/1000 for x
09-11 20:39:15.619   530   642 E AndroidRuntime: FATAL EXCEPTION: Binder:530_4
09-11 20:39:15.619   530   642 E AndroidRuntime: java.lang.NullPointerException: planted
"""

#: Nothing anywhere names this pid. MUST be UNRESOLVED_FATAL and MUST make
#: the script exit non-zero.
UNRESOLVABLE = """\
09-11 20:39:15.619  4242  4242 E AndroidRuntime: FATAL EXCEPTION: some-thread
09-11 20:39:15.619  4242  4242 E AndroidRuntime: java.lang.RuntimeException: planted
09-11 20:39:15.619  4242  4242 E AndroidRuntime: \tat unknown.Frame.run(Frame.java:1)
"""


class _Sink:
    def __init__(self) -> None:
        self.text = ""

    def write(self, chunk: str) -> int:
        self.text += chunk
        return len(chunk)


def self_test() -> int:
    cases = [
        ("an app crash is the app's", APP_CRASH, APP_FATAL, 1),
        ("a named subprocess of the app is the app's", APP_SUBPROCESS_CRASH, APP_FATAL, 1),
        ("system_server is the platform, not us", PLATFORM_CRASH, PLATFORM_FATAL, 1),
        ("Gmail crashing is not ours and does not fail", GMAIL_CRASH, EXTERNAL_FATAL, 0),
        ("a package that merely starts the same is not ours", LOOKALIKE_CRASH, EXTERNAL_FATAL, 0),
        (
            "an unknown pid the event log resolves to US is ours",
            UNKNOWN_PID_RESOLVING_TO_APP,
            APP_FATAL,
            1,
        ),
        (
            "an unknown pid the event log resolves to somebody else is theirs",
            UNKNOWN_PID_RESOLVING_TO_EXTERNAL,
            EXTERNAL_FATAL,
            0,
        ),
        (
            "an unknown pid the event log resolves to the platform is the platform's",
            UNKNOWN_PID_RESOLVING_TO_PLATFORM,
            PLATFORM_FATAL,
            1,
        ),
        ("an unresolvable pid fails without being blamed on us", UNRESOLVABLE, UNRESOLVED_FATAL, 1),
        ("a clean log is clean", "", None, 0),
    ]

    problems = 0
    print("===== FATAL ATTRIBUTION SELF-TEST =====")
    for name, fixture, expected_verdict, expected_failures in cases:
        blocks = parse(fixture.splitlines())
        verdict = blocks[0]["verdict"] if blocks else None
        sink = _Sink()
        failures = report(blocks, out=sink)
        ok = verdict == expected_verdict and failures == expected_failures
        print(
            f"  [{'OK ' if ok else 'BAD'}] {name}: verdict={verdict} "
            f"(expected {expected_verdict}), failing={failures} (expected {expected_failures})"
        )
        if blocks and blocks[0]["how"]:
            print(f"         resolution: {blocks[0]['how']}")
        if not ok:
            problems += 1

    # THE WORDINGS THAT MUST NEVER APPEAR ON SOMEBODY ELSE'S CRASH.
    #
    # Checked on the VERDICT LINES ONLY, not on the whole report. The first
    # line is a census that necessarily contains the text "APP_FATAL=0", and
    # a naive substring search over the report tripped on it - the control
    # caught itself, which is the right way round.
    def verdict_lines(text: str) -> str:
        return "\n".join(text.splitlines()[1:])

    for name, fixture in (
        ("Gmail", GMAIL_CRASH),
        ("system_server", PLATFORM_CRASH),
        ("an unresolvable block", UNRESOLVABLE),
    ):
        sink = _Sink()
        report(parse(fixture.splitlines()), out=sink)
        body = verdict_lines(sink.text)
        blamed = f"::error::{APP_FATAL}" in body or "application under test" in body
        print(f"  [{'OK ' if not blamed else 'BAD'}] {name} is never called a crash in our app")
        if blamed:
            problems += 1

    # And the one that must say so.
    sink = _Sink()
    report(parse(APP_CRASH.splitlines()), out=sink)
    body = verdict_lines(sink.text)
    named = f"::error::{APP_FATAL}" in body and "application under test" in body
    print(f"  [{'OK ' if named else 'BAD'}] our own crash IS called a crash in our app")
    if not named:
        problems += 1

    # PLATFORM_FATAL must fail AND say the environment is what is invalid.
    sink = _Sink()
    platform_failures = report(parse(PLATFORM_CRASH.splitlines()), out=sink)
    body = verdict_lines(sink.text)
    correct = platform_failures == 1 and "test environment was not valid" in body
    print(
        f"  [{'OK ' if correct else 'BAD'}] system_server fails as an invalid environment, "
        "not as our defect"
    )
    if not correct:
        problems += 1

    print(f"  problems: {problems}")
    print("=" * 39)
    return problems


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--self-test":
        return 1 if self_test() else 0
    if len(argv) < 2:
        print("usage: classify-fatal-blocks.py <logcat.txt> | --self-test")
        return 2
    try:
        with open(argv[1], errors="replace") as handle:
            lines = handle.readlines()
    except OSError as error:
        print(f"::warning::could not read {argv[1]}: {error}")
        return 0
    return 1 if report(parse(lines)) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

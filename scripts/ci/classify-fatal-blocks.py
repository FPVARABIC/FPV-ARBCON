#!/usr/bin/env python3
"""
WHOSE CRASH WAS IT.

verify-instrumentation-results.sh used to do this:

    if grep -n "FATAL EXCEPTION" "$LOGCAT"; then
      note "::error::the app under test hit an uncaught exception"
      FAILED=1

An emulator runs Gmail, Play services, the launcher and a wallpaper
picker, and any of them can crash while our suite is running. Run
34642729506 is exactly that: the only FATAL EXCEPTION in the whole log was

    FATAL EXCEPTION: Blocking Thread #1
    Process: com.google.android.gm, PID: 2866
    android.os.RemoteException: The com.google.android.gms.auth.accounts
    provider is not available.

and the run was failed with "the app under test hit an uncaught
exception". That is a false accusation against our own application, and a
red line that means nothing is worse than no line at all - it teaches
whoever reads it to ignore the next one.

So every FATAL block is read, not just counted, and attributed from the
"Process: <name>, PID: <pid>" line the platform writes immediately under
each header. Three verdicts, and only one of them fails a run:

  APP_FATAL           Process is com.fpvarbcon, com.fpvarbcon.test, or a
                      named subprocess of either (com.fpvarbcon:something).
                      FAILS. The whole block is printed, never truncated
                      to a verdict.

  EXTERNAL_FATAL      Process is anything else. Recorded in one line -
                      process, PID and exception type - so it is visible
                      that the emulator was noisy, and NOT attributed to
                      the application.

  UNATTRIBUTED_FATAL  No Process line under the header, so nothing in the
                      log says whose it was. Reported as exactly that,
                      with its frames, and it does NOT fail the run and is
                      NOT called an app crash. Guessing here is how the
                      original defect happened; a block we cannot attribute
                      is a gap in the evidence, not evidence of a crash in
                      our code.

Usage:
  classify-fatal-blocks.py <logcat.txt>   read a log, exit 1 on APP_FATAL
  classify-fatal-blocks.py --self-test    run the planted controls

NOT VERIFIED ON REAL HARDWARE.
"""

from __future__ import annotations

import re
import sys

APP_PACKAGE = "com.fpvarbcon"

APP_FATAL = "APP_FATAL"
EXTERNAL_FATAL = "EXTERNAL_FATAL"
UNATTRIBUTED_FATAL = "UNATTRIBUTED_FATAL"

# "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
LOGCAT_LINE = re.compile(
    r"^\s*\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+(\d+)\s+[VDIWEFS]\s+([^:]+):\s?(.*)$"
)
PROCESS_LINE = re.compile(r"\bProcess:\s*([A-Za-z0-9_.:]+)\s*,\s*PID:\s*(\d+)")

# How far under a header the Process line is looked for. The platform
# writes it as the very next AndroidRuntime line; a few spare lines allow
# for interleaving from another thread without letting an unrelated
# process's header far below be read as this one's owner.
PROCESS_SEARCH_LINES = 8

# How much of a block is kept. An app crash is printed whole up to this;
# an external one never needs more than its first line.
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


def parse(lines: list[str]) -> list[dict]:
    """Every FATAL EXCEPTION block, with whatever the log says about it."""
    found: list[dict] = []
    for index, line in enumerate(lines):
        if "FATAL EXCEPTION" not in line:
            continue

        match = LOGCAT_LINE.match(line)
        header_pid = match.group(1) if match else None

        process = None
        process_pid = None
        for candidate in lines[index + 1 : index + 1 + PROCESS_SEARCH_LINES]:
            if "FATAL EXCEPTION" in candidate:
                break
            owner = PROCESS_LINE.search(candidate)
            if not owner:
                continue
            # Only believe a Process line written by the same process as
            # the header, when both are readable.
            candidate_match = LOGCAT_LINE.match(candidate)
            candidate_pid = candidate_match.group(1) if candidate_match else None
            if header_pid and candidate_pid and header_pid != candidate_pid:
                continue
            process, process_pid = owner.group(1), owner.group(2)
            break

        if process is None:
            verdict = UNATTRIBUTED_FATAL
        elif belongs_to_app(process):
            verdict = APP_FATAL
        else:
            verdict = EXTERNAL_FATAL

        # The block runs until the next header or until the logging
        # process changes, whichever comes first.
        body: list[str] = [line.rstrip("\n")]
        for candidate in lines[index + 1 : index + MAX_BLOCK_LINES]:
            if "FATAL EXCEPTION" in candidate:
                break
            candidate_match = LOGCAT_LINE.match(candidate)
            if header_pid and candidate_match and candidate_match.group(1) != header_pid:
                break
            body.append(candidate.rstrip("\n"))

        found.append(
            {
                "verdict": verdict,
                "process": process,
                "pid": process_pid or header_pid,
                "line": index + 1,
                "header": line.strip(),
                "body": body,
            }
        )
    return found


def report(blocks: list[dict], out=sys.stdout) -> int:
    """Prints the verdicts. Returns the number of APP_FATAL blocks."""
    if not blocks:
        print("no FATAL EXCEPTION in logcat", file=out)
        return 0

    counts = {APP_FATAL: 0, EXTERNAL_FATAL: 0, UNATTRIBUTED_FATAL: 0}
    for block in blocks:
        counts[block["verdict"]] += 1

    print(
        f"FATAL blocks: {len(blocks)} "
        f"({APP_FATAL}={counts[APP_FATAL]} "
        f"{EXTERNAL_FATAL}={counts[EXTERNAL_FATAL]} "
        f"{UNATTRIBUTED_FATAL}={counts[UNATTRIBUTED_FATAL]})",
        file=out,
    )

    for block in blocks:
        if block["verdict"] == APP_FATAL:
            print(
                f"::error::{APP_FATAL} in {block['process']} (PID {block['pid']}) "
                f"at logcat line {block['line']} - this IS the application under test",
                file=out,
            )
            for entry in block["body"]:
                print(f"  {entry[:300]}", file=out)
        elif block["verdict"] == EXTERNAL_FATAL:
            print(
                f"{EXTERNAL_FATAL}: {block['process']} (PID {block['pid']}) at logcat line "
                f"{block['line']} - another process on the emulator, NOT attributed to "
                f"{APP_PACKAGE}",
                file=out,
            )
        else:
            print(
                f"::warning::{UNATTRIBUTED_FATAL} at logcat line {block['line']} - no "
                "\"Process:\" line under the header, so the log does not say whose crash this "
                f"was. It is NOT counted as a crash in {APP_PACKAGE}.",
                file=out,
            )
            for entry in block["body"][:12]:
                print(f"  {entry[:300]}", file=out)

    return counts[APP_FATAL]


# ---------------------------------------------------------------------------
# THE PLANTED CONTROLS
#
# A classifier nobody tested is a guess with line numbers. These three are
# the cases that matter, and they run in CI on every instrumentation job -
# a control that only ran once, by hand, is not a control.
# ---------------------------------------------------------------------------

APP_CRASH_FIXTURE = """\
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: Process: com.fpvarbcon, PID: 6941
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
09-11 20:39:15.619  6941  7741 E AndroidRuntime: \tat com.fpvarbcon.MainActivity.onCreate(MainActivity.kt:1)
"""

GMAIL_CRASH_FIXTURE = """\
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: Process: com.google.android.gm, PID: 2866
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
09-11 20:39:15.619  2866  2976 E AndroidRuntime: \tat qwz.k(PG:7)
"""

HEADERLESS_FIXTURE = """\
09-11 20:39:15.619  4242  4242 E AndroidRuntime: FATAL EXCEPTION: some-thread
09-11 20:39:15.619  4242  4242 E AndroidRuntime: java.lang.RuntimeException: planted
09-11 20:39:15.619  4242  4242 E AndroidRuntime: \tat unknown.Frame.run(Frame.java:1)
"""

SUBPROCESS_FIXTURE = """\
09-11 20:39:15.619  7000  7000 E AndroidRuntime: FATAL EXCEPTION: worker
09-11 20:39:15.619  7000  7000 E AndroidRuntime: Process: com.fpvarbcon:transport, PID: 7000
09-11 20:39:15.619  7000  7000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

LOOKALIKE_FIXTURE = """\
09-11 20:39:15.619  8000  8000 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  8000  8000 E AndroidRuntime: Process: com.fpvarbconfuser, PID: 8000
09-11 20:39:15.619  8000  8000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""


def self_test() -> int:
    cases = [
        ("an app crash is the app's", APP_CRASH_FIXTURE, APP_FATAL, 1),
        ("a named subprocess of the app is the app's", SUBPROCESS_FIXTURE, APP_FATAL, 1),
        ("Gmail crashing is not ours", GMAIL_CRASH_FIXTURE, EXTERNAL_FATAL, 0),
        ("a package that merely starts the same is not ours", LOOKALIKE_FIXTURE, EXTERNAL_FATAL, 0),
        ("a block with no Process line is not named a crash in our app", HEADERLESS_FIXTURE, UNATTRIBUTED_FATAL, 0),
        ("a clean log is clean", "", None, 0),
    ]

    problems = 0
    print("===== FATAL ATTRIBUTION SELF-TEST =====")
    for name, fixture, expected_verdict, expected_failures in cases:
        blocks = parse(fixture.splitlines())
        verdict = blocks[0]["verdict"] if blocks else None
        failures = sum(1 for block in blocks if block["verdict"] == APP_FATAL)
        ok = verdict == expected_verdict and failures == expected_failures
        print(
            f"  [{'OK ' if ok else 'BAD'}] {name}: verdict={verdict} "
            f"(expected {expected_verdict}), app-fatal count={failures} "
            f"(expected {expected_failures})"
        )
        if not ok:
            problems += 1

    # The specific regression this file exists for: the Gmail block must
    # not be able to fail a run, however it is phrased.
    gmail_report_lines: list[str] = []

    class Sink:
        def write(self, text: str) -> int:
            gmail_report_lines.append(text)
            return len(text)

    failures = report(parse(GMAIL_CRASH_FIXTURE.splitlines()), out=Sink())
    text = "".join(gmail_report_lines)
    named_as_app = "::error::" in text or "app under test" in text
    print(
        f"  [{'OK ' if failures == 0 and not named_as_app else 'BAD'}] "
        "the Gmail block produces no error line and no app attribution"
    )
    if failures != 0 or named_as_app:
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

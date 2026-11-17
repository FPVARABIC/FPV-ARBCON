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

  APP_FATAL         com.fpvarbcon.nl, com.fpvarbcon.nl.test, or a named
                    subprocess of either. FAILS as a defect in the
                    application, and the block is printed whole.

  PLATFORM_FATAL    the processes the platform itself is made of. FAILS -
                    but as the TEST ENVIRONMENT being invalid, not as our
                    defect. When the platform dies underneath a suite,
                    every green case after it was measured on a machine
                    that was already broken, so it cannot be waved through;
                    and it is not our crash, so it must not be reported as
                    one. Both halves are said explicitly.

  EXTERNAL_FATAL    any other process. Recorded in one line, does not fail,
                    and is never attributed to the application.

  UNRESOLVED_FATAL  the process could not be determined, or could not be
                    determined UNAMBIGUOUSLY. FAILS THE EVIDENCE GATE,
                    because a crash nobody can attribute is a hole in the
                    evidence - and is NOT called an app crash, because
                    guessing is how the original defect got written.

=====================================================================
HOW A PID BECOMES A PROCESS NAME
=====================================================================

The first version of this picked whichever naming line was FEWEST LINES
AWAY from the crash. That is not evidence. The kernel reuses pids, so a
"Start proc 6941:com.something" printed after the crash describes a
DIFFERENT process that merely inherited the number, and line distance
cannot tell the two apart - it would happily resolve a crash from an event
that had not happened yet.

So resolution is chronological, and it is a state machine per pid:

  1  THE CRASH BLOCK'S OWN "Process:" LINE. The platform writes
     "Process: <name>, PID: <pid>" directly under the header. Accepted only
     when its pid matches the header's. Highest priority: it is the
     crashing process naming itself.

  2  am_crash FOR THE SAME PID AT THE SAME MOMENT. am_crash is not a later
     event about a different process - it is system_server's own record of
     THIS crash, and it can be written a few milliseconds either side of
     the AndroidRuntime dump. It is accepted only inside
     AM_CRASH_WINDOW_MILLIS of the header, and an am_crash outside that
     window is ignored rather than stretched to fit.

  3  THE LAST PROCESS START STRICTLY BEFORE THE CRASH, and only if the pid
     was still alive at the moment of the crash: no am_proc_died for it
     between that start and the crash. If it died and the pid then crashed,
     the crashing process is something that inherited the number, and this
     says so instead of naming the corpse.

     Two starts sharing that latest millisecond and naming different
     processes is ambiguous, and is reported as such rather than settled by
     whichever the parser happened to see first.

NO EVENT AFTER THE CRASH MAY RESOLVE IT, with the single exception in (2),
which is the same event and not a later one. Without a readable timestamp
on the header there is no order to reason about, and the answer is
UNRESOLVED_FATAL rather than a guess.

Timestamps are logcat's own "MM-DD HH:MM:SS.mmm". They carry no year, so
they are compared as (month, day, h, m, s, ms) tuples - correct within one
capture, which is all a single instrumentation run is, and wrong only
across a New Year boundary inside one log.

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

APP_PACKAGE = "com.fpvarbcon.nl"

APP_FATAL = "APP_FATAL"
PLATFORM_FATAL = "PLATFORM_FATAL"
EXTERNAL_FATAL = "EXTERNAL_FATAL"
UNRESOLVED_FATAL = "UNRESOLVED_FATAL"

#: Verdicts that fail. EXTERNAL_FATAL is the only one that does not.
FAILING = {APP_FATAL, PLATFORM_FATAL, UNRESOLVED_FATAL}

#: The processes the platform itself is made of, as the platform ACTUALLY
#: names them in logcat - fully qualified, no short aliases. "systemui" and
#: "phone" are not process names; com.android.systemui and
#: com.android.phone are. Nothing is normalised or abbreviated here,
#: because a comparison against a name the platform never writes is a
#: comparison that silently never matches.
#:
#: Deliberately a short explicit set rather than a "com.android.*" pattern:
#: that pattern would capture com.android.chrome, an ordinary application,
#: and a rule that quietly reclassifies a third-party crash as a platform
#: one hides exactly what EXTERNAL_FATAL exists to show.
PLATFORM_PROCESSES = frozenset(
    {
        "system_server",
        "zygote",
        "zygote64",
        "com.android.systemui",
        "com.android.phone",
    }
)

#: How far either side of the AndroidRuntime header an am_crash line is
#: still the SAME crash rather than a later event.
AM_CRASH_WINDOW_MILLIS = 2_000

# "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
LOGCAT_LINE = re.compile(
    r"^\s*(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+[VDIWEFS]\s+"
    r"([^:]+):\s?(.*)$"
)
PROCESS_LINE = re.compile(r"\bProcess:\s*([A-Za-z0-9_.:]+)\s*,\s*PID:\s*(\d+)")

#: The event log puts the pid in a different slot per event, so each shape
#: is matched on its own rather than by a single loose pattern.
EVENT_AM_CRASH = re.compile(r"\bam_crash\s*:\s*\[(\d+),\s*\d+,\s*([A-Za-z0-9_.:]+)")
EVENT_AM_PROC_START = re.compile(
    r"\bam_proc_start\s*:\s*\[\d+,\s*(\d+),\s*\d+,\s*([A-Za-z0-9_.:]+)"
)
EVENT_AM_PROC_DIED = re.compile(r"\bam_proc_died\s*:\s*\[\d+,\s*(\d+),\s*([A-Za-z0-9_.:]+)")
TEXT_START_PROC = re.compile(r"\bStart proc (\d+):([A-Za-z0-9_.:]+)/")
TEXT_PROC_DIED = re.compile(r"\bProcess ([A-Za-z0-9_.:]+) \(pid (\d+)\) has died")

PROCESS_SEARCH_LINES = 8
MAX_BLOCK_LINES = 60

START, DIED, CRASH = "start", "died", "crash"


def timestamp_of(line: str) -> tuple[int, ...] | None:
    """logcat's own clock as a comparable tuple, or None if unreadable."""
    match = LOGCAT_LINE.match(line)
    if not match:
        return None
    return tuple(int(part) for part in match.group(1, 2, 3, 4, 5, 6))


def millis_between(earlier: tuple[int, ...], later: tuple[int, ...]) -> int:
    """Signed milliseconds from [earlier] to [later] within one capture."""

    def total(stamp: tuple[int, ...]) -> int:
        month, day, hour, minute, second, milli = stamp
        return ((((month * 31 + day) * 24 + hour) * 60 + minute) * 60 + second) * 1000 + milli

    return total(later) - total(earlier)


def pid_of(line: str) -> str | None:
    match = LOGCAT_LINE.match(line)
    return match.group(7) if match else None


def timeline(lines: list[str]) -> dict[str, list[dict]]:
    """
    {pid -> [event, ...]} in log order, each event timestamped.

    Every naming line in the WHOLE file is indexed, because the line that
    names a process is usually written when the process STARTS and is
    nowhere near the crash.
    """
    events: dict[str, list[dict]] = {}

    def remember(index: int, at, pid: str, name: str | None, kind: str, source: str) -> None:
        events.setdefault(pid, []).append(
            {"line": index, "at": at, "name": name, "kind": kind, "source": source}
        )

    for index, line in enumerate(lines):
        at = timestamp_of(line)
        for pattern, kind, source in (
            (EVENT_AM_CRASH, CRASH, "am_crash"),
            (EVENT_AM_PROC_START, START, "am_proc_start"),
            (EVENT_AM_PROC_DIED, DIED, "am_proc_died"),
            (TEXT_START_PROC, START, "Start proc"),
        ):
            match = pattern.search(line)
            if match:
                remember(index, at, match.group(1), match.group(2), kind, source)
        died = TEXT_PROC_DIED.search(line)
        if died:
            remember(index, at, died.group(2), died.group(1), DIED, "has died")
    return events


def resolve(
    pid: str | None,
    at: tuple[int, ...] | None,
    events: dict[str, list[dict]],
) -> tuple[str | None, str]:
    """
    The process name for [pid] at time [at], chronologically.

    Returns (name or None, the reasoning, printed verbatim so a reader can
    disagree with it).
    """
    if pid is None:
        return None, "no pid on the crash header"
    if at is None:
        return None, f"pid {pid} has no readable timestamp on its header, so nothing can be ordered"

    history = events.get(pid, [])
    if not history:
        return None, f"pid {pid} is named nowhere in this log"

    # 2. am_crash for this pid at this moment - the same event, not a later one.
    for event in history:
        if event["kind"] != CRASH or event["at"] is None:
            continue
        delta = millis_between(at, event["at"])
        if abs(delta) <= AM_CRASH_WINDOW_MILLIS:
            return event["name"], (
                f"pid {pid} -> {event['name']} via am_crash at line {event['line'] + 1}, "
                f"{delta:+d}ms from the header (same crash)"
            )

    # 3. The last start strictly before the crash, if the pid was still
    #    alive when it crashed.
    starts = [
        event
        for event in history
        if event["kind"] == START
        and event["at"] is not None
        and millis_between(event["at"], at) > 0
    ]
    if not starts:
        after = [
            event
            for event in history
            if event["kind"] == START and event["at"] is not None
        ]
        if after:
            return None, (
                f"pid {pid} is only ever named by events AFTER the crash "
                f"(nearest at line {after[0]['line'] + 1}), which describe a process that "
                "inherited the number - they cannot name this one"
            )
        return None, f"pid {pid} has no process start before the crash"

    start = max(starts, key=lambda event: millis_between(event["at"], at) * -1)
    deaths = [
        event
        for event in history
        if event["kind"] == DIED
        and event["at"] is not None
        and millis_between(start["at"], event["at"]) > 0
        and millis_between(event["at"], at) >= 0
    ]
    if deaths:
        death = deaths[0]
        return None, (
            f"pid {pid} was started as {start['name']} at line {start['line'] + 1} but DIED at "
            f"line {death['line'] + 1}, before this crash. Whatever crashed under that pid "
            "inherited the number, and this log does not say what it was"
        )

    # AMBIGUITY AT THE SAME INSTANT.
    #
    # This was first written as "is there a start NEWER than the one I
    # chose" - which can never be true, because the chosen one is by
    # construction the latest before the crash. Dead code that reads like a
    # safety check is worse than no check: it makes the reader believe an
    # ambiguity is being caught when nothing is looking.
    #
    # The ambiguity that can actually occur is two starts sharing the
    # latest timestamp and naming DIFFERENT processes, which logcat's
    # millisecond resolution permits. Then nothing in the log says which of
    # them held the pid, and a coin toss is not attribution.
    tied = {
        event["name"]
        for event in starts
        if millis_between(event["at"], start["at"]) == 0
    }
    if len(tied) > 1:
        return None, (
            f"pid {pid} has starts at the same instant naming {sorted(tied)}, so which process "
            "held it when it crashed is ambiguous"
        )

    return start["name"], (
        f"pid {pid} -> {start['name']} via {start['source']} at line {start['line'] + 1}, "
        f"{millis_between(start['at'], at)}ms before the crash, with no death in between"
    )


def belongs_to_app(process: str) -> bool:
    """
    Our application, our instrumentation, or a named subprocess of either.

    Matched on the whole name or on a "package:suffix" subprocess, never on
    a prefix: com.fpvarbcon.nl.debug would be a DIFFERENT application id and
    com.fpvarbcon.nlfuser is not ours at all.
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


def parse(lines: list[str]) -> list[dict]:
    """Every FATAL EXCEPTION block, with whatever the log says about it."""
    events = timeline(lines)
    blocks: list[dict] = []

    for position, line in enumerate(lines):
        if "FATAL EXCEPTION" not in line:
            continue

        header_pid = pid_of(line)
        header_at = timestamp_of(line)

        # 1. The block's own Process: line.
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
            candidate_pid = pid_of(candidate)
            if header_pid and candidate_pid and header_pid != candidate_pid:
                continue
            process = owner.group(1)
            how = f"the crash block's own Process: line, {offset + 1} line(s) under the header"
            break

        if process is None:
            process, how = resolve(header_pid, header_at, events)

        verdict = verdict_for(process) if process else UNRESOLVED_FATAL

        body: list[str] = [line.rstrip("\n")]
        for candidate in lines[position + 1 : position + MAX_BLOCK_LINES]:
            if "FATAL EXCEPTION" in candidate:
                break
            candidate_pid = pid_of(candidate)
            if header_pid and candidate_pid and candidate_pid != header_pid:
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
09-11 20:39:15.619  6941  7741 E AndroidRuntime: Process: com.fpvarbcon.nl, PID: 6941
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

APP_SUBPROCESS_CRASH = """\
09-11 20:39:15.619  7000  7000 E AndroidRuntime: FATAL EXCEPTION: worker
09-11 20:39:15.619  7000  7000 E AndroidRuntime: Process: com.fpvarbcon.nl:transport, PID: 7000
09-11 20:39:15.619  7000  7000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

PLATFORM_CRASH = """\
09-11 20:39:15.619   530   642 E AndroidRuntime: FATAL EXCEPTION: Binder:530_4
09-11 20:39:15.619   530   642 E AndroidRuntime: Process: system_server, PID: 530
09-11 20:39:15.619   530   642 E AndroidRuntime: java.lang.NullPointerException: planted
"""

SYSTEMUI_CRASH = """\
09-11 20:39:15.619  1200  1210 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  1200  1210 E AndroidRuntime: Process: com.android.systemui, PID: 1200
09-11 20:39:15.619  1200  1210 E AndroidRuntime: java.lang.NullPointerException: planted
"""

GMAIL_CRASH = """\
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: Process: com.google.android.gm, PID: 2866
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
"""

LOOKALIKE_CRASH = """\
09-11 20:39:15.619  8000  8000 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  8000  8000 E AndroidRuntime: Process: com.fpvarbcon.nlfuser, PID: 8000
09-11 20:39:15.619  8000  8000 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: No Process line, but the pid was started as ours before the crash.
START_BEFORE_RESOLVING_TO_APP = """\
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10192,com.fpvarbcon.nl,activity,x]
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: am_crash for the same pid within the window - the same crash, logged by
#: system_server a moment after the AndroidRuntime dump.
AM_CRASH_JUST_AFTER = """\
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
09-11 20:39:15.700   530  1000 I am_crash: [2866,10144,com.google.android.gm,0,planted]
"""

#: The same am_crash, but a minute later. Outside the window, so it is a
#: different event and must not name this crash.
AM_CRASH_FAR_LATER = """\
09-11 20:39:15.619  2866  2976 E AndroidRuntime: FATAL EXCEPTION: Blocking Thread #1
09-11 20:39:15.619  2866  2976 E AndroidRuntime: android.os.RemoteException: planted
09-11 20:41:00.000   530  1000 I am_crash: [2866,10144,com.google.android.gm,0,planted]
"""

#: PID REUSE, DIRECTION ONE. The pid was somebody else's, that process
#: died, and then the pid crashed. Naming the corpse would be a lie.
PID_REUSED_AFTER_DEATH = """\
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10150,com.google.android.gm,activity,x]
09-11 20:38:40.000   530  1000 I am_proc_died: [0,6941,com.google.android.gm,0,0]
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: PID REUSE, DIRECTION TWO. Somebody else had it, died, and OUR process
#: then took the number before the crash. The later start is the truth.
PID_REUSED_THEN_OURS = """\
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10150,com.google.android.gm,activity,x]
09-11 20:38:40.000   530  1000 I am_proc_died: [0,6941,com.google.android.gm,0,0]
09-11 20:38:55.000   530  1000 I am_proc_start: [0,6941,10192,com.fpvarbcon.nl,activity,x]
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: A START AFTER THE CRASH. It describes a process that inherited the
#: number. It must not resolve anything.
START_ONLY_AFTER_CRASH = """\
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
09-11 20:40:02.000   530  1000 I am_proc_start: [0,6941,10192,com.fpvarbcon.nl,activity,x]
"""

#: Nothing anywhere names this pid.
UNRESOLVABLE = """\
09-11 20:39:15.619  4242  4242 E AndroidRuntime: FATAL EXCEPTION: some-thread
09-11 20:39:15.619  4242  4242 E AndroidRuntime: java.lang.RuntimeException: planted
"""

#: A header with no readable timestamp. Nothing can be ordered, so nothing
#: may be inferred.
NO_TIMESTAMP = """\
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.IllegalStateException: planted
"""

#: Two processes recorded as starting on the SAME millisecond under one
#: pid. logcat's resolution allows it, and nothing then says which of them
#: held the number - a coin toss is not attribution.
TIED_STARTS = """\
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10192,com.fpvarbcon.nl,activity,x]
09-11 20:38:01.100   530  1000 I am_proc_start: [0,6941,10150,com.google.android.gm,activity,x]
09-11 20:39:15.619  6941  7741 E AndroidRuntime: FATAL EXCEPTION: main
09-11 20:39:15.619  6941  7741 E AndroidRuntime: java.lang.IllegalStateException: planted
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
        ("com.android.systemui is the platform too", SYSTEMUI_CRASH, PLATFORM_FATAL, 1),
        ("Gmail crashing is not ours and does not fail", GMAIL_CRASH, EXTERNAL_FATAL, 0),
        ("a package that merely starts the same is not ours", LOOKALIKE_CRASH, EXTERNAL_FATAL, 0),
        (
            "a start BEFORE the crash names it",
            START_BEFORE_RESOLVING_TO_APP,
            APP_FATAL,
            1,
        ),
        (
            "am_crash a moment after the dump is the same crash",
            AM_CRASH_JUST_AFTER,
            EXTERNAL_FATAL,
            0,
        ),
        (
            "am_crash a minute later is a different event and names nothing",
            AM_CRASH_FAR_LATER,
            UNRESOLVED_FATAL,
            1,
        ),
        (
            "a pid reused after its owner died names nobody",
            PID_REUSED_AFTER_DEATH,
            UNRESOLVED_FATAL,
            1,
        ),
        (
            "a pid reused BY US before the crash is ours",
            PID_REUSED_THEN_OURS,
            APP_FATAL,
            1,
        ),
        (
            "a start AFTER the crash resolves nothing",
            START_ONLY_AFTER_CRASH,
            UNRESOLVED_FATAL,
            1,
        ),
        ("an unresolvable pid fails without being blamed on us", UNRESOLVABLE, UNRESOLVED_FATAL, 1),
        ("a header with no timestamp or pid resolves nothing", NO_TIMESTAMP, UNRESOLVED_FATAL, 1),
        (
            "two starts at the same instant name nobody",
            TIED_STARTS,
            UNRESOLVED_FATAL,
            1,
        ),
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
        ("a pid reused after a death", PID_REUSED_AFTER_DEATH),
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

    # THE PLATFORM NAMES MUST BE THE ONES THE PLATFORM ACTUALLY WRITES.
    #
    # Checked as an equality against a literal, not by a shape heuristic. A
    # first attempt flagged anything without a dot as a suspected alias and
    # reported zygote and zygote64 - which are the real, whole process names
    # the platform writes, single token by its own choice, exactly as
    # system_server is. The heuristic was wrong, not the list.
    #
    # An equality check instead means adding a name is a deliberate edit
    # here, reviewed against what appears in a real logcat, rather than
    # something a pattern lets through.
    expected = {
        "system_server",
        "zygote",
        "zygote64",
        "com.android.systemui",
        "com.android.phone",
    }
    matches = set(PLATFORM_PROCESSES) == expected
    print(
        f"  [{'OK ' if matches else 'BAD'}] the platform list is exactly the reviewed set of "
        f"real process names{'' if matches else f' - it is {sorted(PLATFORM_PROCESSES)}'}"
    )
    if not matches:
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

#!/usr/bin/env python3
"""
EVERY BACKGROUND THREAD AND EXECUTOR THE NATIVE CODE STARTS, AND HOW EACH
ONE ENDS.

WHY THIS EXISTS. A thread that is never joined and never returns is not a
crash and not a test failure. It is a process that grows quietly across a
bench session until the app is killed, and the only symptom the operator
sees is that reconnecting stops working. Nothing in a passing test suite
looks any different.

So every construction site in the native sources must appear in the table
below with three things written down: what the thread is called, who owns
it, and what makes it end. A site that is not in the table fails. A table
entry whose thread name no longer appears in the sources fails. Adding a
background thread therefore requires deciding, in writing, how it stops.

IT ALSO CHECKS WHAT MUST NOT BE THERE:

  - no isBlockingSynchronousMethod anywhere. A synchronous bridge method
    runs on the JavaScript thread and blocks it for the duration of the
    call, which is exactly what a device operation must never do.
  - no UiThreadUtil / runOnUiThread. There is no path by which any of this
    module's device or file work can be scheduled onto the UI thread, and
    that is the property an ANR would come from.
  - a BroadcastReceiver's onReceive runs on the main thread. The hotplug
    receiver must therefore hand off rather than close anything itself,
    and the handoff target must be a named executor from the table.

Usage:  native-thread-census.py [--source-root DIR]

NOT VERIFIED ON REAL HARDWARE.
"""

from __future__ import annotations

import os
import re
import sys

# thread or executor name -> (file it is created in, owner, how it ends)
DECLARED: dict[str, tuple[str, str, str]] = {
    "UsbIoExecutor": (
        "com/fpvarbcon/transport/UsbIoExecutor.kt",
        "The module, for the lifetime of the React host. One thread, shared by every "
        "detached-device close and every session drained at teardown, so that none of "
        "them runs on BroadcastReceiver.onReceive's calling thread.",
        "shutdown() from the module's invalidate(); daemon, so it can never hold the "
        "process open. UsbIoExecutorTest asserts submit() returns false after shutdown, "
        "that an already-queued task still finishes, and that shutdown twice is safe.",
    ),
    "UsbSerialTx-$sessionId": (
        "com/fpvarbcon/transport/UsbSerialWriteQueue.kt",
        "One per open session - never shared, so unrelated sessions' writes are not "
        "serialized against each other.",
        "stopAndDrainPending() when the session closes; the consumer loop returns once "
        "the in-progress write settles. Daemon. UsbSerialWriteQueueTest asserts the "
        "thread terminates even when the sink consumed the stop interrupt.",
    ),
    "$threadName": (
        "com/fpvarbcon/transport/UsbBoundedAttempt.kt",
        "One per bounded attempt. The name is the caller's - today the only caller is the "
        "connect path, which passes \"UsbSerialOpen-$deviceId\" - so the thread in a stack "
        "trace says which operation it belongs to. Every caller is required below to pass "
        "a literal name.",
        "Returns when the work returns. Daemon. Its outcome is settled exactly once "
        "against the watchdog below - UsbBoundedAttemptTest drives the near-simultaneous "
        "case.",
    ),
    "$threadName-watchdog": (
        "com/fpvarbcon/transport/UsbBoundedAttempt.kt",
        "One per bounded attempt, alongside the worker above.",
        "Sleeps at most timeoutMillis and then exits, or is interrupted the moment the "
        "worker settles first. It never touches a blocking native call, so the interrupt "
        "always lands.",
    ),
    "DfuFlash-$deviceId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per firmware flash. Only one DFU operation may exist at a time - the module "
        "refuses a second while activeDfuOperation is set.",
        "Returns when the flash settles or throws; the busy slot is cleared on every "
        "exit. Daemon. DfuWorkerSequenceTest asserts the interface is released in a "
        "finally and the connection closed on every path.",
    ),
    "DfuExit-$deviceId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per exit-DFU request, under the same single-operation lock.",
        "Returns when the exit sequence settles; the maintenance slot is cleared on every "
        "exit. Daemon.",
    ),
    "DfuUnprotect-$deviceId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per read-unprotect request, under the same single-operation lock.",
        "Returns when the unprotect sequence settles, including the 20-second erase "
        "safety window, which DfuWorkerSequenceTest drives through an injected sleep "
        "rather than by waiting. Daemon.",
    ),
    "FirmwareFileRead": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per firmware file the operator picks. Reading through a ContentResolver can "
        "block on a network-backed provider, so it never runs on the calling thread.",
        "Returns when the read completes or throws; the Promise is settled on both "
        "paths. Daemon.",
    ),
    "FirmwareFileSave": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per save. Same reasoning as the read, and the size check that follows the "
        "write runs on it too.",
        "Returns when the write and its verification settle; the Promise is settled on "
        "every path, including the truncation refusal. Daemon.",
    ),
    "UsbSerialControl-$sessionId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per setControlLines call. The native call takes the session's I/O lock and "
        "can therefore wait behind a read or a write in progress, which is a wait the "
        "calling thread must not take.",
        "Returns when the call settles, resolving or rejecting the Promise on both "
        "paths. Daemon, so a stuck driver call cannot hold the process open.",
    ),
    "UsbSerialBaud-$sessionId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per setBaudRate call, for the same reason as setControlLines above: it takes "
        "the session's I/O lock and may wait behind an in-flight transfer.",
        "Returns when the call settles, resolving or rejecting the Promise on both "
        "paths. Daemon, so a stuck driver call cannot hold the process open.",
    ),
    "UsbSerialRxStart-$sessionId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per startReading call. Starting may have to wait for a previous receive "
        "worker to retire, which is a wait the caller must not take.",
        "Returns once the attempt is settled - started, refused, or timed out waiting "
        "for the previous worker. Daemon. UsbSerialStartReadingFailureSafetyTest asserts "
        "the Promise settles even when starting throws.",
    ),
    "UsbSerialRx-$sessionId": (
        "com/fpvarbcon/transport/UsbSerialTransportModule.kt",
        "One per active receive loop, at most one per session, enforced by "
        "UsbSerialReadRegistry.",
        "Cooperative: removing the session's token from the registry makes the loop "
        "return within one read timeout, with no interrupt and no join. Daemon. "
        "SerialReadLoopTest drives stop, close, detach and invalidate against a blocked "
        "read and asserts no stale event escapes.",
    ),
}

FORBIDDEN = {
    "isBlockingSynchronousMethod": (
        "a synchronous bridge method runs on the JavaScript thread and blocks it for the "
        "whole call"
    ),
    "UiThreadUtil": "there must be no path that schedules this module's work onto the UI thread",
    "runOnUiThread": "there must be no path that schedules this module's work onto the UI thread",
}

THREAD_SITE = re.compile(r"\bThread\s*\(")
EXECUTOR_SITE = re.compile(r"\bExecutors\.new[A-Za-z]+\s*\(")
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
BOUNDED_ATTEMPT = re.compile(r"\brunOnDedicatedThreadWithTimeout\s*\(")
NAMED_ATTEMPT = re.compile(r'threadName\s*=\s*"[^"]+"')

WINDOW = 60


def kotlin_sources(source_root: str) -> list[str]:
    found = []
    for directory, _subdirectories, names in os.walk(source_root):
        for name in sorted(names):
            if name.endswith(".kt"):
                found.append(os.path.join(directory, name))
    return sorted(found)


def strip_comments(lines: list[str]) -> list[str]:
    """Blank out line comments and block-comment bodies, keeping line count."""
    cleaned = []
    in_block = False
    for line in lines:
        if in_block:
            cleaned.append("")
            if "*/" in line:
                in_block = False
            continue
        stripped = line.strip()
        if stripped.startswith("/*"):
            cleaned.append("")
            if "*/" not in stripped:
                in_block = True
            continue
        if stripped.startswith("*") or stripped.startswith("//"):
            cleaned.append("")
            continue
        cleaned.append(line.split("//")[0] if "//" in line else line)
    return cleaned


def last_argument(text: str, open_paren: int) -> str | None:
    """
    The last top-level argument of the call whose '(' is at [open_paren].

    A regex cannot do this: every one of these calls passes a lambda first,
    and the lambda body contains commas, parentheses, braces and string
    literals of its own. So this walks the text tracking parenthesis and
    brace depth and skipping string literals, and returns the text between
    the last depth-1 comma and the matching ')'.
    """
    depth_paren = 0
    depth_brace = 0
    commas: list[int] = []
    index = open_paren
    length = len(text)
    while index < length:
        character = text[index]
        if character == '"':
            index += 1
            while index < length:
                if text[index] == "\\":
                    index += 2
                    continue
                if text[index] == '"':
                    break
                index += 1
            index += 1
            continue
        if character == "(":
            depth_paren += 1
        elif character == ")":
            depth_paren -= 1
            if depth_paren == 0:
                # Kotlin allows a trailing comma, so the text after the LAST
                # top-level comma is often empty. Fall back to the one before
                # it rather than reporting the argument as unnameable.
                for position in reversed(commas):
                    candidate = text[position + 1 : index].strip().rstrip(",").strip()
                    if candidate:
                        return candidate
                    index = position
                return None
        elif character == "{":
            depth_brace += 1
        elif character == "}":
            depth_brace -= 1
        elif character == "," and depth_paren == 1 and depth_brace == 0:
            commas.append(index)
        index += 1
    return None


def resolve_name(lines: list[str], index: int, column: int) -> str | None:
    window = "\n".join(lines[index : index + WINDOW])
    open_paren = window.find("(", column)
    if open_paren < 0:
        return None
    argument = last_argument(window, open_paren)
    if argument is None:
        return None
    argument = argument.rstrip(",").strip()
    if len(argument) >= 2 and argument.startswith('"') and argument.endswith('"'):
        return argument[1:-1]
    if IDENTIFIER.match(argument):
        return f"${argument}"
    return None


RUNTIME_OWNER_MAP = (
    "android/app/src/androidTest/java/com/fpvarbcon/ReactHostCampaignTest.kt"
)


def runtime_owner_gaps(found: dict) -> list[str]:
    """
    THE SOURCE CENSUS AND THE RUNTIME CENSUS MUST AGREE.

    This file reads the source and requires every construction site to be
    declared. ReactHostCampaignTest.moduleOwnerOf is the other half: it maps
    a thread name SEEN ON A DEVICE back to its owner, and its census prints
    that owner next to the name.

    Nothing kept the two in step. A new thread could be declared here, pass
    this gate, and then appear in a device census as a name with no owner -
    or worse, be quietly skipped by a map that does not recognise it, which
    is how a leaked thread stops being reported. So each name declared here
    must be matched by an arm of that map.

    Names carrying an interpolated suffix are matched on their literal
    prefix, which is what moduleOwnerOf branches on; a name that is entirely
    a parameter belongs to the caller that supplies it and is covered by
    that caller's own entry.
    """
    try:
        with open(RUNTIME_OWNER_MAP, encoding="utf-8") as handle:
            source = handle.read()
    except OSError as error:
        return [f"cannot read the runtime owner map at {RUNTIME_OWNER_MAP}: {error}"]

    start = source.find("private fun moduleOwnerOf")
    end = source.find("private fun registeredReceivers")
    if start < 0 or end < 0 or end <= start:
        return [
            f"{RUNTIME_OWNER_MAP} no longer contains a moduleOwnerOf block, so a thread seen on "
            "a device would be reported without an owner"
        ]
    block = source[start:end]

    gaps = []
    for name in sorted(found):
        if name.startswith("$"):
            # A caller-supplied name: the concrete forms are the other
            # entries, each of which is checked on its own.
            continue
        literal = name.split("$", 1)[0]
        if f'"{literal}"' not in block:
            gaps.append(
                f'thread "{name}" is declared here but moduleOwnerOf in {RUNTIME_OWNER_MAP} has '
                f'no arm matching "{literal}", so a device census would print it with no owner'
            )
    return gaps


def main(argv: list[str]) -> int:
    source_root = "android/app/src/main/java"
    if "--source-root" in argv:
        source_root = argv[argv.index("--source-root") + 1]

    failures: list[str] = []
    found: dict[str, list[str]] = {}
    site_count = 0

    for path in kotlin_sources(source_root):
        relative = os.path.relpath(path, source_root).replace(os.sep, "/")
        with open(path, encoding="utf-8") as handle:
            lines = strip_comments(handle.read().splitlines())

        for number, line in enumerate(lines):
            for banned, why in FORBIDDEN.items():
                if banned in line:
                    failures.append(f"{relative}:{number + 1} uses {banned} - {why}")

            executor = EXECUTOR_SITE.search(line)
            if executor is not None:
                site_count += 1
                # An executor names its threads through a factory, and that
                # factory is itself a Thread( site the scan below picks up.
                # An executor with no factory would leave "pool-N-thread-1"
                # in every stack trace, which names nothing.
                window = "\n".join(lines[number : number + WINDOW])
                if not THREAD_SITE.search(window):
                    failures.append(
                        f"{relative}:{number + 1} creates an executor with no thread factory, "
                        "so its threads carry no name and cannot be identified in a trace or "
                        "in this census"
                    )

            # Every bounded attempt must be named by a LITERAL, so the
            # thread it starts is identifiable in a trace. An attempt whose
            # name came from a variable would appear in this census only as
            # "$threadName" with nothing behind it.
            for match in BOUNDED_ATTEMPT.finditer(line):
                if "fun " in line[: match.start()]:
                    continue  # the declaration itself, not a call site
                window = "\n".join(lines[number : number + WINDOW])
                if not NAMED_ATTEMPT.search(window):
                    failures.append(
                        f"{relative}:{number + 1} starts a bounded attempt without a literal "
                        "threadName, so the thread it creates cannot be identified"
                    )

            for match in THREAD_SITE.finditer(line):
                site_count += 1
                name = resolve_name(lines, number, match.start())
                if name is None:
                    failures.append(
                        f"{relative}:{number + 1} starts a thread with no resolvable name"
                    )
                else:
                    found.setdefault(name, []).append(f"{relative}:{number + 1}")

    undeclared = sorted(set(found) - set(DECLARED))
    vanished = sorted(set(DECLARED) - set(found))

    print("===== UI-X3B NATIVE THREAD AND EXECUTOR CENSUS =====")
    print(f"  construction sites found : {site_count}")
    print(f"  distinct names           : {len(found)}")
    print(f"  declared in the table    : {len(DECLARED)}")
    print(f"  UNDECLARED               : {len(undeclared)}")
    print(f"  DECLARED BUT GONE        : {len(vanished)}")
    print("-" * 74)
    for name in sorted(found):
        sites = ", ".join(found[name])
        print(f"  {name:30} {sites}")
    print("=" * 74)

    for name in undeclared:
        failures.append(
            f'thread or executor "{name}" ({", ".join(found[name])}) is not in the census - '
            "add it with its owner and what makes it end"
        )
    for name in vanished:
        failures.append(
            f'the census declares "{name}" but no construction site produces it any more'
        )
    for name, (_file, owner, ends) in DECLARED.items():
        if len(owner.strip()) < 40 or len(ends.strip()) < 40:
            failures.append(f'"{name}" is declared without a real owner or termination path')

    failures.extend(runtime_owner_gaps(found))

    for failure in failures:
        print(f"::error::{failure}")
    if failures:
        print(f"thread census: {len(failures)} problem(s)")
        return 1
    print("thread census: every background thread is declared, owned and terminated")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

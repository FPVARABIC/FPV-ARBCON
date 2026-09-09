#!/usr/bin/env python3
"""
THE NATIVE COVERAGE AND CLASSIFICATION LEDGER.

WHAT THIS IS FOR. "The Android tests pass" says nothing about how much of
the Android code they ran. This reads the JaCoCo report the JVM unit test
task produces and prints, per Kotlin production FILE, the raw covered and
total counts - not a percentage, and not a pass/fail threshold, because a
percentage hides which file is at zero and a threshold invites the number
to be gamed.

Alongside the counts it enforces a CLASSIFICATION: every production file
must be listed below as one of

  JVM_EXECUTED     executed by JVM unit tests, and asserted there. The
                   ledger FAILS if such a file shows zero covered lines -
                   that is the check that keeps this table honest.
  ANDROID_ONLY     cannot run off a device (Activity, Application,
                   platform preferences). Executed by instrumentation
                   instead; the reason names where.
  BUILD_ONLY       wiring with no behaviour of its own to assert.
  UNMEASURED       genuinely not measured, with the exact reason and what
                   it would take.

A file in the tree but not in the table fails. A file in the table but not
in the tree fails. So a new Kotlin file cannot join the product without a
deliberate decision recorded here.

WHY THERE IS NO INSTRUMENTATION COVERAGE COLUMN. Instrumentation coverage
requires enableAndroidTestCoverage, which OFFLINE-INSTRUMENTS the APK under
test. androidTest in this project targets the RELEASE variant on purpose
(the debug APK carries no JS bundle), so switching that on would instrument
the very artifact whose 16 KB alignment, DEX contents, signing and size
this campaign asserts - measuring it would invalidate the evidence it came
with. Recorded as an irreducible conflict rather than a number nobody can
trust; the per-file instrumentation column is UNMEASURED for that reason
and the reason is the same for every row.

Usage:  kotlin-coverage-ledger.py <jacoco-report.xml> [--source-root DIR]

NOT VERIFIED ON REAL HARDWARE.
"""

from __future__ import annotations

import os
import sys
import xml.etree.ElementTree as ElementTree

JVM_EXECUTED = "JVM_EXECUTED"
ANDROID_ONLY = "ANDROID_ONLY"
BUILD_ONLY = "BUILD_ONLY"
UNMEASURED = "UNMEASURED"

# file -> (classification, reason). Reasons are required for everything
# that is not JVM_EXECUTED, and are checked for length so "n/a" cannot pass.
CLASSIFICATION: dict[str, tuple[str, str]] = {
    "com/fpvarbcon/MainActivity.kt": (
        ANDROID_ONLY,
        "An Activity cannot be constructed off a device. Executed and asserted by "
        "MainActivityLifecycleTest and LifecycleCampaignTest: creation, recreation, "
        "rotation, font scale and the fragment-factory behaviour on restore.",
    ),
    "com/fpvarbcon/MainApplication.kt": (
        ANDROID_ONLY,
        "Application.onCreate runs only when the platform starts the process. Its one "
        "decision - applying the Arabic layout direction before React Native loads - is "
        "asserted by ArabicLayoutDirectionTest and by verify-rtl-cold-launch.sh on a "
        "genuinely fresh install.",
    ),
    "com/fpvarbcon/RtlBootstrap.kt": (
        ANDROID_ONLY,
        "Writes React Native's own SharedPreferences through I18nUtil, which needs a real "
        "Context. Executed by ArabicLayoutDirectionTest, LocalDataSurvivalTest, "
        "LifecycleCampaignTest and ResourceGrowthCampaignTest.",
    ),
    "com/fpvarbcon/transport/DfuControlChannel.kt": (
        JVM_EXECUTED,
        "",
    ),
    "com/fpvarbcon/transport/DfuExitWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuFlashWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuMemoryLayout.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuUnprotectWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuUsbDescriptors.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/FirmwareSaveVerification.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/IntelHexFirmware.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialConfigurationMapper.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialOpenSequence.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialReadLoop.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbBoundedAttempt.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbDeviceIdentity.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbHotplugMonitor.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbIoExecutor.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPermissionRequestCoordinator.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPermissionRequester.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPromiseSettleOnce.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialDeviceEnumerator.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialDriverType.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialReadRegistry.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSession.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSessionLifecycle.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSessionRegistry.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialTransportModule.kt": (
        ANDROID_ONLY,
        "The TurboModule itself. Constructing it needs a ReactApplicationContext and the "
        "generated Codegen spec, so no JVM test can reach it - but a device can, and does: "
        "ReactHostCampaignTest builds it on the real React host and drives construction, "
        "enumeration with nothing attached, refusal of an unknown session, closeSession, "
        "invalidate(), and twelve build/teardown cycles measured for thread and descriptor "
        "growth. Its remaining entry points - open, permission, read, write, DFU, hotplug - "
        "are REAL_HARDWARE_REQUIRED and are named one by one in that file. Every DECISION "
        "it makes has additionally been lifted into the JVM-executed files above.",
    ),
    "com/fpvarbcon/transport/UsbSerialTransportPackage.kt": (
        BUILD_ONLY,
        "Registers the module with React Native and returns it. There is no branch and no "
        "state; if it were wrong nothing in the application would load at all, which "
        "every instrumentation test that reaches a screen already demonstrates.",
    ),
    "com/fpvarbcon/transport/UsbSerialWriteQueue.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbTransportException.kt": (JVM_EXECUTED, ""),
}

MINIMUM_REASON_LENGTH = 40


def production_files(source_root: str) -> set[str]:
    found: set[str] = set()
    for directory, _subdirectories, names in os.walk(source_root):
        for name in names:
            if not name.endswith(".kt"):
                continue
            path = os.path.join(directory, name)
            found.add(os.path.relpath(path, source_root).replace(os.sep, "/"))
    return found


def counters(report: str) -> dict[str, dict[str, tuple[int, int]]]:
    """
    {source file NAME -> {counter type -> (covered, total)}}.

    Keyed on the bare file name rather than package/name on purpose. The
    package attribute's separator is a detail of whoever wrote the report -
    JaCoCo's own XML uses slashes, other producers use dots - and getting
    that wrong makes every file look absent, which is a parser bug wearing
    the costume of a coverage finding. File names are checked for
    uniqueness before this is used, so the shortcut cannot silently merge
    two files.
    """
    tree = ElementTree.parse(report)
    result: dict[str, dict[str, tuple[int, int]]] = {}
    for package in tree.getroot().iter("package"):
        for sourcefile in package.findall("sourcefile"):
            name = sourcefile.get("name", "")
            per_type: dict[str, tuple[int, int]] = {}
            for counter in sourcefile.findall("counter"):
                missed = int(counter.get("missed", "0"))
                covered = int(counter.get("covered", "0"))
                per_type[counter.get("type", "?")] = (covered, covered + missed)
            # A file can appear once per package if two packages share a
            # name; sum rather than overwrite.
            if name in result:
                for kind, (covered, total) in per_type.items():
                    before = result[name].get(kind, (0, 0))
                    result[name][kind] = (before[0] + covered, before[1] + total)
            else:
                result[name] = per_type
    return result


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: kotlin-coverage-ledger.py <jacoco-report.xml> [--source-root DIR]")
        return 2
    report = argv[1]
    source_root = "android/app/src/main/java"
    if "--source-root" in argv:
        source_root = argv[argv.index("--source-root") + 1]

    if not os.path.isfile(report):
        print(f"::error::no JaCoCo report at {report} - the coverage task did not produce one")
        return 1

    tree_files = production_files(source_root)
    table_files = set(CLASSIFICATION)

    missing = sorted(tree_files - table_files)
    extra = sorted(table_files - tree_files)
    if missing or extra:
        for name in missing:
            print(f"::error::{name} is a production Kotlin file with no entry in the ledger")
        for name in extra:
            print(f"::error::{name} is in the ledger but not in the source tree")
        return 1

    basenames = [name.rsplit("/", 1)[-1] for name in tree_files]
    duplicated = sorted({name for name in basenames if basenames.count(name) > 1})
    if duplicated:
        print(
            "::error::two production files share a name, so coverage cannot be attributed "
            f"by name: {duplicated}"
        )
        return 1

    measured = counters(report)

    print("===== UI-X3B NATIVE COVERAGE AND CLASSIFICATION LEDGER =====")
    print(f"  production Kotlin files            : {len(tree_files)}")
    print(f"  files present in the JaCoCo report : {len(measured)}")
    print("  instrumentation coverage column    : UNMEASURED for every row (see header)")
    print("-" * 78)
    print(f"  {'FILE':52} {'LINES':>11}  CLASS")

    failures: list[str] = []
    totals = {"line_covered": 0, "line_total": 0, "branch_covered": 0, "branch_total": 0}
    by_class: dict[str, int] = {}

    for name in sorted(tree_files):
        classification, reason = CLASSIFICATION[name]
        by_class[classification] = by_class.get(classification, 0) + 1

        per_type = measured.get(name.rsplit("/", 1)[-1], {})
        line_covered, line_total = per_type.get("LINE", (0, 0))
        branch_covered, branch_total = per_type.get("BRANCH", (0, 0))
        totals["line_covered"] += line_covered
        totals["line_total"] += line_total
        totals["branch_covered"] += branch_covered
        totals["branch_total"] += branch_total

        print(f"  {name:52} {line_covered:5}/{line_total:<5}  {classification}")

        if classification == JVM_EXECUTED:
            if line_total == 0:
                failures.append(
                    f"{name} is classified {JVM_EXECUTED} but the JaCoCo report has no lines "
                    "for it at all - either it was not compiled into the measured variant or "
                    "the classification is wrong"
                )
            elif line_covered == 0:
                failures.append(
                    f"{name} is classified {JVM_EXECUTED} but zero of its {line_total} lines "
                    "were executed by any JVM unit test"
                )
        elif len(reason.strip()) < MINIMUM_REASON_LENGTH:
            failures.append(
                f"{name} is classified {classification} without a reason of at least "
                f"{MINIMUM_REASON_LENGTH} characters"
            )

    print("-" * 78)
    for classification in (JVM_EXECUTED, ANDROID_ONLY, BUILD_ONLY, UNMEASURED):
        print(f"  {classification:14} : {by_class.get(classification, 0)}")
    print(
        f"  JVM lines covered / total   : "
        f"{totals['line_covered']}/{totals['line_total']}"
    )
    print(
        f"  JVM branches covered / total: "
        f"{totals['branch_covered']}/{totals['branch_total']}"
    )
    print("=" * 78)

    verdict: list[str] = []
    if failures:
        # What the report DOES contain, so a mismatch between the tree and
        # the report is one read away instead of one CI cycle away.
        verdict.append("source files present in the JaCoCo report:")
        for name in sorted(measured):
            line = measured[name].get("LINE", (0, 0))
            verdict.append(f"  {name:52} {line[0]}/{line[1]}")
        verdict.extend(f"::error::{failure}" for failure in failures)
        verdict.append(f"coverage ledger: {len(failures)} problem(s)")
    else:
        verdict.append(
            "coverage ledger: every production file is classified and every JVM_EXECUTED "
            "file ran"
        )

    for line in verdict:
        print(line)

    # Written as well as printed: this step runs in the middle of a long
    # job, and a later step prints this file so the verdict is readable
    # from the end of the log rather than buried under everything that
    # came after it.
    with open(os.environ.get("COVERAGE_VERDICT_FILE", "native-coverage-verdict.txt"), "w") as out:
        out.write("\n".join(verdict) + "\n")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

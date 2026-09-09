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
        UNMEASURED,
        "The TurboModule itself. Constructing it needs a ReactApplicationContext and the "
        "generated Codegen spec, neither of which exists in a JVM test, and every "
        "decision it makes has deliberately been lifted into the files above so it can "
        "be. What remains here is dispatch and plumbing. Measuring it would take either "
        "a Robolectric runtime or a React host on a device, and neither is present.",
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
    """{sourcefile path -> {counter type -> (covered, total)}}."""
    tree = ElementTree.parse(report)
    result: dict[str, dict[str, tuple[int, int]]] = {}
    for package in tree.getroot().iter("package"):
        package_name = package.get("name", "")
        for sourcefile in package.findall("sourcefile"):
            key = f"{package_name}/{sourcefile.get('name', '')}"
            per_type: dict[str, tuple[int, int]] = {}
            for counter in sourcefile.findall("counter"):
                missed = int(counter.get("missed", "0"))
                covered = int(counter.get("covered", "0"))
                per_type[counter.get("type", "?")] = (covered, covered + missed)
            result[key] = per_type
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

        per_type = measured.get(name, {})
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

    for failure in failures:
        print(f"::error::{failure}")
    if failures:
        print(f"coverage ledger: {len(failures)} problem(s)")
        return 1
    print("coverage ledger: every production file is classified and every JVM_EXECUTED file ran")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

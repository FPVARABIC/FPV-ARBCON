#!/usr/bin/env bash
#
# EVERYTHING THAT RUNS WHILE THE EMULATOR IS UP, IN ONE BASH FILE.
#
# This used to be an inline `script:` block in the workflow, and run 228
# showed why that was a mistake:
#
#   [command]/usr/bin/sh -c set -o pipefail
#   /usr/bin/sh: 1: set: Illegal option -o pipefail
#   ##[error]The process '/usr/bin/sh' failed with exit code 2
#
# reactivecircus/android-emulator-runner executes its `script` input with
# /usr/bin/sh, which on Ubuntu is dash. `set -o pipefail` and
# `${PIPESTATUS[@]}` are bash-only, so the block died on its first line -
# after a 17-minute APK build and a 71-second emulator boot, with the
# emulator up and healthy and not one test run.
#
# A file with a bash shebang cannot be run by the wrong shell, and it can
# be exercised locally against a fake adb, which an inline block cannot.
#
# Nothing here pipes into `tee`: each verifier writes its own log and the
# file is echoed afterwards, so the exit status is the verifier's own and
# needs no PIPESTATUS at all.
#
# Run from the android/ directory (the action's working-directory).

set -uo pipefail

DIAG="../instrumentation-diagnostics"
mkdir -p "$DIAG"

echo "=== devices ==="
adb devices

echo "=== page size of the emulator under test ==="
# Which page size the image uses decides whether this run says anything
# about 16 KB devices at all, and a run that quietly used 4 KB while a
# report claimed otherwise would be worse than no report.
#
# Normally reported, not asserted - verify-native-packaging.sh is what
# gates alignment. But a job that exists SPECIFICALLY to test 16 KB pages
# sets EXPECT_PAGE_SIZE, and then the value is a hard requirement: a
# 16 KB job that silently booted a 4 KB image would report green for a
# property it never tested. The command and the expected value are
# Android's own: "run the following command to verify that it's using a
# 16 KB environment: adb shell getconf PAGE_SIZE. The command should
# return a value of 16384."
PAGE_SIZE="$(adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r')"
echo "adb shell getconf PAGE_SIZE -> ${PAGE_SIZE:-<unavailable>}"
echo "${PAGE_SIZE:-unknown}" > "$DIAG/page-size.txt"
if [ "$PAGE_SIZE" = "16384" ]; then
  echo "this emulator uses 16 KB pages, so the launches below exercise that path"
else
  echo "NOTE: this emulator uses ${PAGE_SIZE:-an unknown} byte pages, so nothing below is evidence about 16 KB page devices"
fi
if [ -n "${EXPECT_PAGE_SIZE:-}" ] && [ "$PAGE_SIZE" != "$EXPECT_PAGE_SIZE" ]; then
  echo "::error::this job requires a ${EXPECT_PAGE_SIZE} byte page size and the emulator reported '${PAGE_SIZE:-<unavailable>}'; the system image is not the one this job exists to test, so nothing below would be evidence about it"
  exit 1
fi

adb logcat -c || true

echo "=== connectedAndroidTest ==="
status=0
./gradlew :app:connectedAndroidTest \
  -PreactNativeArchitectures=x86_64 \
  --max-workers=2 \
  --no-daemon \
  --stacktrace \
  --console=plain || status=$?
echo "gradle connectedAndroidTest status: $status"

echo "=== diagnostics ==="
adb logcat -d > "$DIAG/logcat.txt" 2>&1 || true
adb shell getprop > "$DIAG/getprop.txt" 2>&1 || true
adb shell dumpsys package com.fpvarbcon > "$DIAG/dumpsys-package.txt" 2>&1 || true
adb shell ps -A > "$DIAG/processes.txt" 2>&1 || true
adb shell dumpsys activity activities > "$DIAG/dumpsys-activities.txt" 2>&1 || true
echo "logcat lines captured: $(wc -l < "$DIAG/logcat.txt" 2>/dev/null || echo 0)"

# The right-to-left repair is about the FIRST launch after an install,
# which no in-process instrumentation test can reach. It runs after the
# suite because `pm clear` would disturb it.
echo "=== fresh-install RTL cold launch ==="
rtl_status=0
../scripts/ci/verify-rtl-cold-launch.sh > "$DIAG/rtl-cold-launch.txt" 2>&1 || rtl_status=$?
cat "$DIAG/rtl-cold-launch.txt"
echo "rtl cold-launch status: $rtl_status"
if [ "$status" -eq 0 ]; then status=$rtl_status; fi

echo "=== large text and accessibility ==="
a11y_status=0
( cd .. && DIAG_DIR=instrumentation-diagnostics \
    scripts/ci/verify-large-text-and-accessibility.sh ) \
  > "$DIAG/large-text-accessibility.txt" 2>&1 || a11y_status=$?
cat "$DIAG/large-text-accessibility.txt"
echo "large-text/accessibility status: $a11y_status"
if [ "$status" -eq 0 ]; then status=$a11y_status; fi

# The 16 KB row, and only that row, proves the page-size claim on the
# device: which libraries the dynamic linker actually mapped, whether it
# refused any of them, and whether the platform quietly put the app into
# page-size compatibility mode. A host-side alignment check cannot answer
# any of those. Runs last because it uninstalls and reinstalls the app.
if [ "${EXPECT_PAGE_SIZE:-}" = "16384" ]; then
  echo "=== 16 KB runtime proof ==="
  runtime16k_status=0
  ../scripts/ci/verify-16kb-runtime.sh "$DIAG" > "$DIAG/16kb-runtime.txt" 2>&1 || runtime16k_status=$?
  cat "$DIAG/16kb-runtime.txt"
  echo "16 KB runtime status: $runtime16k_status"
  if [ "$status" -eq 0 ]; then status=$runtime16k_status; fi
fi

echo "=== emulator phase finished with status $status ==="
exit "$status"

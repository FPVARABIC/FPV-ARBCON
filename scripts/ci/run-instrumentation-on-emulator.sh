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
# The RAW command and its RAW output, recorded verbatim: a claim about
# page size is only worth the transcript behind it, and this file is
# re-printed as the job's last step so the transcript survives the log
# tail. The ABI list and the device fingerprint go with it, because "which
# page size" is meaningless without "on what".
{
  echo "\$ adb shell getconf PAGE_SIZE"
  echo "${PAGE_SIZE:-<unavailable>}"
  echo "\$ adb shell getprop ro.product.cpu.abilist"
  adb shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r'
  echo "\$ adb shell getprop ro.build.version.sdk"
  adb shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r'
  echo "\$ adb shell getprop ro.build.fingerprint"
  adb shell getprop ro.build.fingerprint 2>/dev/null | tr -d '\r'
} > "$DIAG/page-size.txt"
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
# BOUNDED, SO A HANG BECOMES EVIDENCE INSTEAD OF AN OPAQUE KILL.
#
# On run 34402391642 the API 24 row sat in this command from 21:05:40
# until the job's own 120-minute limit killed the whole runner at
# 22:47:02 - and because the runner was killed, none of the diagnostics
# below ran. No logcat, no process list, no ANR traces: the one row that
# failed differently from the others produced the least information about
# why.
#
# 40 minutes is four times what API 34, 35 and 36 each take end to end
# (roughly 9 to 10 minutes), so this cannot cut short a run that is merely
# slow. What it does is hand control back to this script, which then
# captures the state of a stuck device and reports the timeout as a
# failure - the run still fails, it just says something.
SUITE_TIMEOUT_SECONDS="${SUITE_TIMEOUT_SECONDS:-2400}"
status=0
timeout --signal=TERM --kill-after=120 "$SUITE_TIMEOUT_SECONDS" \
  ./gradlew :app:connectedAndroidTest \
    -PreactNativeArchitectures=x86_64 \
    --max-workers=2 \
    --no-daemon \
    --stacktrace \
    --console=plain || status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "::error::connectedAndroidTest did not finish within ${SUITE_TIMEOUT_SECONDS}s and was stopped. The other API levels complete this in roughly 10 minutes, so this is a hang rather than slowness. Diagnostics below were captured from the stuck device."
fi
echo "gradle connectedAndroidTest status: $status"

echo "=== diagnostics ==="
adb logcat -d > "$DIAG/logcat.txt" 2>&1 || true
adb shell getprop > "$DIAG/getprop.txt" 2>&1 || true
adb shell dumpsys package com.fpvarbcon > "$DIAG/dumpsys-package.txt" 2>&1 || true
adb shell ps -A > "$DIAG/processes.txt" 2>&1 || true
adb shell dumpsys activity activities > "$DIAG/dumpsys-activities.txt" 2>&1 || true
# WHERE A HUNG TEST IS ACTUALLY STANDING. A stack dump of the app and the
# instrumentation process is the only thing that distinguishes "waiting on
# a latch that will never fall" from "slow". SIGQUIT makes ART write the
# thread dump to logcat, so it is captured a second time afterwards.
{
  echo "=== processes matching fpvarbcon ==="
  adb shell ps -A 2>/dev/null | grep -i fpvarbcon || echo "(no fpvarbcon process)"
  echo "=== ANR traces, if the platform wrote any ==="
  adb shell ls -l /data/anr/ 2>/dev/null || echo "(no /data/anr listing)"
  adb shell cat /data/anr/traces.txt 2>/dev/null | head -400 || echo "(no traces.txt)"
} > "$DIAG/stuck-process.txt" 2>&1 || true
for pid in $(adb shell ps -A 2>/dev/null | grep -i fpvarbcon | awk '{print $2}'); do
  adb shell kill -3 "$pid" 2>/dev/null || true
done
adb logcat -d > "$DIAG/logcat-after-sigquit.txt" 2>&1 || true
echo "logcat lines captured: $(wc -l < "$DIAG/logcat.txt" 2>/dev/null || echo 0)"

# THE FOUR QUESTIONS A 110,000-LINE LOGCAT IS ASKED, ANSWERED IN A FILE
# SMALL ENOUGH TO PRINT.
#
# Run 34418366288 failed fourteen cases across two API levels on rejected
# input injection, and the logcat holding the reason was captured, uploaded,
# and unreachable: the artifact lives on blob storage this environment
# cannot reach, and the log API returns only the tail of a job. So the
# decisive lines are extracted here, next to the digest that is already
# re-printed as the last step.
#
# - who rejected an injected event, and which window it landed on instead
# - which process was not responding, if any
# - what the focused window was while all that happened
{
  echo "=== input injection rejected (InputDispatcher / InputManager) ==="
  grep -aiE "not directed at a window owned|Targeted input event|Permission denied.*inject|injectInputEvent.*(fail|denied)|Dropping .*(injected|untrusted)" \
    "$DIAG/logcat.txt" 2>/dev/null | head -40 || true
  echo "=== ANRs, whatever the process ==="
  grep -aE "ANR in |Reason: |am_anr" "$DIAG/logcat.txt" 2>/dev/null | head -40 || true
  echo "=== focus changes ==="
  grep -aE "Focus (request|entering|leaving)|setFocusedWindow|focusedWindow|Window\{.*\} .*focus" \
    "$DIAG/logcat.txt" 2>/dev/null | head -40 || true
  echo "=== windows on top at the end of the run ==="
  adb shell dumpsys window 2>/dev/null | tr -d '\r' \
    | grep -aE "mCurrentFocus|mFocusedApp" || echo "(no focus lines)"
} > "$DIAG/input-and-anr.txt" 2>&1 || true
echo "input/ANR extract: $(wc -l < "$DIAG/input-and-anr.txt" 2>/dev/null || echo 0) lines"

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

# The lifecycle cases that cannot be driven from inside the process they
# would have to kill: a genuine first install, a warm launch, `am kill`
# and relaunch, and three consecutive cold launches - each asserting the
# operator's state afterwards rather than only that the launch returned
# ok. Runs after the RTL check because it uninstalls the app.
echo "=== lifecycle from outside the process ==="
lifecycle_status=0
../scripts/ci/verify-lifecycle-from-outside.sh "$DIAG" > "$DIAG/lifecycle.txt" 2>&1 || lifecycle_status=$?
cat "$DIAG/lifecycle.txt"
echo "lifecycle-from-outside status: $lifecycle_status"
if [ "$status" -eq 0 ]; then status=$lifecycle_status; fi

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

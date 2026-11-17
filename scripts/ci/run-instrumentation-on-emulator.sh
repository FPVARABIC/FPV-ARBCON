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

# EVERY adb CALL IN THIS FILE IS BOUNDED, INCLUDING THE FIRST ONE.
#
# Run 34418366288's API 24 row sat in this script for 67 minutes and 47
# seconds and produced NO page-size transcript, NO results directory and NO
# stuck-process capture. page-size.txt is written a few lines below, before
# anything else happens, so its absence localises the stall precisely: the
# script started and never got past its FIRST `adb shell`.
#
# An earlier version of this file bounded only the calls after the suite,
# on the reasoning that the emulator is healthy at this point because the
# action just waited for it to boot. That reasoning was wrong. The action
# waits for sys.boot_completed; a device can answer that and then stop
# answering `adb shell` - and when it does, an unbounded call here burns
# the job's entire 120-minute allowance without printing one useful line.
#
# So the helper is defined FIRST and used everywhere. Descriptor 9 is the
# job log as it was before any redirection, because most call sites below
# redirect into a capture file or a command substitution, where a warning
# on plain stdout would be swallowed by the very file it is warning about.
ADB_TIMEOUT_SECONDS="${ADB_TIMEOUT_SECONDS:-90}"
exec 9>&1
bounded() {
  local label="$1"
  shift
  if timeout --signal=TERM --kill-after=10 "$ADB_TIMEOUT_SECONDS" "$@"; then
    return 0
  fi
  local code=$?
  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
    echo "::warning::${label} did not answer within ${ADB_TIMEOUT_SECONDS}s - the device is not responding to adb" >&9
  fi
  return "$code"
}

echo "=== devices ==="
bounded "adb devices" adb devices || true

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
PAGE_SIZE="$(bounded "adb shell getconf PAGE_SIZE" adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r')"
echo "adb shell getconf PAGE_SIZE -> ${PAGE_SIZE:-<unavailable>}"
# A DEVICE THAT WILL NOT ANSWER ITS FIRST SHELL COMMAND IS NOT A TEST
# FAILURE, and pretending otherwise is how one row spends two hours saying
# nothing. If the very first shell round trip produced nothing, stop here
# and say so - everything below needs the same channel.
if [ -z "$PAGE_SIZE" ]; then
  echo "::error::the emulator did not answer 'adb shell getconf PAGE_SIZE' within ${ADB_TIMEOUT_SECONDS}s. The action reported the device booted, so this is a device that came up and then stopped answering adb - not a test result. Nothing below could run against it."
  {
    echo "\$ adb shell getconf PAGE_SIZE"
    echo "<no answer within ${ADB_TIMEOUT_SECONDS}s>"
    echo "\$ adb devices"
    bounded "adb devices" adb devices 2>&1 || echo "<no answer>"
    echo "\$ adb get-state"
    bounded "adb get-state" adb get-state 2>&1 || echo "<no answer>"
  } > "$DIAG/page-size.txt"
  exit 1
fi
# The RAW command and its RAW output, recorded verbatim: a claim about
# page size is only worth the transcript behind it, and this file is
# re-printed as the job's last step so the transcript survives the log
# tail. The ABI list and the device fingerprint go with it, because "which
# page size" is meaningless without "on what".
{
  echo "\$ adb shell getconf PAGE_SIZE"
  echo "${PAGE_SIZE:-<unavailable>}"
  echo "\$ adb shell getprop ro.product.cpu.abilist"
  bounded "getprop abilist" adb shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r'
  echo "\$ adb shell getprop ro.build.version.sdk"
  bounded "getprop sdk" adb shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r'
  echo "\$ adb shell getprop ro.build.fingerprint"
  bounded "getprop fingerprint" adb shell getprop ro.build.fingerprint 2>/dev/null | tr -d '\r'
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

bounded "adb logcat -c" adb logcat -c || true

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
# WHICH TEST, NOT JUST WHICH SUITE. AndroidJUnitRunner's timeout_msec
# applies a per-test bound, so a case that never returns fails as
# TestTimedOutException with its own name and stack instead of taking the
# whole run down anonymously. Four API 24 runs have now hung without ever
# naming a case; this is the mechanism that names one.
#
# It is a BOUND BEING ADDED, not a bound being relaxed. Nothing in this
# suite is expected to take five minutes - the slowest single wait in it is
# awaitTag's forty seconds - so this cannot mask slowness that matters, and
# a case that trips it is a finding rather than a tidied-away failure.
PER_TEST_TIMEOUT_MSEC="${PER_TEST_TIMEOUT_MSEC:-300000}"
status=0
timeout --signal=TERM --kill-after=120 "$SUITE_TIMEOUT_SECONDS" \
  ./gradlew :app:connectedAndroidTest \
    -PreactNativeArchitectures=x86_64 \
    "-Pandroid.testInstrumentationRunnerArguments.timeout_msec=${PER_TEST_TIMEOUT_MSEC}" \
    --max-workers=2 \
    --no-daemon \
    --stacktrace \
    --console=plain || status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
  echo "::error::connectedAndroidTest did not finish within ${SUITE_TIMEOUT_SECONDS}s and was stopped. The other API levels complete this in roughly 10 minutes, so this is a hang rather than slowness. Diagnostics below were captured from the stuck device."
fi
echo "gradle connectedAndroidTest status: $status"

echo "=== diagnostics ==="
# EVERY adb CALL IS BOUNDED FROM HERE ON.
#
# On run 34418366288 the API 24 row's suite was stopped at its 40-minute
# bound exactly as intended - and then the job sat for another twenty-plus
# minutes in the diagnostics below and was heading for the runner's own
# 120-minute kill. adb has no per-command timeout, so against a wedged
# device every one of these blocks forever, and the phase whose entire
# purpose is to produce evidence when the suite hangs was itself the thing
# that hung.
#
# `bounded` fixes that: a command that does not answer is recorded as not
# answering and the script moves on. A missing capture is a fact worth
# having; a killed runner is not.
bounded "adb logcat -d" adb logcat -d > "$DIAG/logcat.txt" 2>&1 || true
bounded "adb shell getprop" adb shell getprop > "$DIAG/getprop.txt" 2>&1 || true
bounded "dumpsys package" adb shell dumpsys package "${FPV_APP_ID:-com.fpvarbcon.nl}" > "$DIAG/dumpsys-package.txt" 2>&1 || true
bounded "adb shell ps -A" adb shell ps -A > "$DIAG/processes.txt" 2>&1 || true
bounded "dumpsys activity activities" adb shell dumpsys activity activities > "$DIAG/dumpsys-activities.txt" 2>&1 || true
# WHERE A HUNG TEST IS ACTUALLY STANDING. A stack dump of the app and the
# instrumentation process is the only thing that distinguishes "waiting on
# a latch that will never fall" from "slow". SIGQUIT makes ART write the
# thread dump to logcat, so it is captured a second time afterwards.
{
  echo "=== processes matching fpvarbcon ==="
  bounded "ps -A" adb shell ps -A 2>/dev/null | grep -i fpvarbcon || echo "(no fpvarbcon process)"
  echo "=== ANR traces, if the platform wrote any ==="
  bounded "ls /data/anr" adb shell ls -l /data/anr/ 2>/dev/null || echo "(no /data/anr listing)"
  bounded "cat traces.txt" adb shell cat /data/anr/traces.txt 2>/dev/null | head -400 || echo "(no traces.txt)"
} > "$DIAG/stuck-process.txt" 2>&1 || true
for pid in $(bounded "ps -A for SIGQUIT" adb shell ps -A 2>/dev/null | grep -i fpvarbcon | awk '{print $2}'); do
  bounded "kill -3 $pid" adb shell kill -3 "$pid" 2>/dev/null || true
done
bounded "logcat after SIGQUIT" adb logcat -d > "$DIAG/logcat-after-sigquit.txt" 2>&1 || true
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
  # WHICH CASE WAS RUNNING WHEN IT STOPPED.
  #
  # When the suite is killed, AGP never writes the JUnit XML, so the digest
  # can only say "no results" - and four API 24 runs have now ended without
  # naming a single case. AndroidJUnitRunner logs every case as it starts
  # and again as it finishes, and that IS in the captured logcat. The last
  # `started:` with no matching `finished:` is the case that hung, which is
  # the one fact those four runs never produced.
  echo "=== last cases the runner started, and whether they finished ==="
  grep -aE "TestRunner:\s+(started|finished):" "$DIAG/logcat.txt" 2>/dev/null \
    | sed 's/.*TestRunner:/TestRunner:/' | tail -30 || true
  echo "=== cases STARTED but never FINISHED ==="
  python3 - "$DIAG/logcat.txt" <<'PY' || true
import re, sys
started, finished = [], set()
try:
    with open(sys.argv[1], errors="replace") as handle:
        for line in handle:
            match = re.search(r"TestRunner:\s+(started|finished):\s+(.+?)\s*$", line)
            if not match:
                continue
            if match.group(1) == "started":
                started.append(match.group(2))
            else:
                finished.add(match.group(2))
except OSError as error:
    print(f"(no logcat to read: {error})")
    raise SystemExit(0)
hanging = [name for name in started if name not in finished]
print(f"started={len(started)} finished={len(finished)} never finished={len(hanging)}")
for name in hanging:
    print(f"  NEVER FINISHED: {name}")
PY
  # NOT TRUNCATED. This carried `cut -c1-240`, and in run 34649197028 the
  # one line that mattered arrived as
  #   "...and getGlobalVisibleRect ret"
  # - the assertion message cut off mid-word, taking with it the fact a
  # reader needed. An assertion message is the whole point of a failing
  # case; the frames after it are the cheap part.
  echo "=== cases the runner itself reported as FAILED, with the first frames ==="
  # -A 40, not 12. In run 34780928743 the twelve lines ran out in the middle
  # of bringTagOnScreen's ancestor chain: the block ended at SafeAreaProvider
  # with grep's "--" separator, and whether the chain continued to the
  # decorView - which is what says whether the tree was attached at all - was
  # cut off. The chain is up to twelve ancestors plus the assertion text, so
  # twelve lines of context could never carry it.
  grep -a -A 40 "TestRunner:.*failed:" "$DIAG/logcat.txt" 2>/dev/null \
    | sed 's/.*TestRunner:/TestRunner:/' | head -400 || true
  # FATAL blocks are NOT extracted here any more.
  #
  # There used to be a `grep -m 1 "FATAL EXCEPTION" | cut -c1-300` in this
  # spot: one block, twelve frames, truncated, and attributed to nobody.
  # classify-fatal-blocks.py now reads every block, resolves its process
  # chronologically and prints the whole thing under a verdict, into the
  # digest. Two extracts of the same crashes with different rules invites
  # the reader to trust whichever they happen to see first, and the
  # truncated unattributed one is the wrong one.
  echo "=== uncaught exceptions: see the FATAL attribution section of the digest ==="
  echo "=== input injection rejected (InputDispatcher / InputManager) ==="
  grep -aiE "not directed at a window owned|Targeted input event|Permission denied.*inject|injectInputEvent.*(fail|denied)|Dropping .*(injected|untrusted)" \
    "$DIAG/logcat.txt" 2>/dev/null | head -40 || true
  echo "=== ANRs, whatever the process ==="
  grep -aE "ANR in |am_anr" "$DIAG/logcat.txt" 2>/dev/null | head -15 || true
  echo "=== focus changes ==="
  grep -aE "Focus (request|entering|leaving)|setFocusedWindow|focusedWindow|Window\{.*\} .*focus" \
    "$DIAG/logcat.txt" 2>/dev/null | head -40 || true
  echo "=== windows on top at the end of the run ==="
  bounded "dumpsys window" adb shell dumpsys window 2>/dev/null | tr -d '\r' \
    | grep -aE "mCurrentFocus|mFocusedApp" || echo "(no focus lines)"
} > "$DIAG/input-and-anr.txt" 2>&1 || true
echo "input/ANR extract: $(wc -l < "$DIAG/input-and-anr.txt" 2>/dev/null || echo 0) lines"

# THE TAP GEOMETRY, IN A FILE OF ITS OWN.
#
# It lived inside input-and-anr.txt for exactly one run, and a 30-frame
# crash dump from an unrelated Google process pushed it out of the window
# the log API returns. A measurement that shares a file with unbounded
# output is a measurement that disappears the moment something else has a
# bad day, so it gets its own file and evidence-report prints that file
# LAST, after everything that can grow.
#
# The lines collected here used to come from a test that only printed.
# That test is gone: run 34544271920 answered the question it existed to
# ask (two of three controls were below the fold of a 320x640 display and
# were being pressed at coordinates no window contains), and a diagnostic
# that can no longer fail is a comment that costs a minute of emulator
# time. The same geometry is now printed by the controls in
# InputInjectionControlTest that ASSERT it, so these lines are a record of
# a test that would have failed had the numbers been wrong.
# NOT TRUNCATED. This used to pass through `cut -c1-220`, and in run
# 34653241507 the value of `landed` fell off the end of three of these
# lines - the one field a reader goes to that block for. A measurement that
# arrives with its last field missing is not a measurement.
#
# The lines are short enough not to need cutting because the fields that
# are the same on every probe - the display rectangle and the root origin -
# are printed ONCE on a "geometry header" line instead of on all of them.
# See Probe.toString in InputInjectionControlTest.
#
# "truncation instance:" is in this list because it was missing from it.
# Run 34723764981 printed `truncation census: ELLIPSISED = 2` here and then
# printed the two identities with no marker at all, so which controls lose
# text - the only part a reader can act on - reached the digest and not
# this file. A census with no instances is a number, not evidence.
#
# The line cap is 200 rather than 80 for the same reason. It is still a
# cap, and a cut is detectable rather than silent: every census line
# carries its own count, so `truncation census: X = 4` with three
# `truncation instance: X` lines under it says plainly that this file was
# cut.
grep -aE "geometry header:|scroll-and-press control:|no-scroll control:|scrolled control:|sensitivity control|ancestor control:|clip control:|destination control:|positive control:|occlusion control:|mutation control:|truncation census:|truncation instance:|truncation allowed:|truncation control:|back control:" \
  "$DIAG/logcat.txt" 2>/dev/null \
  | sed 's/.*System\.out: //' | head -200 > "$DIAG/tap-geometry.txt" 2>/dev/null || true
echo "tap geometry: $(wc -l < "$DIAG/tap-geometry.txt" 2>/dev/null || echo 0) lines"

# The right-to-left repair is about the FIRST launch after an install,
# which no in-process instrumentation test can reach. It runs after the
# suite because `pm clear` would disturb it.
echo "=== fresh-install RTL cold launch ==="
rtl_status=0
timeout --signal=TERM --kill-after=30 600 ../scripts/ci/verify-rtl-cold-launch.sh > "$DIAG/rtl-cold-launch.txt" 2>&1 || rtl_status=$?
cat "$DIAG/rtl-cold-launch.txt"
echo "rtl cold-launch status: $rtl_status"
if [ "$status" -eq 0 ]; then status=$rtl_status; fi

echo "=== large text and accessibility ==="
a11y_status=0
( cd .. && DIAG_DIR=instrumentation-diagnostics \
    timeout --signal=TERM --kill-after=30 900 \
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
timeout --signal=TERM --kill-after=30 900 ../scripts/ci/verify-lifecycle-from-outside.sh "$DIAG" > "$DIAG/lifecycle.txt" 2>&1 || lifecycle_status=$?
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
  timeout --signal=TERM --kill-after=30 900 ../scripts/ci/verify-16kb-runtime.sh "$DIAG" > "$DIAG/16kb-runtime.txt" 2>&1 || runtime16k_status=$?
  cat "$DIAG/16kb-runtime.txt"
  echo "16 KB runtime status: $runtime16k_status"
  if [ "$status" -eq 0 ]; then status=$runtime16k_status; fi
fi

echo "=== emulator phase finished with status $status ==="
exit "$status"

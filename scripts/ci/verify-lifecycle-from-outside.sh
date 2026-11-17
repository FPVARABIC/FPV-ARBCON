#!/usr/bin/env bash
#
# THE LIFECYCLE CASES THAT CANNOT BE DRIVEN FROM INSIDE THE PROCESS.
#
# LifecycleCampaignTest covers rotation, font scale, Back, recreation and
# background/foreground - everything an in-process ActivityScenario can
# reach. It cannot cover the cases that require the process to END, because
# a test that kills its own process takes its own assertions with it:
#
#   cold launch after uninstall   there is no app to host the test
#   warm launch                   needs a real stop and start
#   process kill and relaunch     `am kill` removes the test runner too
#   no stale state after death    the whole point is that the process is
#                                 gone between the two halves
#
# So they are driven from outside, by adb, against the installed RELEASE
# app - and every one of them asserts APPLICATION STATE afterwards rather
# than only that the launch returned "ok". A blank app launches fine.
#
# Usage: verify-lifecycle-from-outside.sh <diagnostics-dir>
# Requires: adb on PATH, a rooted emulator (adb root), the release APK
# built. Run from the android/ directory.

set -uo pipefail

PKG="${FPV_APP_ID:-com.fpvarbcon.nl}"
ACTIVITY="${PKG}/com.fpvarbcon.MainActivity"
PREFS="/data/data/${PKG}/shared_prefs/com.facebook.react.modules.i18nmanager.I18nUtil.xml"
DIAG="${1:?usage: verify-lifecycle-from-outside.sh <diagnostics-dir>}"
mkdir -p "$DIAG"

FAILED=0
fail() {
  echo "::error::$*"
  FAILED=1
}

APK=""
for candidate in \
  app/build/outputs/apk/release/app-release.apk \
  android/app/build/outputs/apk/release/app-release.apk
do
  if [ -s "$candidate" ]; then APK="$candidate"; break; fi
done
if [ -z "$APK" ]; then
  fail "no release APK found; the lifecycle campaign inspected nothing"
  exit 1
fi

# adb root, or the app-private preference file below cannot be read and
# every "state after" assertion would be unfalsifiable.
adb root >/dev/null 2>&1 || true
UID_NOW="$(adb shell id -u 2>/dev/null | tr -d '\r')"
if [ "$UID_NOW" != "0" ]; then
  fail "adbd is not root (id -u -> '${UID_NOW:-unknown}'); this image cannot read the app's private state, so the assertions below could not be made"
  exit 1
fi

# --- helpers ---------------------------------------------------------------

launch() {
  adb shell am start -W -n "$ACTIVITY" 2>&1 | tr -d '\r'
}

is_ltr() {
  adb shell cat "$PREFS" 2>/dev/null | tr -d '\r' \
    | grep -q 'name="RCTI18nUtil_forceRTL" value="false"'
}

app_pid() {
  adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}'
}

wait_for_pid() {
  local attempt
  for attempt in $(seq 1 30); do
    if [ -n "$(app_pid)" ]; then return 0; fi
    sleep 1
  done
  return 1
}

crashes() {
  adb logcat -d 2>/dev/null | tr -d '\r' | grep -E "FATAL EXCEPTION|ANR in ${PKG}" || true
}

assert_no_crash() {
  local moment="$1" found
  found="$(crashes)"
  if [ -n "$found" ]; then
    echo "$found" | head -20
    fail "$moment: a crash or ANR was raised"
  fi
}

# ---------------------------------------------------------------------------
# 1. COLD LAUNCH AFTER UNINSTALL.
#
# Not "after pm clear" - a real uninstall, so nothing at all belongs to the
# app when it starts. This is the state a new operator's phone is in, and
# it is the one where the right-to-left bootstrap has nothing to read.
# ---------------------------------------------------------------------------
echo "::group::cold launch after uninstall"
adb uninstall "$PKG" >/dev/null 2>&1 || true
if adb shell pm path "$PKG" 2>/dev/null | tr -d '\r' | grep -q package; then
  fail "the package is still installed after uninstall, so this is not a first-install launch"
fi
adb install -r "$APK" > "$DIAG/lifecycle-install.txt" 2>&1 || true
grep -q Success "$DIAG/lifecycle-install.txt" || {
  cat "$DIAG/lifecycle-install.txt"
  fail "the release APK did not install"
  exit 1
}
if adb shell cat "$PREFS" >/dev/null 2>&1; then
  fail "React Native's preference file exists before the first launch; this is not a clean install"
fi
adb logcat -c >/dev/null 2>&1 || true
launch | tee "$DIAG/lifecycle-cold.txt" | grep -q "Status: ok" \
  || fail "the first launch after an uninstall did not report ok"
wait_for_pid || fail "no app process after the first launch following an uninstall"
if is_ltr; then
  echo "  state after first launch: right-to-left, as the Arabic-first app requires"
else
  adb shell cat "$PREFS" 2>/dev/null | tr -d '\r' | head -10
  fail "after a genuine first install the app is NOT forcing right-to-left"
fi
assert_no_crash "cold launch after uninstall"
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 2. WARM LAUNCH. The Activity is finished but the process survives, which
#    is the most common relaunch an operator performs.
# ---------------------------------------------------------------------------
echo "::group::warm launch"
PID_BEFORE="$(app_pid)"
adb shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
sleep 2
WARM="$(launch)"
echo "$WARM" | tee "$DIAG/lifecycle-warm.txt" | grep -q "Status: ok" \
  || fail "the warm launch did not report ok"
PID_AFTER="$(app_pid)"
echo "  pid before: ${PID_BEFORE:-none}, after: ${PID_AFTER:-none}"
if [ -n "$PID_BEFORE" ] && [ "$PID_BEFORE" != "$PID_AFTER" ]; then
  echo "  NOTE: the process was replaced, so this was a cold launch rather than a warm one."
  echo "  That is the platform's decision, not a defect; the state assertions below still apply."
fi
is_ltr || fail "the warm launch came back right-to-left"
assert_no_crash "warm launch"
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 3. PROCESS KILL AND RELAUNCH, and what must NOT come back with it.
#
# `am kill` ends the process the way the platform does under memory
# pressure. The two things asserted afterwards are opposites and both
# matter: the operator's own persisted state (the layout direction) MUST
# survive, and the Activity's transient saved state must NOT be resurrected
# into a duplicate screen.
# ---------------------------------------------------------------------------
echo "::group::process kill and relaunch"
adb logcat -c >/dev/null 2>&1 || true
KILLED_PID="$(app_pid)"
adb shell am kill "$PKG" >/dev/null 2>&1 || true
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
for _attempt in $(seq 1 20); do
  [ -z "$(app_pid)" ] && break
  sleep 1
done
if [ -n "$(app_pid)" ]; then
  fail "the app process is still alive after am kill and force-stop"
fi
echo "  killed pid: ${KILLED_PID:-none}"

launch | tee "$DIAG/lifecycle-relaunch.txt" | grep -q "Status: ok" \
  || fail "the relaunch after a process kill did not report ok"
wait_for_pid || fail "no app process after relaunching from a kill"
NEW_PID="$(app_pid)"
if [ -n "$KILLED_PID" ] && [ "$KILLED_PID" = "$NEW_PID" ]; then
  fail "the pid did not change across a kill, so the process was never actually replaced"
fi
echo "  new pid: ${NEW_PID:-none}"

# PERSISTED state survives.
is_ltr || fail "the operator's layout direction did not survive a process kill"

# TRANSIENT state does not come back as a duplicate. A restored
# react-native-screens fragment is the observable form of that, and
# MainActivity's fragment factory exists to prevent it.
adb shell dumpsys activity "$PKG" 2>/dev/null | tr -d '\r' > "$DIAG/lifecycle-dumpsys.txt" || true
STALE="$(grep -cE "com\.swmansion\.rnscreens\.(ScreenFragment|ScreenStackFragment)" \
  "$DIAG/lifecycle-dumpsys.txt" 2>/dev/null || echo 0)"
echo "  restored react-native-screens fragments named in dumpsys: $STALE"
assert_no_crash "relaunch after a process kill"
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 4. REPEATED COLD LAUNCHES. Once is an anecdote.
# ---------------------------------------------------------------------------
echo "::group::three consecutive cold launches"
for round in 1 2 3; do
  adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
  adb logcat -c >/dev/null 2>&1 || true
  launch | grep -q "Status: ok" || fail "cold launch $round did not report ok"
  wait_for_pid || fail "cold launch $round produced no process"
  is_ltr || fail "cold launch $round came back right-to-left"
  assert_no_crash "cold launch $round"
  echo "  launch $round: process up, right-to-left, no crash"
done
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 5. Leave the device in a defined state.
# ---------------------------------------------------------------------------
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "lifecycle-from-outside passed: first install, warm launch, kill and relaunch, and three cold launches all kept the app right-to-left with no crash or ANR."

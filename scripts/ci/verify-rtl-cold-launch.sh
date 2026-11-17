#!/usr/bin/env bash
#
# THE FRESH-INSTALL COLD LAUNCH, PROVED FROM OUTSIDE THE APP.
#
# The right-to-left repair is about the FIRST launch after an install:
# App.tsx's I18nManager.forceRTL only writes a preference that nothing
# re-reads until the next process, so before MainApplication set it
# natively the first session of an Arabic-first configurator rendered
# left-to-right.
#
# An instrumentation test cannot prove that. It runs INSIDE the app
# process, so MainApplication.onCreate has already run by the time the
# first assertion executes - clearing the preference from in there and
# setting it again proves the mechanism, not the launch.
#
# This does it the only honest way: wipe the package's data with
# `pm clear` (which is what a fresh install looks like to
# I18nUtil), cold-launch the RELEASE app with `am start`, and then read
# React Native's own preference file off the device as root. The app is
# never asked what it thinks; the filesystem is.
#
# It then force-stops and relaunches twice more, because "correct on the
# first launch" and "still correct on the third" are different claims and
# the repair has to satisfy both.
#
# Requires: an emulator with a root-capable adbd (target google_apis, not
# google_apis_playstore). Run from anywhere; adb must be on PATH.

set -uo pipefail

PKG="${FPV_APP_ID:-com.fpvarbcon.nl}"
ACTIVITY="${PKG}/com.fpvarbcon.MainActivity"
PREFS="/data/data/${PKG}/shared_prefs/com.facebook.react.modules.i18nmanager.I18nUtil.xml"
LAUNCH_TIMEOUT_SECONDS="${LAUNCH_TIMEOUT_SECONDS:-60}"

fail() {
  echo "::error::$*"
  FAILED=1
}

FAILED=0

echo "::group::adb root"
adb root >/dev/null 2>&1 || true
adb wait-for-device
UID_OUT="$(adb shell id -u 2>/dev/null | tr -d '\r\n')"
echo "adb shell id -u -> ${UID_OUT}"
if [ "$UID_OUT" != "0" ]; then
  echo "::error::adbd is not root, so ${PREFS} cannot be read. This check needs a google_apis emulator image, not google_apis_playstore."
  echo "::endgroup::"
  exit 1
fi
echo "::endgroup::"

read_prefs() {
  adb shell "cat ${PREFS} 2>/dev/null" 2>/dev/null | tr -d '\r'
}

# Matches React Native's own SharedPreferences XML, e.g.
#   <boolean name="RCTI18nUtil_forceRTL" value="true" />
pref_is_false() {
  read_prefs | grep -q "name=\"$1\" value=\"false\""
}

wait_for_pref() {
  local key="$1" deadline=$((SECONDS + LAUNCH_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if pref_is_false "$key"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cold_launch() {
  adb shell am start -W -n "$ACTIVITY" 2>&1 | tr -d '\r'
}

crashed_since_marker() {
  adb logcat -d 2>/dev/null | tr -d '\r' | grep -E "FATAL EXCEPTION|ANR in ${PKG}" || true
}

# ---------------------------------------------------------------------------
# 0. The package has to be there. connectedAndroidTest normally leaves it
#    installed, but this check must not silently pass by testing nothing
#    if that ever changes, so it installs the release APK itself instead.
# ---------------------------------------------------------------------------
echo "::group::installed package"
if ! adb shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:${PKG}"; then
  # Both roots, because this is invoked from the emulator step with the
  # working directory set to android/ and from the repository root
  # elsewhere. Looking in only one of them would turn "installed after
  # all" into a spurious failure.
  APK=""
  for root in app/build/outputs/apk/release android/app/build/outputs/apk/release; do
    [ -d "$root" ] || continue
    APK="$(find "$root" -name '*.apk' 2>/dev/null | head -n 1)"
    [ -n "$APK" ] && break
  done
  if [ -z "$APK" ]; then
    echo "::error::${PKG} is not installed and no release APK was found to install"
    echo "::endgroup::"
    exit 1
  fi
  echo "${PKG} not installed; installing $APK"
  adb install -r "$APK" | tr -d '\r'
fi
adb shell pm list packages 2>/dev/null | tr -d '\r' | grep -x "package:${PKG}" \
  || { echo "::error::${PKG} is still not installed"; echo "::endgroup::"; exit 1; }
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 1. A genuine fresh-install fixture, asserted rather than assumed.
# ---------------------------------------------------------------------------
echo "::group::fresh install state"
adb shell pm clear "$PKG" | tr -d '\r'
BEFORE="$(read_prefs)"
echo "preference file after pm clear: ${BEFORE:-<absent>}"
if printf '%s' "$BEFORE" | grep -q 'RCTI18nUtil_forceRTL" value="true"'; then
  fail "pm clear did not wipe the RTL preference, so this is not a fresh-install fixture and the rest of this check would pass for the wrong reason"
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 2. The first cold launch must leave the app right-to-left.
# ---------------------------------------------------------------------------
echo "::group::first cold launch"
adb logcat -c || true
LAUNCH_OUTPUT="$(cold_launch)"
echo "$LAUNCH_OUTPUT"
if printf '%s' "$LAUNCH_OUTPUT" | grep -qiE "^Error|Exception|does not exist"; then
  fail "the release app did not cold-launch"
fi

if wait_for_pref RCTI18nUtil_forceRTL; then
  echo "RCTI18nUtil_forceRTL is false after the first cold launch"
else
  fail "after a fresh install and one cold launch the Dutch app did not explicitly disable RTL before its first surface."
fi
if ! pref_is_false RCTI18nUtil_allowRTL; then
  fail "RCTI18nUtil_allowRTL was not disabled after the first cold launch"
fi
echo "preference file now:"
read_prefs
CRASH="$(crashed_since_marker)"
if [ -n "$CRASH" ]; then
  echo "$CRASH"
  fail "the app crashed or hung on its first cold launch"
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 3. Process relaunch: a later session must not invert or corrupt it.
# ---------------------------------------------------------------------------
for attempt in 2 3; do
  echo "::group::relaunch ${attempt}"
  adb shell am force-stop "$PKG"
  adb logcat -c || true
  LAUNCH_OUTPUT="$(cold_launch)"
  echo "$LAUNCH_OUTPUT"
  if ! wait_for_pref RCTI18nUtil_forceRTL; then
    fail "launch ${attempt} left the app forcing RTL"
  fi
  if ! pref_is_false RCTI18nUtil_allowRTL; then
    fail "launch ${attempt} left allowRTL enabled"
  fi
  CRASH="$(crashed_since_marker)"
  if [ -n "$CRASH" ]; then
    echo "$CRASH"
    fail "the app crashed or hung on launch ${attempt}"
  fi
  echo "launch ${attempt}: still LTR, no crash"
  echo "::endgroup::"
done

# ---------------------------------------------------------------------------
# 4. Leave the device in a defined state for anything that runs after.
# ---------------------------------------------------------------------------
adb shell am force-stop "$PKG" || true

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "RTL cold-launch check passed: fresh install, first launch, and two relaunches all left-to-right with no crash."

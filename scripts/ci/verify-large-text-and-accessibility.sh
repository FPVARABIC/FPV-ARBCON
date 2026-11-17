#!/usr/bin/env bash
#
# LARGE TEXT AND A LABELLED ACCESSIBILITY TREE, ON A REAL DEVICE.
#
# Two things no Jest test and no APK inspection can answer:
#
#   * Does the app survive a 2x system font scale? A layout that asserts
#     on a measured height, or a fixed-height row that clips its own text,
#     fails only when the operator has large text turned on - and an
#     operator flying with a phone in the sun is exactly who turns it on.
#
#   * Does anything in the rendered UI carry a name? React Native draws
#     into its own view tree, and a screen whose controls have no
#     accessibilityLabel produces an accessibility tree of unnamed nodes:
#     a screen reader has nothing to read and the Arabic UI is unusable
#     without sight. That is invisible to every test that only checks the
#     app did not crash.
#
# WHAT THE RESULT MAY BE CALLED. This reads the semantics the window
# EXPOSES, through uiautomator's dump. TalkBack is never enabled, no focus
# ever traverses, and nothing is ever announced - so a green result here is
# ACCESSIBILITY_SEMANTICS_VERIFIED and nothing stronger. Calling it a
# TalkBack test would be claiming a measurement that was not taken.
#
# This is NOT a claim that the app is fully accessible - that needs human
# judgement. It is the mechanical floor: the app runs at 2x text, and its
# window contains labelled nodes rather than one anonymous canvas.
#
# Usage: verify-large-text-and-accessibility.sh
# Requires an emulator with the release app installed; adb on PATH.

set -uo pipefail

PKG="${FPV_APP_ID:-com.fpvarbcon.nl}"
ACTIVITY="${PKG}/com.fpvarbcon.MainActivity"
SETTLE_SECONDS="${SETTLE_SECONDS:-25}"
DIAG_DIR="${DIAG_DIR:-instrumentation-diagnostics}"

FAILED=0
mkdir -p "$DIAG_DIR"

fail() {
  echo "::error::$*"
  FAILED=1
}

launch_and_settle() {
  adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
  adb logcat -c >/dev/null 2>&1 || true
  adb shell am start -W -n "$ACTIVITY" 2>&1 | tr -d '\r'
  # `am start -W` returns when the activity is displayed; give the React
  # surface a moment beyond that to actually mount its first screen.
  local deadline=$((SECONDS + SETTLE_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' \
        | grep -q "${PKG}/com.fpvarbcon.MainActivity"; then
      break
    fi
    sleep 1
  done
  sleep 5
}

crashes() {
  adb logcat -d 2>/dev/null | tr -d '\r' \
    | grep -E "FATAL EXCEPTION|ANR in ${PKG}" || true
}

restore_font_scale() {
  adb shell settings put system font_scale 1.0 >/dev/null 2>&1 || true
}
trap restore_font_scale EXIT

# ---------------------------------------------------------------------------
# 1. Default text size: the control. If this is already broken, nothing
#    below says anything about large text specifically.
# ---------------------------------------------------------------------------
echo "::group::font scale 1.0 (control)"
adb shell settings put system font_scale 1.0 >/dev/null 2>&1 || true
launch_and_settle
CRASH="$(crashes)"
if [ -n "$CRASH" ]; then
  echo "$CRASH" | tee "$DIAG_DIR/logcat-font-1.0.txt"
  fail "the app already crashes at the default font scale, so the large-text result below would mean nothing"
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 2. Two-times text.
# ---------------------------------------------------------------------------
echo "::group::font scale 2.0 (large text)"
adb shell settings put system font_scale 2.0 >/dev/null 2>&1 \
  || fail "could not set font_scale on this device"
echo "font_scale is now: $(adb shell settings get system font_scale 2>/dev/null | tr -d '\r')"
launch_and_settle
CRASH="$(crashes)"
adb logcat -d > "$DIAG_DIR/logcat-font-2.0.txt" 2>&1 || true
if [ -n "$CRASH" ]; then
  echo "$CRASH"
  fail "the app crashed or hung with the system font scale at 2.0"
else
  echo "no crash or ANR at font scale 2.0"
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 3. The accessibility tree, at the large text scale it was just launched
#    with, because that is the harder case.
# ---------------------------------------------------------------------------
echo "::group::accessibility tree"
DUMP_OK=0
for attempt in 1 2 3; do
  if adb shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1; then
    if adb pull /sdcard/window_dump.xml "$DIAG_DIR/window_dump.xml" >/dev/null 2>&1; then
      DUMP_OK=1
      break
    fi
  fi
  echo "uiautomator dump attempt ${attempt} did not produce a file; retrying"
  sleep 5
done

# WHAT THE WINDOW MANAGER THINKS IS IN FRONT, recorded before the tree is
# judged. If the dump turns out to hold no node of ours, this is the line
# that says whether the app was even the focused window - and it is cheap
# enough to print either way.
echo "current focus and resumed activity:"
adb shell dumpsys window 2>/dev/null | tr -d '\r' \
  | grep -E "mCurrentFocus|mFocusedApp|mHoldScreenWindow" || echo "  (no focus lines)"
adb shell dumpsys activity activities 2>/dev/null | tr -d '\r' \
  | grep -E "mResumedActivity|topResumedActivity|ResumedActivity:" || echo "  (no resumed-activity lines)"

if [ "$DUMP_OK" -ne 1 ] || [ ! -s "$DIAG_DIR/window_dump.xml" ]; then
  fail "could not capture an accessibility tree with uiautomator - the check could not be performed, which is not the same as passing"
else
  python3 - "$DIAG_DIR/window_dump.xml" "$PKG" <<'PY'
import sys
import xml.etree.ElementTree as ET

path, package = sys.argv[1], sys.argv[2]
try:
    root = ET.parse(path).getroot()
except ET.ParseError as error:
    print(f"::error::the accessibility dump is not parseable XML: {error}")
    raise SystemExit(1)

nodes = list(root.iter("node"))
ours = [n for n in nodes if n.get("package") == package]
print(f"nodes in dump: {len(nodes)}, belonging to {package}: {len(ours)}")

if not ours:
    # WHOSE WINDOW IS IT THEN. "No node belonging to the app" has two very
    # different causes - the app draws an anonymous canvas, or something
    # else is on top of it - and the dump already knows which. Naming the
    # packages that ARE there turns the error from a puzzle into a fact.
    seen = {}
    for n in nodes:
        key = n.get("package") or "<no package>"
        seen[key] = seen.get(key, 0) + 1
    print("packages present in the dump instead:")
    for name, count in sorted(seen.items(), key=lambda item: -item[1]):
        print(f"  {name}: {count} node(s)")
    for n in nodes[:20]:
        label = (n.get("content-desc") or "").strip() or (n.get("text") or "").strip()
        print(f"  [{n.get('package','?')}] {n.get('class','?')} "
              f"{n.get('bounds','?')} {label[:70]}")
    print(f"::error::the accessibility tree contains no node belonging to {package} - "
          f"either the app was not in the foreground or it exposes no accessibility nodes at all")
    raise SystemExit(1)

named = [
    n for n in ours
    if (n.get("content-desc") or "").strip() or (n.get("text") or "").strip()
]
print(f"nodes carrying a name (content-desc or text): {len(named)}")
for n in named[:15]:
    label = (n.get("content-desc") or "").strip() or (n.get("text") or "").strip()
    print(f"  [{n.get('class','?')}] {label[:90]}")

if not named:
    print("::error::every accessibility node in the app's window is unnamed. A screen reader "
          "would have nothing to read, and the Arabic UI would be unusable without sight.")
    raise SystemExit(1)

print("ACCESSIBILITY_SEMANTICS_VERIFIED: the window exposes named nodes. TalkBack was not "
      "enabled and no focus traversal or announcement was measured, so this is not a "
      "TalkBack result.")
PY
  [ "$?" -ne 0 ] && FAILED=1
fi
echo "::endgroup::"

restore_font_scale
echo "font scale restored to: $(adb shell settings get system font_scale 2>/dev/null | tr -d '\r')"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "large-text and accessibility checks passed."

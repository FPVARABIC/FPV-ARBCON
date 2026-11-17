#!/usr/bin/env bash
#
# 16 KB PAGE SIZE, PROVED ON A RUNNING DEVICE.
#
# scripts/ci/verify-native-packaging.sh already reads the APK on the host:
# every 64-bit .so's LOAD segments are >= 2**14, and zipalign agrees the
# zip puts them on 16 KB boundaries. That is a STATIC check and it is not
# what this file does. A library can satisfy both and still fail to map,
# because mapping is done by the dynamic linker on a device whose page
# size is a runtime fact.
#
# So this asks the device. It installs the real release APK on an emulator
# whose page size it has verified is 16384, cold-launches it, and then
# reads back from /proc/<pid>/maps WHICH SHARED LIBRARIES THE PROCESS
# ACTUALLY MAPPED. A library that the loader rejected is not in that list,
# and a process that died trying is not there to be asked.
#
# Android's own instruction for the first half, verbatim:
#
#     "Start up your test device, then run the following command to verify
#      that it's using a 16 KB environment: adb shell getconf PAGE_SIZE
#      The command should return a value of 16384."
#
# Usage: verify-16kb-runtime.sh <diagnostics-dir>
# Requires: an emulator with 16 KB pages, adb on PATH, the release APK
# built. Run from the android/ directory.

set -uo pipefail

PKG="${FPV_APP_ID:-com.fpvarbcon.nl}"
ACTIVITY="${PKG}/com.fpvarbcon.MainActivity"
DIAG="${1:?usage: verify-16kb-runtime.sh <diagnostics-dir>}"
mkdir -p "$DIAG"

FAILED=0
fail() {
  echo "::error::$*"
  FAILED=1
}

# ---------------------------------------------------------------------------
# 1. The device really uses 16 KB pages.
#
# Asserted, not reported. Everything below is a claim about 16 KB devices
# and would be worthless on a 4 KB image.
# ---------------------------------------------------------------------------
echo "::group::page size"
PAGE_SIZE="$(adb shell getconf PAGE_SIZE 2>/dev/null | tr -d '\r')"
echo "adb shell getconf PAGE_SIZE -> ${PAGE_SIZE:-<unavailable>}"
echo "${PAGE_SIZE:-unknown}" > "$DIAG/16kb-page-size.txt"
if [ "$PAGE_SIZE" != "16384" ]; then
  fail "this check requires a 16384 byte page size and the device reported '${PAGE_SIZE:-<unavailable>}'; nothing below would be evidence about 16 KB devices"
  echo "::endgroup::"
  exit 1
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 2. Install the release APK. Uninstall first so this is an install, not an
#    upgrade of whatever connectedAndroidTest left behind.
# ---------------------------------------------------------------------------
echo "::group::install the release APK"
APK=""
for candidate in \
  app/build/outputs/apk/release/app-release.apk \
  android/app/build/outputs/apk/release/app-release.apk
do
  if [ -s "$candidate" ]; then APK="$candidate"; break; fi
done
if [ -z "$APK" ]; then
  fail "no release APK found to install; the 16 KB runtime check inspected nothing"
  echo "::endgroup::"
  exit 1
fi
echo "installing $APK"
adb uninstall "$PKG" >/dev/null 2>&1 || true
if ! adb install -r "$APK" 2>&1 | tee "$DIAG/16kb-install.txt" | grep -q "Success"; then
  fail "the release APK did not install on a 16 KB device"
  cat "$DIAG/16kb-install.txt"
  echo "::endgroup::"
  exit 1
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 3. Cold launch.
# ---------------------------------------------------------------------------
echo "::group::cold launch on 16 KB pages"
adb logcat -c >/dev/null 2>&1 || true
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true
LAUNCH="$(adb shell am start -W -n "$ACTIVITY" 2>&1 | tr -d '\r')"
echo "$LAUNCH" | tee "$DIAG/16kb-launch.txt"
case "$LAUNCH" in
  *"Status: ok"*) ;;
  *) fail "the app did not report a successful launch on a 16 KB device" ;;
esac

# Give the React surface a moment to mount its native libraries. This is a
# settle, not a correctness budget: the assertions below are about what is
# mapped, and the loop re-asks rather than trusting one look.
PID=""
for _attempt in $(seq 1 30); do
  PID="$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
  [ -n "$PID" ] && break
  sleep 1
done
if [ -z "$PID" ]; then
  fail "the app process is not running after a cold launch, so no library could be inspected"
  echo "::endgroup::"
  exit 1
fi
echo "app pid: $PID"
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 4. WHICH LIBRARIES THE LOADER ACTUALLY MAPPED.
#
# This is the part a host-side check cannot do. /proc/<pid>/maps lists the
# mappings of the live process; a .so that the dynamic linker refused is
# absent from it.
# ---------------------------------------------------------------------------
echo "::group::native libraries mapped by the running process"
# Let the surface finish bringing up its native modules before the census.
for _settle in $(seq 1 10); do
  MAPPED_COUNT="$(adb shell run-as "$PKG" cat "/proc/$PID/maps" 2>/dev/null | tr -d '\r' | grep -c '\.so$')"
  [ "${MAPPED_COUNT:-0}" -gt 0 ] && break
  sleep 1
done

adb shell run-as "$PKG" cat "/proc/$PID/maps" 2>/dev/null | tr -d '\r' > "$DIAG/16kb-proc-maps.txt" || true
if [ ! -s "$DIAG/16kb-proc-maps.txt" ]; then
  # run-as is unavailable for a release-signed package on some images.
  adb shell cat "/proc/$PID/maps" 2>/dev/null | tr -d '\r' > "$DIAG/16kb-proc-maps.txt" || true
fi

if [ ! -s "$DIAG/16kb-proc-maps.txt" ]; then
  fail "could not read /proc/$PID/maps, so which libraries loaded is unknown - that is not the same as passing"
else
  awk '{print $NF}' "$DIAG/16kb-proc-maps.txt" \
    | grep '\.so$' | sort -u > "$DIAG/16kb-mapped-libraries.txt"
  MAPPED="$(wc -l < "$DIAG/16kb-mapped-libraries.txt" | tr -d ' ')"
  echo "distinct .so files mapped into the process: $MAPPED"
  sed 's/^/  /' "$DIAG/16kb-mapped-libraries.txt"

  if [ "$MAPPED" -eq 0 ]; then
    fail "the process mapped no shared library at all; this app ships native code, so nothing was proved"
  fi

  # The engines this application cannot run without. Named individually so
  # a failure says WHICH one the loader refused rather than "something".
  for engine in libhermes libreanimated; do
    if ! grep -q "$engine" "$DIAG/16kb-mapped-libraries.txt"; then
      fail "$engine is packaged but is not mapped into the running process on a 16 KB device"
    else
      echo "  OK mapped: $engine"
    fi
  done
  # Skia and the RN runtime ship under names that differ by version, so
  # they are matched by family rather than by an exact file name that a
  # future upgrade would silently stop matching. ERE alternation is a bare
  # `|`: a backslash-escaped one is a LITERAL pipe under grep -E and
  # matches nothing, which a rehearsal against a fake device caught.
  # Case-insensitive because libRNSkia.so and libskia.so both occur.
  for family in "skia|rnskia" "libreactnative|libreact"; do
    if ! grep -qiE "$family" "$DIAG/16kb-mapped-libraries.txt"; then
      fail "no library matching /$family/ is mapped into the running process on a 16 KB device"
    else
      echo "  OK mapped: /$family/"
    fi
  done
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 5. The linker's own verdict, and the compatibility mode that would mean
#    the device is emulating 4 KB behaviour rather than running 16 KB.
# ---------------------------------------------------------------------------
echo "::group::linker, crash, ANR and compatibility-mode scan"
adb logcat -d > "$DIAG/16kb-logcat.txt" 2>&1 || true
echo "logcat lines: $(wc -l < "$DIAG/16kb-logcat.txt" | tr -d ' ')"

scan() {
  local label="$1" pattern="$2"
  local hits
  hits="$(grep -E "$pattern" "$DIAG/16kb-logcat.txt" | head -20 || true)"
  if [ -n "$hits" ]; then
    echo "$hits"
    fail "$label"
  else
    echo "  clean: $label (searched /$pattern/)"
  fi
}

scan "the dynamic linker reported an error loading a library" \
  "CANNOT LINK EXECUTABLE|dlopen failed|library .* not found|has load segment|p_align|cannot be mapped"
scan "a fatal exception was raised on a 16 KB device" "FATAL EXCEPTION"
scan "an ANR was raised on a 16 KB device" "ANR in ${PKG}"
# If the platform put the app into page-size compatibility mode then the
# app is NOT running as a 16 KB app, and a green result here would be
# about the compatibility shim rather than about this APK.
scan "the app was placed in page-size compatibility mode" \
  "PAGE_SIZE_COMPAT|page size compat|pageSizeCompat|compat page size"
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 6. The packaged inventory, kept as an artifact.
#
# verify-native-packaging.sh prints every library and its measured
# alignment and fails on a 64-bit shortfall or a zipalign refusal. It is
# run HERE too, against the very APK that was just installed and launched,
# so the static and runtime halves are about one artifact rather than two.
# ---------------------------------------------------------------------------
echo "::group::packaged ABI and library inventory (static half, same APK)"
REPO_SCRIPT="../scripts/ci/verify-native-packaging.sh"
[ -x "$REPO_SCRIPT" ] || REPO_SCRIPT="scripts/ci/verify-native-packaging.sh"
if [ -x "$REPO_SCRIPT" ]; then
  if ! "$REPO_SCRIPT" "$APK" arm64-v8a,x86_64 > "$DIAG/16kb-packaging-inventory.txt" 2>&1; then
    fail "the packaged-library inventory failed for the APK installed on the 16 KB device"
  fi
  cat "$DIAG/16kb-packaging-inventory.txt"
else
  fail "verify-native-packaging.sh not found, so the inventory was not produced"
fi
echo "::endgroup::"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "16 KB runtime check passed: page size 16384, release APK installed, cold launch ok, every named engine mapped by the loader, no linker error, crash, ANR or compatibility-mode warning."

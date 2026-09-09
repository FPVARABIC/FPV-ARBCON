#!/usr/bin/env bash
#
# 16 KB PAGE COMPATIBILITY AND ABI COVERAGE OF THE SHIPPED NATIVE LIBRARIES.
#
# This application declares targetSdkVersion 36. From Android 15 onwards a
# device may use a 16 KB memory page size, and a shared library whose LOAD
# segments are aligned to the old 4 KB page cannot be mapped there: the
# loader rejects it and the app fails at startup, on the device, with
# nothing wrong in any test that ran on a 4 KB emulator. It is exactly the
# class of defect that only appears on real hardware, so the packaging is
# checked here instead of being assumed.
#
# There are TWO independent things to check, and passing one says nothing
# about the other:
#
#   1. ELF LOAD-segment alignment inside each .so - checked with readelf.
#      Android's guide: "Check the output lines to ensure that the load
#      segments don't have values less than 2**14."
#   2. Where each uncompressed .so sits inside the APK zip - checked with
#      zipalign. Android's guide: "Run the following zipalign command to
#      verify that your app is 16 KB-aligned [...] zipalign -c -P 16 -v 4
#      APK_NAME.apk". A library can be perfectly aligned internally and
#      still be unmappable because the zip put it on a 4 KB boundary; that
#      is the AGP < 8.5.1 / bundletool failure mode the same guide warns
#      about. This check was missing until now.
#
# SCOPE OF THE HARD REQUIREMENT.
#
# Android's own statement of the requirement, verbatim, from
# https://developer.android.com/guide/practices/page-sizes:
#
#     "To ensure your app works correctly on the latest versions of
#      Android, all apps targeting Android 15 (API level 35) and higher
#      must support 16 KB memory page sizes on 64-bit devices on Google
#      Play. Starting February 1, 2027, if your app updates don't support
#      16 KB memory page sizes, you won't be able to release these
#      updates."
#
# "on 64-bit devices" is load-bearing: 16 KB page mode is a 64-bit Android
# feature, so a 4 KB-aligned armeabi-v7a or x86 library cannot be loaded on
# a 16 KB device for the simple reason that no 16 KB device runs it.
#
# So the ELF gate FAILS for a 64-bit ABI and REPORTS for a 32-bit one.
# Nothing is hidden: every packaged .so is listed with its measured
# alignment either way, and any 32-bit shortfall is printed by name, with a
# count, under its own heading. It is a classification, not a suppression
# and not a baseline - no list of known-bad files is stored anywhere, so a
# newly misaligned 64-bit library still fails on the day it appears.
#
# Set REQUIRE_16K_ON_32BIT_ABIS=1 to make the 32-bit findings fail too.
#
# It also checks WHICH ABIs shipped. reactNativeArchitectures decides that,
# and an accidentally narrowed build produces an APK that simply will not
# install on half the fleet - which no functional test would notice.
#
# Usage: verify-native-packaging.sh <apk> [expected-abi[,expected-abi...]]
# Env:   ZIPALIGN                  explicit path to the zipalign binary
#        REQUIRE_16K_ON_32BIT_ABIS 1 to fail on 32-bit shortfalls too

set -uo pipefail

APK="${1:?usage: verify-native-packaging.sh <apk> [expected-abis]}"
EXPECTED_ABIS="${2:-}"
REQUIRED_ALIGNMENT=16384
REQUIRE_32BIT="${REQUIRE_16K_ON_32BIT_ABIS:-0}"

if [ ! -s "$APK" ]; then
  echo "::error::no APK at $APK"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "APK: $APK"
unzip -o -q "$APK" 'lib/*' -d "$WORK" 2>/dev/null || true

mapfile -t LIBS < <(find "$WORK/lib" -name '*.so' 2>/dev/null | sort)

# ---------------------------------------------------------------------------
# Non-vacuity. This application ships Hermes and several native modules; an
# APK with no lib/ entries means the check is inspecting nothing, and that
# must not read as a pass.
# ---------------------------------------------------------------------------
if [ "${#LIBS[@]}" -eq 0 ]; then
  echo "::error::no lib/**/*.so entries in $APK - this application ships native code, so either the APK is wrong or this check is inspecting nothing"
  exit 1
fi
echo "native libraries found: ${#LIBS[@]}"

FAILED=0

# ---------------------------------------------------------------------------
# ABI coverage
# ---------------------------------------------------------------------------
mapfile -t ABIS < <(find "$WORK/lib" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)
echo "ABIs packaged: ${ABIS[*]}"
if [ -n "$EXPECTED_ABIS" ]; then
  for abi in ${EXPECTED_ABIS//,/ }; do
    found=0
    for present in "${ABIS[@]}"; do
      [ "$present" = "$abi" ] && found=1
    done
    if [ "$found" -ne 1 ]; then
      echo "::error::expected ABI '$abi' is not in the APK (packaged: ${ABIS[*]})"
      FAILED=1
    fi
  done
fi

# ---------------------------------------------------------------------------
# 1. ELF LOAD-segment alignment of every packaged library
# ---------------------------------------------------------------------------
echo "::group::LOAD segment alignment of every packaged .so (required >= ${REQUIRED_ALIGNMENT} on 64-bit ABIs)"
if ! python3 - "$REQUIRED_ALIGNMENT" "$REQUIRE_32BIT" "${LIBS[@]}" <<'PY'; then
import re
import subprocess
import sys

required = int(sys.argv[1])
require_32bit = sys.argv[2] == "1"
libraries = sys.argv[3:]

# 16 KB page mode is a 64-bit Android feature. Google Play's requirement is
# stated "on 64-bit devices"; these are the ABIs a 16 KB device can run.
SIXTY_FOUR_BIT = {"arm64-v8a", "x86_64", "riscv64"}

broken = []        # not a shared library at all - always fatal
under_64 = []      # 64-bit ABI below the requirement - fatal
under_32 = []      # 32-bit ABI below 16 KB - reported, or fatal on request
inspected = 0
bits_seen = set()

for path in libraries:
    try:
        out = subprocess.run(
            ["readelf", "-lW", path],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        print(f"::error::could not read ELF program headers of {path}: {error}")
        raise SystemExit(1)

    aligns = []
    for line in out.splitlines():
        stripped = line.strip()
        if not stripped.startswith("LOAD"):
            continue
        match = re.search(r"0x([0-9a-fA-F]+)\s*$", stripped)
        if match:
            aligns.append(int(match.group(1), 16))

    parts = path.split("/")
    abi = parts[-2]
    short = "/".join(parts[-2:])
    bits_seen.add(abi)

    if not aligns:
        print(f"::error::{short} has no LOAD segments - not a mappable shared library")
        broken.append(short)
        continue

    inspected += 1
    worst = min(aligns)
    sixty_four = abi in SIXTY_FOUR_BIT
    if worst >= required:
        status = "ok"
    elif sixty_four:
        status = "TOO SMALL (64-bit: REQUIRED)"
        under_64.append(f"{short} ({worst})")
    else:
        status = "below 16 KB (32-bit: not reachable by a 16 KB device)"
        under_32.append(f"{short} ({worst})")
    print(f"{short:<62} min LOAD align = {worst:>6} ({hex(worst):>8})  {status}")

if inspected == 0:
    print("::error::no library yielded a LOAD segment, so nothing was actually checked")
    raise SystemExit(1)

sixty_four_present = sorted(bits_seen & SIXTY_FOUR_BIT)
if not sixty_four_present:
    print("::error::no 64-bit ABI is packaged, so the 16 KB requirement was not exercised "
          "by a single library in this APK")
    raise SystemExit(1)

print()
print(f"inventory: {inspected} shared libraries across {len(bits_seen)} ABIs "
      f"({', '.join(sorted(bits_seen))})")
print(f"64-bit ABIs carrying the requirement: {', '.join(sixty_four_present)}")

if under_32:
    print()
    print(f"NOT REQUIRED, REPORTED ANYWAY - {len(under_32)} 32-bit libraries below "
          f"{required} bytes:")
    for entry in under_32:
        print(f"  {entry}")
    print("  Android scopes the requirement to 64-bit devices: \"all apps targeting "
          "Android 15 (API level 35) and higher must support 16 KB memory page sizes "
          "on 64-bit devices on Google Play\". A 16 KB device does not run armeabi-v7a "
          "or x86 code, so these cannot fail to map there. They are listed so the set "
          "is visible and so nobody mistakes silence for absence.")
    if require_32bit:
        print("::error::REQUIRE_16K_ON_32BIT_ABIS=1, so the 32-bit shortfalls above are "
              "being treated as failures")

failed = bool(broken) or bool(under_64) or (require_32bit and bool(under_32))

if under_64:
    print(f"::error::{len(under_64)} 64-bit native library/libraries are not 16 KB aligned "
          f"and will fail to load on an Android 15+ device with 16 KB pages: "
          f"{', '.join(under_64)}")

if failed:
    raise SystemExit(1)

print()
print(f"every 64-bit library is aligned to at least {required} bytes")
PY
  FAILED=1
fi
echo "::endgroup::"

# ---------------------------------------------------------------------------
# 2. Zip alignment of the real APK
#
# The command and the success string are Android's, verbatim:
#   "Run the following zipalign command to verify that your app is 16
#    KB-aligned [...] zipalign -c -P 16 -v 4 APK_NAME.apk"
#   "The last line of the output will say "Verification successful" if all
#    of the shared libraries are aligned correctly."
#
# A missing zipalign is a failure, not a skip. A gate that quietly does
# nothing when its tool is absent is worse than no gate, because the log
# still reads green.
# ---------------------------------------------------------------------------
echo "::group::zipalign -c -P 16 -v 4 (16 KB zip alignment of the packaged .so entries)"
ZIPALIGN_BIN="${ZIPALIGN:-}"
if [ -z "$ZIPALIGN_BIN" ]; then
  for candidate in \
    "${ANDROID_HOME:-}/build-tools/36.0.0/zipalign" \
    "${ANDROID_SDK_ROOT:-}/build-tools/36.0.0/zipalign"
  do
    if [ -x "$candidate" ]; then
      ZIPALIGN_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$ZIPALIGN_BIN" ] && [ -n "${ANDROID_HOME:-}" ]; then
  # Any build-tools version will do for this check; take the newest present
  # rather than failing over a version number.
  ZIPALIGN_BIN="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -name zipalign -type f 2>/dev/null | sort -V | tail -n 1)"
fi
if [ -z "$ZIPALIGN_BIN" ]; then
  ZIPALIGN_BIN="$(command -v zipalign 2>/dev/null || true)"
fi

if [ -z "$ZIPALIGN_BIN" ] || [ ! -x "$ZIPALIGN_BIN" ]; then
  echo "::error::zipalign was not found (looked at \$ZIPALIGN, \$ANDROID_HOME/build-tools and \$PATH); the APK's 16 KB zip alignment was NOT checked"
  FAILED=1
else
  echo "zipalign binary: $ZIPALIGN_BIN"
  ZIPALIGN_LOG="$WORK/zipalign.txt"
  "$ZIPALIGN_BIN" -c -P 16 -v 4 "$APK" > "$ZIPALIGN_LOG" 2>&1
  ZIPALIGN_STATUS=$?
  # -v prints one line per entry; the interesting ones are the failures and
  # the verdict. Printing every entry of a React Native APK would bury both.
  echo "zipalign exit status: $ZIPALIGN_STATUS"
  echo "zip entries reported: $(grep -c '(OK\|(BAD' "$ZIPALIGN_LOG" || true)"
  grep -i "BAD\|Verification" "$ZIPALIGN_LOG" || true
  if [ "$ZIPALIGN_STATUS" -ne 0 ] || ! grep -qi "Verification successful" "$ZIPALIGN_LOG"; then
    echo "::error::zipalign -c -P 16 -v 4 did not report \"Verification successful\" for $APK (exit $ZIPALIGN_STATUS) - either an uncompressed shared library does not start on a 16 KB boundary inside the zip, in which case it cannot be mapped directly on a 16 KB device, or zipalign did not produce a verdict at all, in which case nothing was verified"
    echo "--- full zipalign output ---"
    cat "$ZIPALIGN_LOG"
    FAILED=1
  fi
fi
echo "::endgroup::"

exit "$FAILED"

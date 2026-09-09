#!/usr/bin/env bash
#
# 16 KB PAGE ALIGNMENT AND ABI COVERAGE OF THE SHIPPED NATIVE LIBRARIES.
#
# This application declares targetSdkVersion 36. From Android 15 onwards
# devices may use a 16 KB memory page size, and a shared library whose
# LOAD segments are aligned to the old 4 KB page cannot be mapped there:
# the loader rejects it and the app fails at startup, on the device, with
# nothing wrong in any test that ran on a 4 KB emulator. It is exactly the
# class of defect that only appears on real hardware, so the packaging is
# checked here instead of being assumed.
#
# The APK carries native code from several sources - Hermes, Skia,
# Reanimated, Worklets, the React Native runtime - and they are not all
# built by this repository. A prebuilt that was never re-linked for 16 KB
# is the likely finding, and it is a finding, not something to wave
# through.
#
# It also checks WHICH ABIs shipped. reactNativeArchitectures decides that,
# and an accidentally narrowed build produces an APK that simply will not
# install on half the fleet - which no functional test would notice.
#
# Usage: verify-native-packaging.sh <apk> [expected-abi[,expected-abi...]]

set -uo pipefail

APK="${1:?usage: verify-native-packaging.sh <apk> [expected-abis]}"
EXPECTED_ABIS="${2:-}"
REQUIRED_ALIGNMENT=16384

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
# 16 KB alignment of every LOAD segment of every library
# ---------------------------------------------------------------------------
echo "::group::LOAD segment alignment (required >= ${REQUIRED_ALIGNMENT})"
if ! python3 - "$REQUIRED_ALIGNMENT" "${LIBS[@]}" <<'PY'; then
import re
import subprocess
import sys

required = int(sys.argv[1])
libraries = sys.argv[2:]
offenders = []
inspected = 0

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

    short = "/".join(path.split("/")[-2:])
    if not aligns:
        print(f"::error::{short} has no LOAD segments - not a mappable shared library")
        offenders.append(short)
        continue

    inspected += 1
    worst = min(aligns)
    status = "ok" if worst >= required else "TOO SMALL"
    print(f"{short:<58} min LOAD align = {worst:>6} ({hex(worst)})  {status}")
    if worst < required:
        offenders.append(f"{short} ({worst})")

if inspected == 0:
    print("::error::no library yielded a LOAD segment, so nothing was actually checked")
    raise SystemExit(1)

if offenders:
    print(f"::error::{len(offenders)} native library/libraries are not 16 KB aligned and will "
          f"fail to load on an Android 15+ device with 16 KB pages: {', '.join(offenders)}")
    raise SystemExit(1)

print(f"\nall {inspected} native libraries are aligned to at least {required} bytes")
PY
  FAILED=1
fi
echo "::endgroup::"

exit "$FAILED"

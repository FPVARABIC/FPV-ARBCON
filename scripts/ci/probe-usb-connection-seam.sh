#!/usr/bin/env bash
#
# WHAT ANDROID ACTUALLY EXPOSES OF UsbDeviceConnection, MEASURED.
#
# UsbSerialSession.kt holds a real android.hardware.usb.UsbDeviceConnection
# and calls close() on it. No JVM unit test in this repository constructs
# that class, so the file sits at 0 of 33 covered lines - which run
# 34780928743 published. Every proposal for fixing that (add a mocking
# framework, extract a seam, shadow the platform class) rests on one claim:
#
#   "UsbDeviceConnection has no accessible constructor."
#
# That claim is written in a COMMENT in DfuControlChannel.kt and has never
# been measured. This measures it, in the two places that can disagree:
#
#   COMPILE classpath  android.jar, the SDK stubs javac sees. This decides
#                      whether a test can be WRITTEN at all.
#   ON DISK            every jar that carries the class, with its
#                      constructors listed. AGP has historically generated
#                      a "mockable" android jar for unit tests which strips
#                      final and rewrites method bodies; whether it also
#                      synthesises a constructor is exactly the kind of
#                      thing that must not be recalled from memory, because
#                      if it does, no seam is needed at all.
#
# WHAT THIS DOES NOT ANSWER. It does not resolve the unit-test runtime
# classpath through Gradle, so "this jar exists on disk and carries the
# class" is not the same statement as "the unit-test task loads the class
# from this jar". The compile probes below are about what can be WRITTEN;
# what a written test then DOES at run time is a separate measurement and
# is not claimed here.
#
# THE POSITIVE CONTROL IS THE POINT. A probe that only reports rejections
# cannot tell "the platform forbids this" from "the classpath was wrong and
# everything was rejected". P0 must COMPILE. If it does not, nothing else
# in this file means anything and the probe says so.
#
# This prints. It does not decide. The decision is taken from the output and
# only then encoded as an assertion somewhere that can fail.
#
# NOT VERIFIED ON REAL HARDWARE.

set -uo pipefail

TARGET_CLASS="android.hardware.usb.UsbDeviceConnection"
OUT="${1:-usb-connection-seam-probe.txt}"

say() { echo "$@"; }

{
  say "===== UI-X3B USB CONNECTION SEAM PROBE ====="
  say "  class under probe : $TARGET_CLASS"

  # ------------------------------------------------------------------
  # 1. THE COMPILE CLASSPATH: android.jar
  # ------------------------------------------------------------------
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  say "  ANDROID_HOME      : ${sdk:-<unset>}"
  android_jar=""
  if [ -n "$sdk" ]; then
    android_jar="$(ls -d "$sdk"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1)"
  fi
  say "  android.jar       : ${android_jar:-<not found>}"

  if [ -z "$android_jar" ] || [ ! -f "$android_jar" ]; then
    say "  ::error::no android.jar found - this probe could not run at all"
    say "seam probe: NOT RUN (no android.jar)"
    say "==========================================="
  else

  say ""
  say "  ---- javap on the COMPILE stub (android.jar) ----"
  # -p prints private members too, so "there is a constructor and it is not
  # accessible" is distinguishable from "there is no constructor".
  javap -p -classpath "$android_jar" "$TARGET_CLASS" 2>&1 | sed 's/^/    /'
  say ""
  say "  ---- constructors only, from the same stub ----"
  constructors="$(javap -p -classpath "$android_jar" "$TARGET_CLASS" 2>/dev/null \
    | grep -E "UsbDeviceConnection\(" || true)"
  if [ -n "$constructors" ]; then
    printf '%s\n' "$constructors" | sed 's/^/    /'
  else
    say "    (javap listed NO constructor at all)"
  fi

  # ------------------------------------------------------------------
  # 2. EVERY JAR ON DISK THAT CARRIES THE CLASS
  # ------------------------------------------------------------------
  say ""
  say "  ---- jars on disk that carry $TARGET_CLASS ----"
  # javap itself is the membership test, so this needs no unzip and cannot
  # disagree with what javap would read.
  found_any=0
  while IFS= read -r jar; do
    [ -f "$jar" ] || continue
    listing="$(javap -p -classpath "$jar" "$TARGET_CLASS" 2>/dev/null)" || continue
    [ -n "$listing" ] || continue
    found_any=1
    say "    $jar"
    say "      class line  : $(printf '%s\n' "$listing" | grep -E "class " | head -1 | sed 's/^ *//')"
    jar_constructors="$(printf '%s\n' "$listing" | grep -E "UsbDeviceConnection\(" || true)"
    if [ -n "$jar_constructors" ]; then
      printf '%s\n' "$jar_constructors" | sed 's/^ *//;s/^/      constructor : /'
    else
      say "      constructor : (none listed)"
    fi
  done < <(
    {
      echo "$android_jar"
      find "${HOME}/.gradle" -name "mockable-android-*.jar" 2>/dev/null
      find . -name "mockable-android-*.jar" 2>/dev/null
      find . -path '*mockable*' -name '*.jar' 2>/dev/null
    } | sort -u
  )
  if [ "$found_any" -eq 0 ]; then
    say "    (no jar on disk carries the class - not even android.jar, which"
    say "     contradicts the section above and means this probe is broken)"
  fi

  # ------------------------------------------------------------------
  # 3. THE COMPILE PROBES
  # ------------------------------------------------------------------
  # javap reports what the stub DECLARES. javac enforces what a test can
  # actually WRITE, and the two differ: a package-private member is
  # declared and unusable from another package. So the claim goes to the
  # compiler directly, in four forms, each recorded on its own.
  say ""
  say "  ---- compile probes (javac against android.jar) ----"
  probe_dir="$(mktemp -d)"
  trap 'rm -rf "$probe_dir"' EXIT

  # P0  THE POSITIVE CONTROL: reference the class and call a public method.
  #     This MUST compile. If it does not, the classpath is wrong and every
  #     rejection below is meaningless.
  mkdir -p "$probe_dir/p0/com/fpvarbcon/probe"
  cat > "$probe_dir/p0/com/fpvarbcon/probe/P0.java" <<'JAVA'
package com.fpvarbcon.probe;
import android.hardware.usb.UsbDeviceConnection;
public class P0 {
  public static Class<?> named() { return UsbDeviceConnection.class; }
  public static void shut(UsbDeviceConnection given) { given.close(); }
  public static int fileDescriptorOf(UsbDeviceConnection given) { return given.getFileDescriptor(); }
}
JAVA

  # P1  construct it from an ordinary test package
  mkdir -p "$probe_dir/p1/com/fpvarbcon/probe"
  cat > "$probe_dir/p1/com/fpvarbcon/probe/P1.java" <<'JAVA'
package com.fpvarbcon.probe;
import android.hardware.usb.UsbDeviceConnection;
public class P1 {
  public static UsbDeviceConnection make() { return new UsbDeviceConnection(null); }
}
JAVA

  # P2  subclass it from an ordinary test package
  mkdir -p "$probe_dir/p2/com/fpvarbcon/probe"
  cat > "$probe_dir/p2/com/fpvarbcon/probe/P2.java" <<'JAVA'
package com.fpvarbcon.probe;
import android.hardware.usb.UsbDeviceConnection;
public class P2 extends UsbDeviceConnection {
}
JAVA

  # P3  subclass it from INSIDE the platform's own package, where a
  #     package-private constructor would be reachable if the stub kept one
  mkdir -p "$probe_dir/p3/android/hardware/usb"
  cat > "$probe_dir/p3/android/hardware/usb/P3.java" <<'JAVA'
package android.hardware.usb;
public class P3 extends UsbDeviceConnection {
}
JAVA

  declare -A result=()
  for probe in p0 p1 p2 p3; do
    say ""
    say "    == $probe =="
    log="$probe_dir/$probe.log"
    # shellcheck disable=SC2046  # the file list is generated and has no spaces
    if javac -nowarn -d "$probe_dir/$probe-out" \
         -classpath "$android_jar" \
         $(find "$probe_dir/$probe" -name '*.java') > "$log" 2>&1; then
      result[$probe]="COMPILED"
      say "      RESULT: COMPILED"
    else
      result[$probe]="REJECTED"
      say "      RESULT: REJECTED BY javac"
    fi
    sed 's/^/      /' "$log" | head -20
  done

  say ""
  if [ "${result[p0]}" != "COMPILED" ]; then
    say "  ::error::the positive control P0 did not compile, so the classpath is wrong"
    say "  and the other three results say nothing about the platform."
  fi
  # ONE LINE, LAST, so it survives a truncated log tail.
  say "seam probe: P0=${result[p0]} P1=${result[p1]} P2=${result[p2]} P3=${result[p3]}"
  say "==========================================="

  fi
} > "$OUT" 2>&1

cat "$OUT"

# A probe reports; it does not gate. The one thing that makes it exit
# non-zero is being unable to measure - either no android.jar, or the
# positive control failing, because both mean the output is worthless and
# that must not read as a clean probe.
if grep -q "^seam probe: NOT RUN" "$OUT"; then
  exit 1
fi
if ! grep -q "^seam probe: P0=COMPILED" "$OUT"; then
  exit 1
fi
exit 0

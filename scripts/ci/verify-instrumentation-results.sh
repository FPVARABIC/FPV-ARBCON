#!/usr/bin/env bash
#
# PROVE THE EMULATOR RUN ACTUALLY EXECUTED TESTS, AND SAY WHAT IT FOUND.
#
# `connectedAndroidTest` can end in several very different ways that all
# look alike from the outside, and this repository has already seen two of
# them reported as one another:
#
#   * the APKs never built            -> no results directory
#   * the emulator never came up      -> no results directory
#   * the app installed and ran zero  -> results directory, tests="0"
#   * tests ran and failed            -> results directory, failures>0
#   * tests ran and passed            -> the only green outcome
#
# Only the last is a pass. In particular a missing results directory or a
# zero test count is a FAILURE here, never a silent success, because
# "nothing ran" is exactly what a broken lane looks like.
#
# It also scans the captured logcat: a suite can report all-green while
# the app under test crashed on a thread nobody asserted on, and an ANR
# leaves no test failure at all.
#
# Usage: verify-instrumentation-results.sh <results-dir> [logcat-file]

set -uo pipefail

RESULTS_DIR="${1:?usage: verify-instrumentation-results.sh <results-dir> [logcat-file]}"
LOGCAT="${2:-}"

# WHERE THE VERDICT IS ALSO WRITTEN, AND WHY.
#
# This script runs in the middle of a job. GitHub's log API returns only
# the last few kilobytes of a job's log, and on run 34402391642 the API 36
# row's summary printed two seconds before that window began - so the one
# thing needed to diagnose the failure was the one thing unreadable. The
# verdict is therefore written to a file as well as printed, and the
# workflow re-prints that file as its final step, which puts it inside the
# tail whatever happens in between.
DIGEST="${INSTRUMENTATION_DIGEST_FILE:-instrumentation-digest.txt}"
: > "$DIGEST"
note() { echo "$*"; echo "$*" >> "$DIGEST"; }

FAILED=0

if [ ! -d "$RESULTS_DIR" ]; then
  note "::error::no androidTest results directory at $RESULTS_DIR - the APKs did not build, the emulator did not come up, or the run never started. This is NOT a test failure; read the build and emulator steps above."
  exit 1
fi

echo "::group::Instrumentation results ($RESULTS_DIR)"
python3 - "$RESULTS_DIR" "$DIGEST" <<'PY'
import glob
import os
import sys
import xml.etree.ElementTree as ET

results_dir = sys.argv[1]
digest_path = sys.argv[2]
digest = []


def say(line):
    """Print, and keep for the digest the workflow re-prints last."""
    print(line)
    digest.append(line)


def flush():
    with open(digest_path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(digest) + "\n")


files = sorted(glob.glob(os.path.join(results_dir, "**", "*.xml"), recursive=True))
if not files:
    say(f"::error::no JUnit XML under {results_dir}")
    flush()
    raise SystemExit(1)

total = failures = errors = skipped = 0
failing = []
suites = 0

for path in files:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        say(f"::error::{path} is not parseable XML: {error}")
        flush()
        raise SystemExit(1)
    elements = [root] if root.tag == "testsuite" else root.findall("testsuite")
    for suite in elements:
        suites += 1
        t = int(suite.get("tests", 0) or 0)
        f = int(suite.get("failures", 0) or 0)
        e = int(suite.get("errors", 0) or 0)
        s = int(suite.get("skipped", 0) or 0)
        total += t
        failures += f
        errors += e
        skipped += s
        print(f"suite {suite.get('name', '?')}: tests={t} failures={f} errors={e} skipped={s}")
        for case in suite.findall("testcase"):
            for bad in list(case.findall("failure")) + list(case.findall("error")):
                message = (bad.get("message") or bad.text or "").strip().replace("\n", " ")
                failing.append(
                    f"{case.get('classname', '?')}#{case.get('name', '?')}: {message[:400]}"
                )

say(f"INSTRUMENTATION_SUMMARY suites={suites} tests={total} "
    f"failures={failures} errors={errors} skipped={skipped}")

if failing:
    say("failing cases:")
    for line in failing:
        say(f"  {line}")

if total == 0:
    say("::error::instrumentation executed ZERO tests - a run that asserted nothing is not a pass")
    flush()
    raise SystemExit(1)
if failures or errors:
    say(f"::error::instrumentation reported failures={failures} errors={errors}")
    flush()
    raise SystemExit(1)
# A SKIPPED CASE IS A CASE THAT DID NOT RUN. It was already counted and
# printed above, but only as information - so a test that quietly started
# skipping (an Assume that stopped holding, an @Ignore added to get past a
# red build) would have gone on reporting green forever. Every device test
# in this project is expected to run on every level in the matrix; if one
# of them ever genuinely cannot, that is a decision to make deliberately
# and not something to discover from a count nobody was reading.
if skipped:
    say(f"::error::instrumentation SKIPPED {skipped} case(s) - a case that did not run cannot be counted as one that passed")
    flush()
    raise SystemExit(1)
flush()
PY
RESULTS_STATUS=$?
echo "::endgroup::"
[ "$RESULTS_STATUS" -ne 0 ] && FAILED=1

# ---------------------------------------------------------------------------
# A green suite is not the same as a healthy app. An uncaught exception on
# a thread no test asserted on, or an ANR, leaves every assertion passing.
# ---------------------------------------------------------------------------
if [ -n "$LOGCAT" ] && [ -s "$LOGCAT" ]; then
  echo "::group::logcat crash and ANR scan"
  if grep -n "FATAL EXCEPTION" "$LOGCAT"; then
    note "::error::the app under test hit an uncaught exception during instrumentation"
    FAILED=1
  else
    note "no FATAL EXCEPTION in logcat"
  fi
  if grep -nE "ANR in com\.fpvarbcon|Reason: Input dispatching timed out" "$LOGCAT"; then
    note "::error::the app under test was reported as not responding (ANR)"
    FAILED=1
  else
    note "no ANR for com.fpvarbcon in logcat"
  fi
  echo "::endgroup::"
elif [ -n "$LOGCAT" ]; then
  # Not a gate: a missing logcat means the capture failed, which is worth
  # seeing but is not itself evidence that the app misbehaved.
  note "::warning::no logcat captured at $LOGCAT - crash and ANR scanning was skipped"
fi

exit "$FAILED"

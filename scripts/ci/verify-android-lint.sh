#!/usr/bin/env bash
#
# RUN ANDROID LINT FOR ONE VARIANT AND PROVE IT ACTUALLY ANALYSED SOMETHING.
#
# A green Gradle exit is not evidence that lint ran. Three separate things
# have to be true, and each of them has failed in this repository at least
# once:
#
#   1. Lint's analysis task has to EXECUTE. Before android.lint.useK2Uast
#      was set, :react-native-worklets:lintAnalyzeDebug crashed outright
#      ("Cannot find a KaModule for the VirtualFile") and :app never got
#      to analyse anything.
#   2. The reports have to EXIST and be non-empty. The step that uploaded
#      them used to point at a path nothing produced, so it "succeeded" on
#      zero files for months.
#   3. The findings have to be VISIBLE. Gradle prints only "Lint found N
#      errors and M warnings. First failure: ..." - one of N+M. The rest
#      lived only in an HTML artifact, and in this environment artifact
#      storage is not reachable, so anything not printed here is lost.
#
# This script therefore runs the task, prints EVERY issue from the XML
# report, and fails if the analysis task did not run or the reports are
# missing - independently of whether lint itself found errors.
#
# Usage: scripts/ci/verify-android-lint.sh <debug|release>
# Run from the android/ directory.

set -uo pipefail

VARIANT="${1:?usage: verify-android-lint.sh <debug|release>}"
case "$VARIANT" in
  debug) SUFFIX="Debug" ;;
  release) SUFFIX="Release" ;;
  *)
    echo "::error::unknown lint variant '$VARIANT' (expected debug or release)"
    exit 2
    ;;
esac

TASK=":app:lint${SUFFIX}"
ANALYZE_TASK=":app:lintAnalyze${SUFFIX}"
HTML_REPORT="app/build/reports/lint-results-${VARIANT}.html"
XML_REPORT="app/build/reports/lint-results-${VARIANT}.xml"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

echo "::group::gradlew $TASK"
./gradlew "$TASK" --no-daemon --stacktrace --console=plain 2>&1 | tee "$LOG"
GRADLE_STATUS="${PIPESTATUS[0]}"
echo "::endgroup::"
echo "gradle exit status for $TASK: $GRADLE_STATUS"

FAILED=0

# ---------------------------------------------------------------------------
# 1. The analysis task really ran.
#
# Gradle prints "> Task :app:lintAnalyzeDebug" with an optional outcome
# suffix. SKIPPED and NO-SOURCE mean nothing was analysed; UP-TO-DATE and
# FROM-CACHE are legitimate (the reports still have to exist, checked
# below). A missing line means the task was never in the graph at all,
# which is the silent-no-op case this whole script exists to catch.
# ---------------------------------------------------------------------------
ANALYZE_LINE="$(grep -E "^> Task ${ANALYZE_TASK}( |$)" "$LOG" | tail -n 1 || true)"
if [ -z "$ANALYZE_LINE" ]; then
  echo "::error::${ANALYZE_TASK} never ran - lint analysed nothing for this variant"
  FAILED=1
else
  echo "lint analysis task outcome: ${ANALYZE_LINE}"
  case "$ANALYZE_LINE" in
    *SKIPPED* | *NO-SOURCE*)
      echo "::error::${ANALYZE_TASK} did not analyse anything: ${ANALYZE_LINE}"
      FAILED=1
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 2. Both reports exist and are non-empty.
# ---------------------------------------------------------------------------
for report in "$HTML_REPORT" "$XML_REPORT"; do
  if [ ! -s "$report" ]; then
    echo "::error::Android Lint produced no report at $report"
    FAILED=1
  fi
done

# ---------------------------------------------------------------------------
# 3. Publish every finding, and confirm the XML is a real lint report.
# ---------------------------------------------------------------------------
if [ -s "$XML_REPORT" ]; then
  echo "::group::Android Lint findings ($VARIANT) - every issue, not just the first"
  if ! python3 "$(dirname "$0")/print-lint-findings.py" "$XML_REPORT" "$VARIANT"; then
    FAILED=1
  fi
  echo "::endgroup::"
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit "$GRADLE_STATUS"

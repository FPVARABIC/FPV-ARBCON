#!/usr/bin/env python3
"""
Print every finding in an Android Lint XML report, and refuse a file that
is not one.

Extracted from verify-android-lint.sh so the same parser can be used twice:
once by the lint gate itself, and once by a digest step at the very END of
the job. That second use is not cosmetic - GitHub's log API returns only a
bounded tail, and artifact storage is not reachable from the environment
this repository is audited in, so findings printed early in a long job
become unreadable. Printed last, they are always retrievable.

Usage: print-lint-findings.py <lint-results.xml> <variant-label>
"""
import collections
import sys
import xml.etree.ElementTree as ET

path, variant = sys.argv[1], sys.argv[2]
try:
    root = ET.parse(path).getroot()
except ET.ParseError as error:
    print(f"::error::{path} is not parseable XML: {error}")
    raise SystemExit(1)

if root.tag != "issues":
    print(f"::error::{path} root element is <{root.tag}>, not <issues>")
    raise SystemExit(1)

produced_by = root.get("by")
if not produced_by:
    print(f"::error::{path} carries no 'by' attribute, so it is not a lint report")
    raise SystemExit(1)
print(f"report produced by: {produced_by}  (format {root.get('format')})")

counts = collections.Counter()
rows = []
for issue in root.findall("issue"):
    severity = issue.get("severity", "?")
    counts[severity] += 1
    location = issue.find("location")
    where = "(no location)"
    if location is not None:
        where = location.get("file", "?")
        line = location.get("line")
        if line:
            where = f"{where}:{line}"
    rows.append((severity, issue.get("id", "?"), where, (issue.get("message") or "").replace("\n", " ")))

order = {"Fatal": 0, "Error": 1, "Warning": 2, "Information": 3}
for severity, issue_id, where, message in sorted(rows, key=lambda r: (order.get(r[0], 9), r[1], r[2])):
    print(f"{severity:<12} {issue_id:<28} {where}\n{'':<12} {message}")

total = sum(counts.values())
summary = ", ".join(f"{name}={counts[name]}" for name in sorted(counts)) or "none"
print(f"\n{variant}: {total} issue(s) -> {summary}")

# A per-severity tally the workflow log can be grepped for later.
print(f"LINT_SUMMARY {variant} total={total} " +
      " ".join(f"{name.lower()}={counts[name]}" for name in sorted(counts)))

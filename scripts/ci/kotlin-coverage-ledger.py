#!/usr/bin/env python3
"""
THE NATIVE COVERAGE AND CLASSIFICATION LEDGER.

WHAT THIS IS FOR. "The Android tests pass" says nothing about how much of
the Android code they ran. This reads the JaCoCo report the JVM unit test
task produces and prints, per Kotlin production FILE, the raw covered and
total counts - not a percentage, and not a pass/fail threshold, because a
percentage hides which file is at zero and a threshold invites the number
to be gamed.

Alongside the counts it enforces a CLASSIFICATION: every production file
must be listed below as one of

  JVM_EXECUTED     executed by JVM unit tests, and asserted there. The
                   ledger FAILS if such a file shows zero covered lines -
                   that is the check that keeps this table honest.

                   EXECUTION IS DECIDED BY LINE COVERAGE AND NOTHING ELSE.
                   Not by whether some test file imports the class, not by
                   whether a name appears in a reference analysis: those
                   say a file COULD have run. Only the JaCoCo LINE counter
                   says it DID. A file whose report entry is absent, or
                   present with zero covered lines, fails here even if
                   every test in the repository mentions it.

  ANDROID_ONLY     cannot run off a device (Activity, Application,
                   platform preferences). Executed by instrumentation
                   instead; the reason names where.
  BUILD_ONLY       wiring with no behaviour of its own to assert.
  DECLARATION_ONLY declares and does not do: an interface, whose compiled
                   form contains no method with a body, so there is no
                   executable line in it for any test to cover.

                   THIS IS THE ONE CLASSIFICATION THAT IS NOT TAKEN ON
                   TRUST, because "there is nothing to cover" is exactly
                   what a file with untested code would like to claim. It
                   is checked three ways on every run, and any one of them
                   failing fails the ledger:

                     the report   must attribute ZERO lines to the file.
                                  One executable line and the claim is
                                  false.
                     the source   must declare no body at all - checked
                                  lexically, with comments and strings
                                  stripped: no '=', nothing opening a body
                                  inside another body, and nothing at file
                                  level except package, import and an
                                  interface declaration.
                     the bytecode must contain no method with a Code
                                  attribute, read with javap out of the
                                  class files of THE SAME VARIANT the
                                  report measured, and each class checked
                                  to have been compiled from this very
                                  source file.

                   It is never counted as covered: nought of nought is
                   what it contributes to the totals, and it is listed
                   under its own heading so it cannot be read as a pass.
                   If javap is unavailable or no class file is found, that
                   is a FAILURE - an unverifiable claim is not a verified
                   one.
  UNMEASURED       genuinely not measured, with the exact reason and what
                   it would take.

A file in the tree but not in the table fails. A file in the table but not
in the tree fails. So a new Kotlin file cannot join the product without a
deliberate decision recorded here.

WHY THERE IS NO INSTRUMENTATION COVERAGE COLUMN. Instrumentation coverage
requires enableAndroidTestCoverage, which OFFLINE-INSTRUMENTS the APK under
test. androidTest in this project targets the RELEASE variant on purpose
(the debug APK carries no JS bundle), so switching that on would instrument
the very artifact whose 16 KB alignment, DEX contents, signing and size
this campaign asserts - measuring it would invalidate the evidence it came
with. Recorded as an irreducible conflict rather than a number nobody can
trust; the per-file instrumentation column is UNMEASURED for that reason
and the reason is the same for every row.

Usage:  kotlin-coverage-ledger.py <jacoco-report.xml>
                                 [--source-root DIR] [--class-root DIR]
        kotlin-coverage-ledger.py --self-test

NOT VERIFIED ON REAL HARDWARE.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ElementTree

JVM_EXECUTED = "JVM_EXECUTED"
ANDROID_ONLY = "ANDROID_ONLY"
BUILD_ONLY = "BUILD_ONLY"
DECLARATION_ONLY = "DECLARATION_ONLY"
UNMEASURED = "UNMEASURED"

# The report this ledger reads is the DEBUG unit-test coverage report, so
# the bytecode a DECLARATION_ONLY claim is checked against has to be the
# debug bytecode. Checking a different variant's classes would be checking
# a different compilation than the one that produced the zero.
DEFAULT_CLASS_ROOT = "android/app/build/tmp/kotlin-classes/debug"

# What may appear at file level in a declaration-only file, besides package
# and import lines. Deliberately short: `class`, `object`, `enum class`, a
# top-level `fun` and a top-level `val` are all absent from it because all
# of them can carry executable code.
DECLARATION_KEYWORDS = ("interface ", "annotation class ")

# file -> (classification, reason). Reasons are required for everything
# that is not JVM_EXECUTED, and are checked for length so "n/a" cannot pass.
CLASSIFICATION: dict[str, tuple[str, str]] = {
    "com/fpvarbcon/MainActivity.kt": (
        ANDROID_ONLY,
        "An Activity cannot be constructed off a device. Executed and asserted by "
        "MainActivityLifecycleTest and LifecycleCampaignTest: creation, recreation, "
        "rotation, font scale and the fragment-factory behaviour on restore.",
    ),
    "com/fpvarbcon/MainApplication.kt": (
        ANDROID_ONLY,
        "Application.onCreate runs only when the platform starts the process. Its one "
        "decision - applying the Arabic layout direction before React Native loads - is "
        "asserted by DutchLayoutDirectionTest and by verify-rtl-cold-launch.sh on a "
        "genuinely fresh install.",
    ),
    "com/fpvarbcon/RtlBootstrap.kt": (
        ANDROID_ONLY,
        "Writes React Native's own SharedPreferences through I18nUtil, which needs a real "
        "Context. Executed by DutchLayoutDirectionTest, LocalDataSurvivalTest, "
        "LifecycleCampaignTest and ResourceGrowthCampaignTest.",
    ),
    "com/fpvarbcon/transport/DfuControlChannel.kt": (
        DECLARATION_ONLY,
        "An internal interface of three abstract functions - controlTransfer, "
        "isSameDeviceAttached, sleep - with no body anywhere in the file, so the compiler "
        "emits no method with a Code attribute and there is no executable line to cover. "
        "It was classified JVM_EXECUTED, and run 34780928743 showed the report attributing "
        "0/0 lines to it, which that classification correctly refuses to accept. The "
        "BEHAVIOUR the interface describes is executed: DfuWorkerSequenceTest implements it "
        "as ScriptedDfuDevice and drives both the read-unprotect and the exit sequence "
        "through it, and DfuUnprotectWorker.kt and DfuExitWorker.kt are JVM_EXECUTED above "
        "with 39/65 and 36/54 lines. This entry "
        "is verified on every run against the source and against the debug bytecode - see "
        "the DECLARATION_ONLY section of the header - and contributes nought of nought to "
        "the coverage totals.",
    ),
    "com/fpvarbcon/transport/DfuExitWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuFlashWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuMemoryLayout.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuUnprotectWorker.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/DfuUsbDescriptors.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/FirmwareSaveVerification.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/IntelHexFirmware.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialConfigurationMapper.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialOpenSequence.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/SerialReadLoop.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbBoundedAttempt.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbConnectionHandle.kt": (
        DECLARATION_ONLY,
        "A one-method internal interface - close() - with no body, so the compiler emits no "
        "method carrying a Code attribute and there is no executable line in it to cover. It "
        "exists because run 34785383699 disassembled android.hardware.usb.UsbDeviceConnection "
        "out of the only jar on the runner carrying it and found a package-private constructor "
        "whose body throws RuntimeException(\"Stub!\"), close() doing the same, and sixteen "
        "references to that marker in the class. UsbDeviceConnectionStubTest asserts that "
        "measurement on every run, in the unit-test JVM, with the ClassLoader and code source "
        "printed - so if it ever stops being true this interface is deleted rather than "
        "outliving its reason. The BEHAVIOUR is not here: UsbSerialSession kept every decision "
        "and UsbSerialSessionTest drives the real class through it.",
    ),
    "com/fpvarbcon/transport/UsbDeviceIdentity.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbHotplugMonitor.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbIoExecutor.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPermissionRequestCoordinator.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPermissionRequester.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPermissionWait.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbPromiseSettleOnce.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialDeviceEnumerator.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialDriverType.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialReadRegistry.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSession.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSessionLifecycle.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialSessionRegistry.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbSerialTransportModule.kt": (
        ANDROID_ONLY,
        "The TurboModule itself. Constructing it needs a ReactApplicationContext and the "
        "generated Codegen spec, so no JVM test can reach it - but a device can, and does: "
        "ReactHostCampaignTest builds it on the real React host and drives construction, "
        "enumeration with nothing attached, refusal of an unknown session, closeSession, "
        "invalidate(), and twelve build/teardown cycles measured for thread and descriptor "
        "growth. Its remaining entry points - open, permission, read, write, DFU, hotplug - "
        "are REAL_HARDWARE_REQUIRED and are named one by one in that file. Every DECISION "
        "it makes has additionally been lifted into the JVM-executed files above.",
    ),
    "com/fpvarbcon/transport/UsbSerialTransportPackage.kt": (
        BUILD_ONLY,
        "Registers the module with React Native and returns it. There is no branch and no "
        "state; if it were wrong nothing in the application would load at all, which "
        "every instrumentation test that reaches a screen already demonstrates.",
    ),
    "com/fpvarbcon/transport/UsbSerialWriteQueue.kt": (JVM_EXECUTED, ""),
    "com/fpvarbcon/transport/UsbTransportException.kt": (JVM_EXECUTED, ""),
}

MINIMUM_REASON_LENGTH = 40


def production_files(source_root: str) -> set[str]:
    found: set[str] = set()
    for directory, _subdirectories, names in os.walk(source_root):
        for name in names:
            if not name.endswith(".kt"):
                continue
            path = os.path.join(directory, name)
            found.add(os.path.relpath(path, source_root).replace(os.sep, "/"))
    return found


def strip_comments_and_strings(source: str) -> str:
    """
    The source with every comment and every string literal blanked out,
    newlines kept so line numbers still mean something.

    Needed because the lexical check below looks for '=' and for braces,
    and this file's own KDoc is full of prose that contains both. A check
    that read the comments would report the documentation.

    Kotlin block comments nest, so they are counted rather than matched.
    """
    out: list[str] = []
    index = 0
    end = len(source)
    nesting = 0
    while index < end:
        character = source[index]
        if nesting > 0:
            if source.startswith("/*", index):
                nesting += 1
                index += 2
                continue
            if source.startswith("*/", index):
                nesting -= 1
                index += 2
                continue
            if character == "\n":
                out.append("\n")
            index += 1
            continue
        if source.startswith("/*", index):
            nesting = 1
            index += 2
            continue
        if source.startswith("//", index):
            while index < end and source[index] != "\n":
                index += 1
            continue
        if source.startswith('"""', index):
            index += 3
            while index < end and not source.startswith('"""', index):
                if source[index] == "\n":
                    out.append("\n")
                index += 1
            index += 3
            continue
        if character in ('"', "'"):
            quote = character
            index += 1
            while index < end and source[index] != quote:
                if source[index] == "\\":
                    index += 1
                index += 1
            index += 1
            continue
        out.append(character)
        index += 1
    return "".join(out)


def declaration_only_source_problems(name: str, path: str) -> list[str]:
    """
    Whether the SOURCE declares anything that could execute.

    Lexical on purpose, and strict on purpose. Three rules, with comments
    and strings already removed:

      no '='            an expression body, a property initialiser and a
                        default argument value are all written with one,
                        and all three compile to a method with code.
      never two bodies  a '{' while another '{' is open is a function
                        body, an accessor, an init block or a nested type
                        - none of which a declaration-only file has.
      file level is     only package, import and an interface or
      declarations      annotation-class declaration may appear outside
                        the one body.

    A file that IS declaration-only in some shape these rules do not
    allow - two interfaces, or a nested one - fails here. That is the
    intended direction: the category then cannot be claimed for it until
    the rule is widened deliberately, rather than the rule quietly
    accepting a shape nobody checked.
    """
    problems: list[str] = []
    try:
        with open(path, encoding="utf-8") as handle:
            stripped = strip_comments_and_strings(handle.read())
    except OSError as error:
        return [
            f"{name} is classified {DECLARATION_ONLY} and its source could not be read "
            f"({error}), so the claim cannot be checked"
        ]

    declarations = 0
    depth = 0
    for number, line in enumerate(stripped.splitlines(), start=1):
        text = line.strip()
        if depth == 0 and text and not text.startswith(("package ", "import ")):
            if any(keyword in text for keyword in DECLARATION_KEYWORDS):
                declarations += 1
            else:
                problems.append(
                    f"{name} is classified {DECLARATION_ONLY} but line {number} is at file "
                    f"level and is neither a package/import nor an interface declaration: "
                    f"{text!r}"
                )
        if "=" in text:
            problems.append(
                f"{name} is classified {DECLARATION_ONLY} but line {number} contains '=', "
                f"which is how an expression body, a property initialiser and a default "
                f"argument value are all written: {text!r}"
            )
        for character in line:
            if character == "{":
                depth += 1
                if depth > 1:
                    problems.append(
                        f"{name} is classified {DECLARATION_ONLY} but line {number} opens a "
                        f"body inside another body, which is a function body, an accessor, "
                        f"an init block or a nested type: {text!r}"
                    )
            elif character == "}":
                depth -= 1
    if depth != 0:
        problems.append(
            f"{name} is classified {DECLARATION_ONLY} but its braces do not balance "
            f"({depth:+d}), so the lexical check cannot be trusted about it"
        )
    if declarations == 0:
        problems.append(
            f"{name} is classified {DECLARATION_ONLY} but declares no interface or "
            f"annotation class at all"
        )
    return problems


def javap_tool() -> str | None:
    """javap out of JAVA_HOME first, because that is the JDK the build used."""
    java_home = os.environ.get("JAVA_HOME", "")
    if java_home:
        candidate = os.path.join(java_home, "bin", "javap")
        if os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("javap")


def compiled_classes(name: str, class_root: str) -> list[str]:
    """
    Every class file in the file's own package that can only have come
    from it: the type itself, its nested types, and the file facade Kotlin
    generates for top-level declarations. Two files in ONE package cannot
    produce the same class name - that is a compile error - so matching on
    the name inside the package is exact, and each match's SourceFile
    attribute is checked as well.
    """
    package = os.path.dirname(name)
    # splitext, not a ".kt" suffix: the self-test drives this with .java
    # sources, and a checker that only understood one extension would have
    # its harder half silently finding nothing.
    base = os.path.splitext(os.path.basename(name))[0]
    directory = os.path.join(class_root, package) if package else class_root
    if not os.path.isdir(directory):
        return []
    found: list[str] = []
    for entry in sorted(os.listdir(directory)):
        if not entry.endswith(".class"):
            continue
        stem = entry[: -len(".class")]
        if stem in (base, base + "Kt") or stem.startswith((base + "$", base + "Kt$")):
            found.append(os.path.join(directory, entry))
    return found


def javap_facts(javap: str, paths: list[str]) -> tuple[dict[str, dict], list[str]]:
    """
    {class file -> {"source": the SourceFile it was compiled from or None,
                    "code": how many methods carry a Code attribute,
                    "members": how many members javap listed}}

    javap -v prints `Compiled from "X.kt"` once per class file and an
    indented `Code:` for every method that has one. An abstract method has
    none, which is the whole point: no Code attribute means there is
    nothing for a coverage tool to count.
    """
    command = [javap, "-p", "-v", *paths]
    try:
        finished = subprocess.run(
            command, capture_output=True, text=True, check=False, timeout=180
        )
    except (OSError, subprocess.SubprocessError) as error:
        return {}, [f"javap could not be run ({error}), so the bytecode cannot be checked"]
    if finished.returncode != 0:
        return {}, [
            f"javap exited {finished.returncode} on {len(paths)} class file(s), so the "
            f"bytecode cannot be checked: {finished.stderr.strip()[:400]}"
        ]

    facts: dict[str, dict] = {}
    current: dict | None = None
    for line in finished.stdout.splitlines():
        text = line.strip()
        if text.startswith("Classfile "):
            path = text[len("Classfile ") :].strip()
            current = {"source": None, "code": 0, "members": 0}
            facts[path] = current
            continue
        if current is None:
            continue
        if text.startswith("Compiled from "):
            current["source"] = text[len("Compiled from ") :].strip().strip('"')
        elif text == "Code:":
            current["code"] += 1
        elif text.startswith("descriptor: "):
            current["members"] += 1
    return facts, []


def declaration_only_bytecode_problems(
    name: str, class_root: str
) -> tuple[list[str], list[str]]:
    """
    Whether the COMPILED form of the file contains any executable method.

    Returns (problems, evidence). The evidence is printed and carried in
    the verdict file whether or not anything is wrong, because "no
    problems" from a check nobody can see the working of is the same shape
    as a check that did not run.
    """
    javap = javap_tool()
    if javap is None:
        return (
            [
                f"{name} is classified {DECLARATION_ONLY} and there is no javap in JAVA_HOME "
                f"or on PATH, so the claim cannot be verified. An unverifiable claim fails."
            ],
            [],
        )
    paths = compiled_classes(name, class_root)
    if not paths:
        return (
            [
                f"{name} is classified {DECLARATION_ONLY} but no class file for it was found "
                f"under {class_root}, so the claim cannot be verified. Either the file was "
                f"not compiled into the measured variant or the class root is wrong; both "
                f"fail rather than pass."
            ],
            [],
        )

    facts, problems = javap_facts(javap, paths)
    evidence: list[str] = []
    expected = os.path.basename(name)
    for path in sorted(facts):
        fact = facts[path]
        evidence.append(
            f"declaration-only: {name} -> {os.path.basename(path)} compiled from "
            f"{fact['source']!r}, {fact['members']} member(s), {fact['code']} with a Code "
            f"attribute"
        )
        if fact["source"] != expected:
            problems.append(
                f"{name} is classified {DECLARATION_ONLY} and {path} was compiled from "
                f"{fact['source']!r}, not from {expected!r} - it was matched by name and "
                f"does not belong to this file"
            )
        if fact["code"] > 0:
            problems.append(
                f"{name} is classified {DECLARATION_ONLY} but {path} carries "
                f"{fact['code']} method(s) with a Code attribute, so it does contain "
                f"executable instructions"
            )
    return problems, evidence


def _counters_of(element) -> dict[str, tuple[int, int]]:
    per_type: dict[str, tuple[int, int]] = {}
    for counter in element.findall("counter"):
        missed = int(counter.get("missed", "0"))
        covered = int(counter.get("covered", "0"))
        per_type[counter.get("type", "?")] = (covered, covered + missed)
    return per_type


def inventory(report: str) -> list[tuple[str, str, str, dict[str, tuple[int, int]]]]:
    """
    EVERYTHING THE REPORT ACTUALLY CONTAINS, verbatim.

    Returns (package/@name, sourcefile name, where it came from, counters)
    with the package and file names exactly as written in the XML, because
    a mismatch between the tree and the report has to be readable as two
    strings side by side. Run 34418366288 failed this ledger with no way to
    see what the report held, and a coverage finding that cannot be
    distinguished from a parser bug is not a finding.

    TWO SHAPES ARE READ. A JaCoCo XML report normally carries a <sourcefile>
    per file. When the report task is given class files but no source
    directories it carries only <class> elements, each naming its
    @sourcefilename. Both are valid reports of the same execution, so both
    are read - and which one a row came from is printed, so the answer is
    never "the parser silently found something somewhere".
    """
    tree = ElementTree.parse(report)
    rows: list[tuple[str, str, str, dict[str, tuple[int, int]]]] = []
    for package in tree.getroot().iter("package"):
        package_name = package.get("name", "")
        sourcefiles = package.findall("sourcefile")
        for sourcefile in sourcefiles:
            rows.append(
                (package_name, sourcefile.get("name", ""), "sourcefile", _counters_of(sourcefile))
            )
        if sourcefiles:
            continue
        # No <sourcefile> in this package: fall back to its classes, summed
        # per source file so a file with several classes is counted once.
        per_file: dict[str, dict[str, tuple[int, int]]] = {}
        for klass in package.findall("class"):
            name = klass.get("sourcefilename", "")
            if not name:
                continue
            target = per_file.setdefault(name, {})
            for kind, (covered, total) in _counters_of(klass).items():
                before = target.get(kind, (0, 0))
                target[kind] = (before[0] + covered, before[1] + total)
        for name, per_type in per_file.items():
            rows.append((package_name, name, "class/@sourcefilename", per_type))
    return rows


def counters(report: str) -> dict[str, dict[str, tuple[int, int]]]:
    """
    {source file NAME -> {counter type -> (covered, total)}}.

    Keyed on the bare file name rather than package/name on purpose. The
    package attribute's separator is a detail of whoever wrote the report -
    JaCoCo's own XML uses slashes, other producers use dots - and getting
    that wrong makes every file look absent, which is a parser bug wearing
    the costume of a coverage finding. File names are checked for
    uniqueness before this is used, so the shortcut cannot silently merge
    two files.
    """
    result: dict[str, dict[str, tuple[int, int]]] = {}
    for _package, name, _origin, per_type in inventory(report):
        # A file can appear once per package if two packages share a
        # name; sum rather than overwrite.
        if name in result:
            for kind, (covered, total) in per_type.items():
                before = result[name].get(kind, (0, 0))
                result[name][kind] = (before[0] + covered, before[1] + total)
        else:
            result[name] = dict(per_type)
    return result


SOURCE_CONTROLS: list[tuple[str, bool, str]] = [
    (
        "an interface of abstract members, with braces and an '=' inside its comments",
        True,
        '''package com.example

/**
 * A comment with braces { } and an equals = sign and a "quoted string {".
 */
// Another = one { here
internal interface Channel {
  fun transfer(
    request: Int,
    buffer: ByteArray?,
  ): Int

  fun attached(): Boolean
  val name: String
}
''',
    ),
    (
        "an interface with one default method body",
        False,
        """package com.example

interface Channel {
  fun attached(): Boolean

  fun describe(): String {
    return "channel"
  }
}
""",
    ),
    (
        "an interface member with an expression body",
        False,
        """package com.example

interface Channel {
  fun attached(): Boolean
  fun twice(value: Int): Int = value * 2
}
""",
    ),
    (
        "an interface method with a default argument value",
        False,
        """package com.example

interface Channel {
  fun transfer(timeoutMs: Int = 500): Int
}
""",
    ),
    (
        "a file with a top-level function",
        False,
        """package com.example

interface Channel {
  fun attached(): Boolean
}

fun helper(value: Int): Int = value
""",
    ),
    (
        "a file with a top-level property",
        False,
        """package com.example

val TIMEOUT = 500

interface Channel {
  fun attached(): Boolean
}
""",
    ),
    (
        "a file that declares an object rather than an interface",
        False,
        """package com.example

object Channel {
  fun attached(): Boolean = true
}
""",
    ),
    (
        "a file with nothing but a package line",
        False,
        "package com.example\n",
    ),
    (
        "an interface with a nested interface body - declaration-only, but out of rule",
        False,
        """package com.example

interface Outer {
  fun attached(): Boolean

  interface Inner {
    fun nested(): Int
  }
}
""",
    ),
    (
        "an annotation class with no members",
        True,
        """package com.example

annotation class Marker
""",
    ),
]

JAVA_CONTROLS: list[tuple[str, str, str, bool]] = [
    (
        "an interface of abstract methods only",
        "Declaring.java",
        """interface Declaring {
  int transfer(int request);
  boolean attached();
}
""",
        True,
    ),
    (
        "an interface with a default method",
        "WithBody.java",
        """interface WithBody {
  boolean attached();
  default int twice(int value) { return value * 2; }
}
""",
        False,
    ),
    (
        "a class with a constructor and a method",
        "WithClass.java",
        """class WithClass {
  int value;
  WithClass(int value) { this.value = value; }
  int twice() { return value * 2; }
}
""",
        False,
    ),
]


def self_test() -> int:
    """
    THE TWO MECHANICAL CHECKS, DRIVEN AGAINST PLANTED CASES.

    Both halves matter. A checker that rejects everything would pass a
    suite of only-bad cases, and a checker that accepts everything would
    pass a suite of only-good ones, so each leg gets both.

    The bytecode leg is driven against classes compiled HERE, with javac,
    rather than against the project's own classes: a self-test that needed
    a Gradle build to have run could not run at the start of a job, which
    is where it is useful. If javac or javap is missing this FAILS rather
    than skipping - a self-test that quietly drops its harder half is
    worth nothing.
    """
    problems = 0
    print("===== COVERAGE LEDGER SELF-TEST =====")

    with tempfile.TemporaryDirectory() as workspace:
        for label, expected_clean, source in SOURCE_CONTROLS:
            path = os.path.join(workspace, "Planted.kt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(source)
            found = declaration_only_source_problems("planted/Planted.kt", path)
            clean = not found
            verdict = "OK" if clean == expected_clean else "WRONG"
            if clean != expected_clean:
                problems += 1
            print(
                f"  source control: {label} -> "
                f"{'no problem' if clean else f'{len(found)} problem(s)'} [{verdict}]"
            )
            if not clean and verdict == "OK":
                print(f"    first: {found[0]}")
            if not clean and verdict == "WRONG":
                for line in found:
                    print(f"    {line}")

        # A source file that cannot be read at all must be a problem, not
        # silence: an unreadable file is an unverified claim.
        absent = declaration_only_source_problems(
            "planted/Absent.kt", os.path.join(workspace, "does-not-exist.kt")
        )
        if absent:
            print("  source control: a source file that does not exist -> 1 problem(s) [OK]")
        else:
            problems += 1
            print("  source control: a source file that does not exist -> no problem [WRONG]")

    javac = shutil.which("javac") or os.path.join(os.environ.get("JAVA_HOME", ""), "bin", "javac")
    javap = javap_tool()
    if not os.access(javac, os.X_OK) or javap is None:
        print(
            "  bytecode control: NOT RUN - javac or javap is missing, so the bytecode leg "
            "of this check cannot be self-tested [WRONG]"
        )
        print("problems: 1")
        return 1

    with tempfile.TemporaryDirectory() as workspace:
        classes = os.path.join(workspace, "classes")
        os.makedirs(classes)
        sources = []
        for _label, filename, source, _expected in JAVA_CONTROLS:
            path = os.path.join(workspace, filename)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(source)
            sources.append(path)
        compiled = subprocess.run(
            [javac, "-g", "-d", classes, *sources],
            capture_output=True,
            text=True,
            check=False,
        )
        if compiled.returncode != 0:
            print(f"  bytecode control: NOT RUN - javac failed: {compiled.stderr.strip()}")
            print("problems: 1")
            return 1

        # THE PARSER FIRST. Everything the policy decides rests on reading
        # javap correctly, so the facts it extracts are asserted directly.
        for label, filename, _source, expected_clean in JAVA_CONTROLS:
            stem = filename[: -len(".java")]
            paths = compiled_classes(f"{stem}.java", classes)
            if not paths:
                problems += 1
                print(f"  bytecode control: {label} -> no class file found [WRONG]")
                continue
            facts, tool_problems = javap_facts(javap, paths)
            if tool_problems:
                problems += 1
                print(f"  bytecode control: {label} -> javap problem: {tool_problems[0]} [WRONG]")
                continue
            fact = next(iter(facts.values()))
            has_code = fact["code"] > 0
            source_ok = fact["source"] == filename
            correct = (not has_code) == expected_clean and source_ok
            if not correct:
                problems += 1
            print(
                f"  bytecode control: {label} -> compiled from {fact['source']!r}, "
                f"{fact['members']} member(s), {fact['code']} with code "
                f"[{'OK' if correct else 'WRONG'}]"
            )

            # And the policy, fed by that parser.
            found, evidence = declaration_only_bytecode_problems(f"{stem}.java", classes)
            clean = not found
            correct = clean == expected_clean and len(evidence) == len(paths)
            if not correct:
                problems += 1
            print(
                f"  bytecode control: {label} through the policy -> "
                f"{'no problem' if clean else f'{len(found)} problem(s)'}, "
                f"{len(evidence)} evidence line(s) [{'OK' if correct else 'WRONG'}]"
            )

        # A class matched by name whose SourceFile is a DIFFERENT file must
        # be rejected: the name match is a shortcut and this is its guard.
        # javac puts a non-public type in whatever file declares it, so
        # Pair.java produces Companion.class compiled from "Pair.java".
        pair = os.path.join(workspace, "Pair.java")
        with open(pair, "w", encoding="utf-8") as handle:
            handle.write("interface Pair { int a(); }\ninterface Companion { int b(); }\n")
        compiled = subprocess.run(
            [javac, "-g", "-d", classes, pair], capture_output=True, text=True, check=False
        )
        if compiled.returncode != 0:
            problems += 1
            print("  bytecode control: two types in one file -> javac failed [WRONG]")
        else:
            found, _evidence = declaration_only_bytecode_problems("Companion.java", classes)
            wrong_source = any("was compiled from" in problem for problem in found)
            if not wrong_source:
                problems += 1
            print(
                f"  bytecode control: a class whose SourceFile is another file -> "
                f"{len(found)} problem(s), source mismatch named: {wrong_source} "
                f"[{'OK' if wrong_source else 'WRONG'}]"
            )

        # Nothing compiled at all must fail rather than pass silently.
        empty = os.path.join(workspace, "empty")
        os.makedirs(empty)
        found, evidence = declaration_only_bytecode_problems("Declaring.java", empty)
        cannot_verify = bool(found) and not evidence
        if not cannot_verify:
            problems += 1
        print(
            f"  bytecode control: no class file anywhere -> {len(found)} problem(s), "
            f"{len(evidence)} evidence line(s) [{'OK' if cannot_verify else 'WRONG'}]"
        )

    print(f"problems: {problems}")
    return 1 if problems else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) < 2:
        print(
            "usage: kotlin-coverage-ledger.py <jacoco-report.xml> "
            "[--source-root DIR] [--class-root DIR]\n"
            "       kotlin-coverage-ledger.py --self-test"
        )
        return 2
    report = argv[1]
    source_root = "android/app/src/main/java"
    if "--source-root" in argv:
        source_root = argv[argv.index("--source-root") + 1]
    class_root = DEFAULT_CLASS_ROOT
    if "--class-root" in argv:
        class_root = argv[argv.index("--class-root") + 1]

    if not os.path.isfile(report):
        print(f"::error::no JaCoCo report at {report} - the coverage task did not produce one")
        return 1

    tree_files = production_files(source_root)
    table_files = set(CLASSIFICATION)

    missing = sorted(tree_files - table_files)
    extra = sorted(table_files - tree_files)
    if missing or extra:
        for name in missing:
            print(f"::error::{name} is a production Kotlin file with no entry in the ledger")
        for name in extra:
            print(f"::error::{name} is in the ledger but not in the source tree")
        return 1

    basenames = [name.rsplit("/", 1)[-1] for name in tree_files]
    duplicated = sorted({name for name in basenames if basenames.count(name) > 1})
    if duplicated:
        print(
            "::error::two production files share a name, so coverage cannot be attributed "
            f"by name: {duplicated}"
        )
        return 1

    rows = inventory(report)
    measured = counters(report)

    # WHAT THE REPORT HOLDS, PRINTED WHETHER OR NOT ANYTHING IS WRONG.
    # Printing it only on failure means the one run that could have shown
    # a keying problem coming is the one run that did not print it.
    expected_basenames = {name.rsplit("/", 1)[-1]: name for name in tree_files}
    found = sorted(name for name in expected_basenames if name in measured)
    absent = sorted(name for name in expected_basenames if name not in measured)
    zero = sorted(
        name
        for name in found
        if measured[name].get("LINE", (0, 0))[0] == 0
    )
    origins = sorted({origin for _p, _n, origin, _c in rows})

    print("===== UI-X3B NATIVE COVERAGE AND CLASSIFICATION LEDGER =====")
    print(f"  report read                        : {report}")
    print(f"  rows the report contains           : {len(rows)} (from {origins or ['<nothing>']})")
    print(f"  production Kotlin files EXPECTED   : {len(tree_files)}")
    print(f"  of those FOUND in the report       : {len(found)}")
    print(f"  of those MISSING from the report   : {len(absent)}")
    print(f"  of those found with ZERO lines     : {len(zero)}")
    if absent:
        print("  MISSING (expected, not in the report):")
        for name in absent:
            print(f"    {expected_basenames[name]}")
    if zero:
        print("  ZERO covered lines:")
        for name in zero:
            print(f"    {expected_basenames[name]}")
    print("  report inventory, package/@name -> sourcefile/@name:")
    for package_name, name, origin, per_type in sorted(rows, key=lambda row: (row[0], row[1])):
        line = per_type.get("LINE", (0, 0))
        print(f"    {package_name or '<empty>'} -> {name or '<empty>'} "
              f": {line[0]}/{line[1]} [{origin}]")
    print("  instrumentation coverage column    : UNMEASURED for every row (see header)")
    print("-" * 78)
    print(f"  {'FILE':52} {'LINES':>11}  CLASS")

    failures: list[str] = []
    declaration_evidence: list[str] = []
    totals = {"line_covered": 0, "line_total": 0, "branch_covered": 0, "branch_total": 0}
    by_class: dict[str, int] = {}

    for name in sorted(tree_files):
        classification, reason = CLASSIFICATION[name]
        by_class[classification] = by_class.get(classification, 0) + 1

        per_type = measured.get(name.rsplit("/", 1)[-1], {})
        line_covered, line_total = per_type.get("LINE", (0, 0))
        branch_covered, branch_total = per_type.get("BRANCH", (0, 0))
        totals["line_covered"] += line_covered
        totals["line_total"] += line_total
        totals["branch_covered"] += branch_covered
        totals["branch_total"] += branch_total

        print(f"  {name:52} {line_covered:5}/{line_total:<5}  {classification}")

        if classification == JVM_EXECUTED:
            if line_total == 0:
                failures.append(
                    f"{name} is classified {JVM_EXECUTED} but the JaCoCo report has no lines "
                    "for it at all - either it was not compiled into the measured variant or "
                    "the classification is wrong"
                )
            elif line_covered == 0:
                failures.append(
                    f"{name} is classified {JVM_EXECUTED} but zero of its {line_total} lines "
                    "were executed by any JVM unit test"
                )
            continue

        if len(reason.strip()) < MINIMUM_REASON_LENGTH:
            failures.append(
                f"{name} is classified {classification} without a reason of at least "
                f"{MINIMUM_REASON_LENGTH} characters"
            )

        if classification != DECLARATION_ONLY:
            continue

        # THE CLAIM IS "THERE IS NOTHING HERE TO COVER", SO IT IS CHECKED.
        # The report first, because it is the same measurement every other
        # row is judged by: one executable line and the claim is false.
        if line_total != 0:
            failures.append(
                f"{name} is classified {DECLARATION_ONLY} but the report attributes "
                f"{line_total} executable line(s) to it ({line_covered} covered), so it "
                f"does contain code and needs a classification that can fail on coverage"
            )
        source_problems = declaration_only_source_problems(
            name, os.path.join(source_root, name)
        )
        bytecode_problems, bytecode_evidence = declaration_only_bytecode_problems(
            name, class_root
        )
        declaration_evidence.extend(bytecode_evidence)
        for line in bytecode_evidence:
            print(f"  {line}")
        failures.extend(source_problems)
        failures.extend(bytecode_problems)
        if not source_problems and not bytecode_problems and line_total == 0:
            proved = (
                f"declaration-only: {name} verified - report 0/0, source declares no body, "
                f"{len(bytecode_evidence)} class file(s) with no Code attribute"
            )
            declaration_evidence.append(proved)
            print(f"  {proved}")

    print("-" * 78)
    for classification in (
        JVM_EXECUTED,
        ANDROID_ONLY,
        BUILD_ONLY,
        DECLARATION_ONLY,
        UNMEASURED,
    ):
        print(f"  {classification:16} : {by_class.get(classification, 0)}")
    print(
        f"  JVM lines covered / total   : "
        f"{totals['line_covered']}/{totals['line_total']}"
    )
    print(
        f"  JVM branches covered / total: "
        f"{totals['branch_covered']}/{totals['branch_total']}"
    )
    print("=" * 78)

    # The verdict file is re-printed by a later step and carried by the
    # evidence-report job, so the counts go in it too - a verdict that says
    # only "3 problems" sends the reader back to a log they cannot reach.
    verdict: list[str] = [
        f"coverage ledger read {report}",
        f"  rows in report={len(rows)} origins={origins or ['<nothing>']}",
        f"  expected={len(tree_files)} found={len(found)} missing={len(absent)} zero={len(zero)}",
        f"  classified JVM_EXECUTED={by_class.get(JVM_EXECUTED, 0)} "
        f"ANDROID_ONLY={by_class.get(ANDROID_ONLY, 0)} "
        f"BUILD_ONLY={by_class.get(BUILD_ONLY, 0)} "
        f"DECLARATION_ONLY={by_class.get(DECLARATION_ONLY, 0)} "
        f"UNMEASURED={by_class.get(UNMEASURED, 0)}",
        f"  class root for the bytecode check={class_root}",
    ]
    # Carried whether or not anything failed: a verified claim that leaves
    # no trace in the evidence is indistinguishable from a check that was
    # skipped.
    verdict.extend(f"  {line}" for line in declaration_evidence)
    if failures:
        # What the report DOES contain, so a mismatch between the tree and
        # the report is one read away instead of one CI cycle away.
        verdict.append("package/@name -> sourcefile/@name actually present in the report:")
        for package_name, name, origin, per_type in sorted(rows, key=lambda row: (row[0], row[1])):
            line = per_type.get("LINE", (0, 0))
            verdict.append(
                f"  {package_name or '<empty>'} -> {name or '<empty>'} "
                f": {line[0]}/{line[1]} [{origin}]"
            )
        verdict.extend(f"::error::{failure}" for failure in failures)
        verdict.append(f"coverage ledger: {len(failures)} problem(s)")
    else:
        verdict.append(
            "coverage ledger: every production file is classified, every JVM_EXECUTED "
            "file ran, and every DECLARATION_ONLY file was verified to contain no "
            "executable code"
        )

    for line in verdict:
        print(line)

    # Written as well as printed: this step runs in the middle of a long
    # job, and a later step prints this file so the verdict is readable
    # from the end of the log rather than buried under everything that
    # came after it.
    with open(os.environ.get("COVERAGE_VERDICT_FILE", "native-coverage-verdict.txt"), "w") as out:
        out.write("\n".join(verdict) + "\n")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

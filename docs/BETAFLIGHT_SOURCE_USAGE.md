# Betaflight source usage

Betaflight (firmware and Configurator) is this project's **functional and
informational reference**. Its source is read to learn what a flight
controller actually does on the wire; it is never used as a visual
template, and no CSS, layout, colour, icon set, branding or English
wording is taken from it.

This file records the places where something from a Betaflight source is
reused **directly** rather than reimplemented, so that the obligations
that come with it are visible rather than assumed.

## Pinned references

Everything below cites one of these, and nothing else counts as verified.

| Reference | Revision | What it is |
| --- | --- | --- |
| betaflight/betaflight | `7348054f268f0058574719c134e9f149565bb8ea` | **API 1.47** — the only verified 1.47 firmware source |
| betaflight/betaflight | `master` @ `1efac3e` | **API 1.49** — current behaviour, used for comparison |
| betaflight/betaflight-configurator | tag `2026.6.1` (`14a057ffc58417c5128199fc1233284982a64be3`) | the stable reference client |

**API 1.48 is NOT VERIFIED.** No reachable ref declares it, and the
`4.5-maintenance` branch tip declares `API_VERSION_MINOR 46` — it must not
be cited as 1.47.

## Licensing

Betaflight is GPL-3.0. The practical consequence for this project is
recorded here rather than argued: study is unrestricted, and anything
copied verbatim is listed below with what it is and where it came from, so
the question can be answered from this file instead of from a diff. This
is a record, not a legal opinion.

## Direct reuse

### 1. `flightLogFieldSelect_e` member names and order

* **Source:** `src/main/blackbox/blackbox_fielddefs.h` at both pinned
  firmware revisions (identical in each).
* **Where:** `src/core/state/blackboxPresentation.ts` →
  `BLACKBOX_FIELD_BITS`.
* **What is reused:** sixteen identifier strings and, critically, their
  ORDER — because the order *is* the bit assignment in
  `fields_disabled_mask`. There is nothing to reimplement: any other order
  would be wrong.
* **Not reused:** the C declaration, the surrounding types, and the
  polarity handling (a set bit means *disabled*), which this codebase
  states in its own names and converts at its own boundary.

### 2. `debugModeNames[]` — the first 96 entries

* **Source:** `src/main/build/debug.c` at both pinned firmware revisions.
* **Where:** `src/core/state/blackboxPresentation.ts` →
  `NAMED_DEBUG_MODES`.
* **What is reused:** 96 identifier strings in index order. These are the
  values `get debug_mode` prints in the CLI, so showing them to an
  operator is showing their own board's data; translating them would make
  the app disagree with every other tool.
* **Deliberately truncated at 96.** The two verified revisions agree on
  indices 0–95 and DIVERGE at index 96 (1.47: `AUTOPILOT_POSITION`;
  1.49: `CHIRP`). The enum is not append-only, so a longer table would
  confidently mislabel a real board depending on its firmware. Index 96
  and above is reported as an unknown mode carrying its raw number.

## Studied, reimplemented, not copied

The following were read to establish behaviour and then written from
scratch in this codebase's own architecture. No source text was taken.

* MSP payload layouts for `MSP_BLACKBOX_CONFIG` (80),
  `MSP_SET_BLACKBOX_CONFIG` (81), `MSP_DATAFLASH_SUMMARY` (70),
  `MSP_DATAFLASH_ERASE` (72), `MSP_SDCARD_SUMMARY` (79),
  `MSP_ADVANCED_CONFIG` (90) and `MSP_SET_ADVANCED_CONFIG` (91) —
  `src/main/msp/msp.c`.
* The rule that `MSP_SET_BLACKBOX_CONFIG` is silently ignored while
  logging (`blackboxMayEditConfig()`, `src/main/blackbox/blackbox.c`), and
  therefore that every save must read back before persisting.
* `flashfsIsReady()` / `flashfsIsSupported()` semantics
  (`src/main/io/flashfs.c`), and therefore that a supported-but-busy
  volume is neither absent nor empty.
* That SD capacities are written only inside
  `if (state == MSP_SDCARD_STATE_READY)`, and that `freeSpace` comes from
  `afatfs_getContiguousFreeSpace() / 1024` — kibibytes, and *contiguous*
  free space rather than the complement of a used figure.
* That `blackboxEraseAll()` acts only when the configured device is
  `BLACKBOX_DEVICE_FLASH`, and therefore that an erase must be gated on
  the PERSISTED destination rather than a draft.
* `BlackboxDevice_e` and `BlackboxSampleRate_e` value meanings. `VIRTUAL`
  (4) exists on master only and is deliberately not modelled as a
  supported destination.

## Not taken, at all

* No UI file, stylesheet, component or template.
* No English user-facing wording.
* No branding, logo, colour palette or icon.
* The name "Betaflight" appears in the product UI only where it is
  genuinely the flight controller's own data (firmware identity, CLI
  output).

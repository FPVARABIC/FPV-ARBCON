# Pass 7.5B — Pitch / Front Mapping Diagnostic Protocol (TEMPORARY — DO NOT MERGE)

For Ahmed to run manually on real hardware. Not run or automated by
Claude — this document is manual-test documentation only.

## STATUS: DIAGNOSTIC BRANCH ONLY

This protocol belongs to the diagnostic branch
`claude/pass-7.5b-pitch-front-diagnostics` and its APK. **The diagnostic
APK and this document must never be merged into main.** They exist to
gather synchronized hardware evidence that identifies WHICH layer is
responsible for the observed nose-up/nose-down reversal — the eventual
correction will be implemented separately, on a clean branch cut from
Pass 7.5 (`a1603cf`), once this evidence decides the layer.

The Setup screen in this build shows a bordered panel labelled
**"TEMP XYZ DIAGNOSTICS — DO NOT MERGE"** beneath the 3D model, with:

- `RAW R/P/H` — the values decoded straight off the MSP wire (degrees),
  and a second line with the raw decidegree integers.
- `RENDER R/P/Y` — the exact values the 3D model consumes.
- `MODEL FRONT: +X / BLUE PAIR` — the model's own front definition.
- `FRONT ΔX / ΔY / RISE` — where the model's front direction projects on
  screen relative to the model centre. **Screen Y grows downward, so a
  NEGATIVE ΔY means the front point is ABOVE the centre, and a NEGATIVE
  RISE means the current pitch moves the front UP on screen.**
- `AGE / STATUS` — sample age and freshness.

## Safety requirements (mandatory)

- Propellers removed. No arming. No motor operation. No flight.
- USB bench test only; FC/drone on a stable surface.
- Screen recording enabled on the phone for the whole session.
- Phone/camera stationary; a second camera should frame the phone AND
  the physical FC/drone together so values and physical pose appear in
  the same video.
- Attach a large physical **FRONT** marker (tape/label) to the drone/FC
  before starting.

## Before the movement sequence — record these answers

1. Which physical side do you consider the drone's FRONT?
2. Which direction does the FC board's printed arrow point, relative to
   that front?
3. How is the FC installed: arrow forward / arrow backward / rotated
   left / rotated right / upside down?
4. Betaflight board alignment values (CLI `get align_board_roll`,
   `get align_board_pitch`, `get align_board_yaw`, or the Configurator
   Board Alignment fields): record all three.
5. If convenient: does Betaflight Configurator's own 3D model follow the
   physical movements correctly on this same FC?

## Movement sequence

Hold each pose **at least 3 seconds** and say the pose aloud so the
audio anchors the video.

- **TEST 0 — LEVEL REFERENCE.** Level, stationary. Record RAW and RENDER
  R/P/H and FRONT ΔX/ΔY. State which visible side is physical FRONT.
- **TEST 1 — PHYSICAL NOSE UP** (~20–30°, roll ≈0, heading steady). Say
  "PHYSICAL NOSE UP". Capture the panel.
- **TEST 2 — RETURN LEVEL.**
- **TEST 3 — PHYSICAL NOSE DOWN** (~20–30°). Say "PHYSICAL NOSE DOWN".
- **TEST 4 — RETURN LEVEL.**
- **TEST 5 — PHYSICAL RIGHT SIDE DOWN** (pitch ≈0). Say it aloud.
- **TEST 6 — PHYSICAL LEFT SIDE DOWN** (pitch ≈0). Say it aloud.
- **TEST 7 — CLOCKWISE YAW ~90°, viewed from above** (level). Say it.
- **TEST 8 — COUNTERCLOCKWISE YAW ~90°** (return first). Say it.
- **TEST 9 — COMPOUND CONTROL:** nose up ~20° + right side down ~15° +
  yaw ~30°. Hold and state the pose aloud.

## What this test decides (and nothing else)

Evidence gathered: raw pitch sign · renderer pitch sign · front-axis
identity · camera/projection interpretation · secondary roll/yaw signs ·
that Pass 7.5's compound behavior is preserved.

**Do NOT evaluate in this session:** model size, visual polish,
smoothness/interpolation, the reset button, arming status, Region 3 —
all belong to later passes.

## How the evidence will be read (for reference)

- RAW pitch and RENDER pitch showing OPPOSITE signs → a display-layer
  conversion exists (Case A).
- Same sign, but FRONT RISE says the front moves DOWN on screen during
  physical nose-up → geometry/projection layer (Case B).
- Same sign, FRONT RISE correctly negative (front rises), yet it still
  *looks* nose-down → camera/scale visual ambiguity; no sign change
  (Case C).
- FRONT marker vs. board arrow mismatch, or non-zero board alignment →
  physical/board mapping must be resolved first (Case D).
- Mixed/unclear axes during a pose → repeat the pose; no conclusions
  from mixed evidence (Case E).

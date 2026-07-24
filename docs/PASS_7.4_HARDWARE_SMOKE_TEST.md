# Pass 7.4 — Hardware Smoke Test Checklist (Setup Screen, Regions 1+2: Top Bar + Live Orientation)

For Ahmed to run manually on real hardware. Not run or automated by
Claude — this document is manual-test documentation only.

## STATUS: READY TO RUN

Pass 7.4 assembles the real Setup screen from two regions only:

- **Region 1** — the top system bar: the 5-state connection indicator
  (متصل / جارٍ التفعيل / جارٍ استعادة الاتصال / تعذّرت الاستعادة / غير
  متصل), a back button, and a notice banner for the same 4 states plus a
  failed-identification warning.
- **Region 2** — the live 3D orientation hero: a real-time 3D model
  driven by `MSP_ATTITUDE`, plain roll/pitch/heading readouts, a
  "إعادة ضبط عرض الاتجاه" (reset view) button, and its one-time hint.

**Regions 3, 4, and 5 (diagnostics, arming/safety detail, and further
sections) are genuinely absent from this pass — not placeholders, not
partially built.** The compact arming/safety strip visible beneath
Region 2 is Region 1's own arming badge plus a minimal strip, not
Region 4 itself; do not look for anything beyond what is described
above.

All of the telemetry driving this screen is real: a real
`MspTelemetryScheduler` instance, registered automatically once a
session activates, polling `MSP_ATTITUDE` at ~220ms intervals (the
real-hardware ceiling measured in `PASS_7.0_HARDWARE_POLLING_AUDIT.md`).
Nothing in Regions 1–2 is simulated or hand-scripted.

## Prerequisites

- An Android device with the app installed (debug build is fine), same
  as prior hardware passes.
- The real flight controller connected via USB-OTG, powered on, same
  setup as `PASS_6.4B_HARDWARE_SMOKE_TEST.md`/`PASS_7.0_HARDWARE_POLLING_AUDIT.md`.
- No CLI, no Betaflight Configurator running alongside the app on the
  same USB port.

## Test 1 — The ~1 second WAITING delay on first connect is expected, not a fault

**Background:** on every connect, MSP identification
(`MspIdentificationService`) and orientation telemetry both start
automatically, but they share the flight controller's single request/
response slot — identification's own requests (MSP_API_VERSION,
MSP_FC_VARIANT, MSP_BOARD_INFO) run first and occupy that slot before
the first `MSP_ATTITUDE` poll can even be sent. This was found and
confirmed by tracing the real code during this pass's own final review,
not guessed at — it is a genuine, accepted consequence of how
identification and telemetry share one MSP link, not a bug to chase.

**Steps:**
1. Connect to the flight controller from the app's USB connection
   screen.
2. The screen navigates to Setup immediately. Watch Region 2 (the
   orientation area) from the moment it appears.

**Expected result:** Region 2 shows its "waiting for data" state for
roughly one second (matching identification's own known duration, see
`PASS_6.4B_HARDWARE_SMOKE_TEST.md`'s Test 6 metrics line), then the live
3D model and roll/pitch/heading readouts appear and begin updating.

**Fail if:** the wait is dramatically longer than ~1-2 seconds, or
Region 2 never leaves its waiting state despite identification
completing successfully.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 2 — All 5 connection-indicator states are visually distinguishable

**Steps:**
1. **غير متصل (DISCONNECTED):** before connecting, or after an
   intentional disconnect, or after a physical detach — confirm the
   indicator and its label are visually distinct from every other state
   below.
2. **جارٍ التفعيل (ACTIVATING):** this state is expected to be
   effectively unobservable on real hardware — traced explicitly during
   this pass's own review: the transport/client construction and the
   final ACTIVE-state notification happen synchronously with no
   asynchronous gap, so React's own batching collapses them into a
   single render that already shows the final state. **Do not treat a
   failure to ever see this state as a bug** — there is nothing to
   capture here by design; skip this sub-step.
3. **متصل (CONNECTED):** the normal, steady connected state — confirm
   the indicator reads clearly once telemetry is flowing.
4. **جارٍ استعادة الاتصال (RECOVERING):** briefly disturb the USB-OTG
   cable (a light tug/wiggle, not a full unplug) to provoke a
   transient desync without a physical detach — confirm the indicator
   and its notice banner both change to the recovering state, then
   automatically clear once recovery succeeds.
5. **تعذّرت الاستعادة (RECOVERY_FAILED):** harder to provoke
   deliberately on real hardware (needs the automatic recovery's own
   restart step to itself fail) — if it occurs naturally during other
   testing, confirm it is visually distinct from RECOVERING and that its
   notice banner reads differently ("تعذّرت استعادة الاتصال" vs. "جارٍ
   استعادة الاتصال تلقائيًا"). Not a required reproduction if it does not
   occur naturally.

**Expected result:** every state reached is clearly, visually distinct
from every other — color, label text, and (where present) notice banner
all differ.

**Fail if:** two different states look the same, or the indicator/label
does not update promptly when the underlying connection state changes.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 3 — The 3D drone model renders and rotates correctly on real attitude data

**Steps:**
1. With the connection live and Region 2 showing live data, gently tilt
   the flight controller left and right (roll).
2. Gently tilt the nose up and down (pitch).
3. Slowly rotate the flight controller around its vertical axis
   (yaw/heading), if practical to do while connected.
4. Throughout, observe both the 3D model and the plain roll/pitch/
   heading numeric readouts beneath it.

**Expected result:**
- The 3D model's rotation visibly tracks the physical motion in real
  time, with no perceptible lag beyond the ~220ms poll interval.
- The model's front is marked blue and the rear red, both clearly
  visible and consistently oriented as the model rotates.
- The nose arrow points in the direction matching the FC's actual
  forward-facing orientation as it is physically rotated.
- The numeric readouts change in the same direction and in rough
  agreement with the 3D model's own visible pose at all times (per this
  pass's own design, both are driven by the same underlying values —
  see `orientationViewModel.ts`).

**Fail if:** the model does not rotate, rotates in the wrong direction
relative to the physical motion, front/rear coloring is missing or
swapped, or the numeric readouts disagree with the 3D model's visible
pose.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 4 — STALE freezing on a real physical detach, and recovery on reconnect

**Steps:**
1. With the connection live and Region 2 showing live data, physically
   unplug the USB-OTG cable.
2. Watch Region 2 for the roughly 700ms window immediately after the
   detach (before the screen's own disconnected handling takes over).
3. Reconnect the flight controller and observe Region 2 again.

**Expected result:**
- Briefly, before the screen fully reflects the disconnect, Region 2
  dims and shows "البيانات متأخرة" while the 3D model and readouts stay
  frozen at their last live values — they must NOT continue animating,
  interpolating, or resetting to a default/zero pose during this window.
- On reconnect, Region 2 returns to its normal WAITING-then-LIVE
  sequence (per Test 1) and resumes tracking real motion correctly.

**Fail if:** the model keeps moving/animating after data has genuinely
stopped arriving, snaps to a default pose instead of freezing, or fails
to resume live tracking cleanly after reconnect.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 5 — Reset-view-offset button and its one-time hint

**Steps:**
1. With Region 2 showing live data, note the current roll/pitch/heading
   readouts while the flight controller is held in some non-level,
   non-zero-heading position.
2. Press "إعادة ضبط عرض الاتجاه" (reset view).
3. Without moving the flight controller, observe the 3D model and
   readouts immediately after the press.
4. Note whether a one-time hint bubble appears, and read its text.
5. Press the reset button a second time (same physical position).

**Expected result:**
- After the first press, the 3D model and readouts update to show the
  CURRENT physical orientation as the new "zero" reference — i.e. if the
  FC was held tilted before the press, it now reads level/zero-heading
  immediately after, with no physical movement required.
- A hint bubble appears on this first press only, explaining that this
  resets the ON-SCREEN VIEW only and does not calibrate the flight
  controller's own sensors — confirm the wording does not imply an
  actual FC calibration/trim command was sent.
- On the second press (step 5), the hint bubble does NOT reappear.

**Fail if:** the view does not actually re-zero to the current physical
position, the hint never appears on the first press, the hint reappears
on a later press, or the hint's wording is ambiguous about not touching
FC calibration.

- [ ] Pass / [ ] Fail — notes: ______________________

## Summary

| Test | Result |
|---|---|
| 1. ~1s WAITING delay on first connect (expected, not a fault) | |
| 2. All 5 connection-indicator states are visually distinguishable | |
| 3. 3D drone model renders and rotates correctly on real attitude data | |
| 4. STALE freezing on physical detach, and recovery on reconnect | |
| 5. Reset-view-offset button and its one-time hint | |

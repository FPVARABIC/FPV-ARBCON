# Pass 7.0 — Hardware Polling-Capacity Audit (MSP_ATTITUDE)

For Ahmed to run manually on real hardware. Not run or automated by
Claude — this document is manual-test documentation only.

## STATUS: MEASUREMENT ONLY — NO PASS/FAIL CRITERIA

Unlike `PASS_6.4B_HARDWARE_SMOKE_TEST.md`, this is not a correctness
check. Nothing here can "fail" in the sense of a bug — the goal is
purely to find out how many `MSP_ATTITUDE` request/response round trips
the real flight controller and USB link can sustain back-to-back, so a
later pass (`MspTelemetryScheduler`/`MspOperationCoordinator` — **not**
built in this pass) can be designed against real numbers instead of
guesses. Record whatever the numbers actually are, including a
disappointing or surprising result — that is exactly the kind of finding
this pass exists to surface.

**A real desync/recovery event happening during the run is expected
occasionally, not a problem.** If you see one, it is valuable data —
record it (see Step 4 below), do not treat it as something to avoid or
retry past.

## What this adds (background, not required reading to run the test)

- `MSP_ATTITUDE` (command 108) is now a permanent, verified decoder
  (`decodeAttitude.ts`) — real infrastructure, not removed after this
  pass.
- A **temporary** debug-panel section — a single button, "تشغيل قياس
  السعة" ("Run capacity measurement") — fires up to 100 back-to-back
  `MSP_ATTITUDE` requests (or stops after 15 seconds, whichever comes
  first), respecting the app's existing automatic desync/recovery
  handling rather than fighting it. This section (and the measurement
  code behind it) will be deleted once this pass's findings are recorded
  and acted on — it is not part of the permanent app.

## Prerequisites

- An Android device with the app installed (debug build is fine), same
  as `PASS_6.4B_HARDWARE_SMOKE_TEST.md`.
- The real Betaflight STM32F405 flight controller connected via USB-OTG,
  powered on, same setup as previous hardware passes.
- The temporary debug panel (`UsbSerialDebugPanel.tsx`) still present and
  reachable while connected.
- Nothing else needed — no CLI, no Betaflight Configurator running
  alongside the app on the same USB port (that would compete for the
  connection).

## Step 1 — Connect and let identification finish first

1. Connect to the flight controller from the app's USB connection
   screen, exactly as in every previous hardware pass.
2. Wait for identification to finish (the firmware/board block appears —
   see `PASS_6.4B_HARDWARE_SMOKE_TEST.md`'s Test 6 if this is
   unfamiliar). Not strictly required before running the measurement,
   but keeps the two activities from overlapping and makes the
   measurement's own numbers easier to interpret on their own.

## Step 2 — Run the capacity measurement

1. Scroll to the new section in the debug panel, marked
   **"⚠ قياس مؤقت (Pass 7.0) - سعة الاستقصاء (MSP_ATTITUDE)"**.
2. Press **"تشغيل قياس السعة"** ("Run capacity measurement").
3. Wait for it to finish — the button will read "جارٍ القياس…"
   ("Measuring...") while running, up to 15 seconds.
4. Once it stops, a results line appears below the button.

## Step 3 — Record the results line

The results line looks like:

```
attempted=<N> success=<N> error=<N> minRtt=<N>ms maxRtt=<N>ms
avgRtt=<N>ms medianRtt=<N>ms rate=<N>/s recoveryCycles=<N>
nonReadyMs=<N> glitches=<N>
```

Record every field exactly as shown, in the table at the bottom of this
document. In particular:

- **attempted / success / error** — how many `MSP_ATTITUDE` requests
  were actually sent, and how many succeeded vs. genuinely failed (a
  genuine failure is a real per-request error — a timeout, a remote
  error frame — not merely "the client was busy recovering," which is
  tracked separately as `recoveryCycles`/`nonReadyMs` below).
- **minRtt / maxRtt / avgRtt / medianRtt** — round-trip time in
  milliseconds for each successful request. This is the core number this
  pass exists to measure — how fast is a single `MSP_ATTITUDE` round
  trip on real hardware, sustained, not just once.
- **rate** — successful requests per second, over the actual elapsed
  time of the whole run (so a run that spent time recovering from a
  desync will show a lower rate — that is intentional, it is the
  *achieved*, real-world rate, not a best-case number).
- **recoveryCycles** — how many times, during the run, the client
  detected it was not `READY` (a desync/recovery cycle in progress) and
  paused rather than firing a new request. **0 is a normal, good
  result** — it means the link stayed clean for the whole run. A nonzero
  number is not a failure either — see the note below.
- **nonReadyMs** — total time, in milliseconds, spent waiting during any
  such recovery cycles. Combined with `recoveryCycles`, this tells us how
  disruptive a real desync is to sustained polling in practice.
- **glitches** — how many decoded roll/pitch/yaw readings looked
  physically implausible (either outright out of range, or a suspiciously
  large jump from the previous reading). **0 is expected** if the FC was
  sitting still on the bench; a nonzero count while the FC was genuinely
  being moved during the run is not meaningful (real physical motion can
  look like a "jump") — only note it if the FC was stationary the whole
  time and this is still nonzero, which would suggest frame corruption or
  misparsing worth investigating separately.

## Step 4 — If you noticed anything unusual

- If the debug log (the normal scrolling log at the bottom of the panel,
  same as every other pass) shows any `RX (MSP)` activity you don't
  recognize during the run, or the connection screen's state changed
  unexpectedly, note roughly when (which line in the debug log) relative
  to the run.
- If `recoveryCycles` is nonzero, that means a real desync happened
  during the run — this is expected occasionally, not a bug. Just note
  it happened; no further action needed on your end.
- If the app became unresponsive, crashed, or the button never finished
  (stuck on "جارٍ القياس…" for much longer than 15 seconds), that IS
  worth flagging clearly as its own finding — note what you were doing
  right before it happened.

## Step 5 (optional) — Run it again

If you have time, running the measurement 2–3 times back-to-back (a
fresh press of the button each time, no need to reconnect in between) is
useful — it tells us whether the numbers are consistent run-to-run or
vary a lot, which matters for how conservative the eventual polling
design needs to be. Record each run as its own row below.

## Results

| Run | attempted | success | error | minRtt | maxRtt | avgRtt | medianRtt | rate/s | recoveryCycles | nonReadyMs | glitches | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | | | |
| 2 | | | | | | | | | | | | |
| 3 | | | | | | | | | | | | |

**Anything unusual observed (Step 4):** ______________________

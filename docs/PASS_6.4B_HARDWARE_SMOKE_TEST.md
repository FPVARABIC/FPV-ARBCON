# Pass 6.4b — Hardware Smoke Test Checklist (RNMspTransport + MspSessionCoordinator + MSP Identification)

For Ahmed to run manually on real hardware. Not run or automated by
Claude — this document is manual-test documentation only.

## STATUS: READY TO RUN

Renamed from `PASS_6.3_HARDWARE_SMOKE_TEST.md`. Pass 6.3 built
`RNMspTransport` and `MspSessionCoordinator` and fully unit-tested them
(Jest, with fake/mocked transports), but deliberately left them unwired
from any real session — `UsbConnectionScreen.tsx`'s `handleConnect()`/
`handleDisconnect()` never called `mspSessionCoordinator.openSession()`/
`.closeSession()`, and `UsbSerialDebugPanel`'s `mspActive` prop was
hardcoded to `false`. That is what blocked every test below.

**Pass 6.4b removes that block.** `handleConnect()` now calls
`mspSessionCoordinator.openSession(client, sessionId)` immediately after
a successful `openDevice()`, and `handleDisconnect()` calls
`mspSessionCoordinator.deactivateMspSession(sessionId)` before dispatching
`DISCONNECT_SUCCESS` — see `UsbConnectionScreen.tsx`'s own Pass 6.4b
comments at both call sites. `mspActive` is now a real, reactive value
(`useMspOwnershipState()`), so `UsbSerialDebugPanel` genuinely goes
MSP-active on every real connect. Pass 6.4a additionally added
`MspIdentificationService`, and Pass 6.4b wires it to run automatically,
fire-and-forget, the moment a session activates — the debug panel now
displays its live progress and result (Test 6 below is new for this
pass).

Every test case below is now genuinely executable end-to-end against a
real device. Tests 1–5 are carried over unchanged from Pass 6.3 (only
this status section and the "blocked" wording changed) — their steps and
pass/fail criteria were already written correctly in anticipation of this
wiring landing.

## Prerequisites

- An Android device with the app installed (debug build is fine).
- A flight controller (or equivalent CH340/FTDI-based USB-serial
  peripheral speaking MSP) connected via a USB-OTG cable. Betaflight,
  iNav, or EmuFlight firmware all give a recognized `knownFamily` in
  Test 6 below (see `mspIdentificationTypes.ts`); any other MSP-speaking
  firmware still identifies, just with `knownFamily: UNKNOWN`.
- The temporary debug panel (`UsbSerialDebugPanel.tsx`) still present and
  reachable while connected — it is what makes the MSP-mode byte log
  (`RX (MSP) ...` log lines) and the new identification display visible
  for these checks, since Pass 6.4b has not shipped real protocol screens
  either.
- USB debugging / logcat access recommended, for cross-checking native
  transport errors against what the debug panel's log shows.

## Test 1 — Real bytes delivered via RNMspTransport

**Steps:**
1. Connect to the flight controller from the app's USB connection screen.
2. Confirm the debug panel shows the Arabic "MSP is active" notice and
   its Start/Stop/Send controls are visibly disabled.
3. Trigger any real MSP traffic from the flight-controller side (e.g. the
   FC periodically pushing telemetry, or a real MSP request issued by
   identification — see Test 6, which alone now guarantees at least three
   real MSP requests fire automatically on every connect).
4. Watch the debug panel's log.

**Expected result:**
- Log lines of the form `RX (MSP)  <N>B  hex=[...]` appear, matching real
  bytes actually sent by the flight controller (cross-check byte count/
  content against a known MSP frame if possible).
- No `RX  <N>B  hex=[...]  base64Len=...` (the OLD, non-MSP raw log
  format) lines appear at all once mspActive is true — confirms the raw
  path is fully inactive, not just quiet.

**Fail if:** no `RX (MSP)` lines ever appear despite confirmed FC
traffic, or the byte content is garbled/truncated relative to what the FC
actually sent.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 2 — Real write reaches the FC

**Steps:**
1. With MSP active and connected, identification (Test 6) has already
   issued at least one real MSP request automatically — this alone
   exercises `RNMspTransport.writeBytes()` under the hood with no manual
   trigger needed.
2. Observe the flight controller's own response/behavior (e.g. a status
   LED, a telemetry value changing, or - most directly - a valid MSP
   response frame coming back and being logged per Test 1).

**Expected result:** the FC visibly reacts to the request (a real
response frame arrives, or an observable state change occurs on the FC
side) - not just "no error was thrown."

**Fail if:** the write appears to resolve successfully in-app but the FC
never reacts and no response frame is ever received.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 3 — Manual `restartReceiveLoop()` resumes reading correctly

**Steps:**
1. With MSP active and RX flowing (per Test 1), trigger
   `restartReceiveLoop()` — in this pass, that means `MspClient`'s own
   Pass 6.2b recovery orchestration reacting to a desync (there is still
   no separate manual trigger exposed by any screen). To provoke it
   deliberately, unplug and immediately replug the USB-OTG cable fast
   enough that the app does not fully reach `DISCONNECTED` first, or
   physically disturb the cable during active traffic to induce a
   transient read error.
2. Confirm the underlying native call sequence is `stopReading()` then,
   only once that resolves, `startReading()` (visible in logcat if native
   logging is enabled).
3. After it resolves, generate more real MSP traffic from the FC (same as
   Test 1).

**Expected result:**
- RX resumes and new `RX (MSP)` log lines appear again after the restart,
  with no manual reconnect (no `closeSession()`/`openDevice()` cycle)
  required.
- The debug panel's status line (Test 6) no longer shows the
  "تعذّرت استعادة اتصال MSP" (RECOVERY_FAILED) message once recovery
  succeeds - if identification had not yet completed before the desync,
  it may show the SUCCEEDED identity from before the restart, unaffected
  by it.

**Fail if:** RX never resumes after the restart, or a full disconnect/
reconnect becomes necessary to see data again.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 4 — Physical detach mid-operation reaches DISCONNECTED via the coordinator

**Steps:**
1. With MSP active and RX/TX traffic flowing, physically unplug the
   USB-OTG cable (or the FC's USB cable) while a request is in flight if
   possible.
2. Watch the connection screen's UI state and the debug panel.

**Expected result:**
- The screen transitions to its disconnected UI state (matching the
  existing hot-plug detach behavior already covered by
  `UsbConnectionScreen.test.tsx`'s unit tests).
- `MspSessionCoordinator`'s own independent `onSessionDetached` listener
  (registered inside `openSession()`) fires and tears the session down
  automatically: ownership jumps directly `ACTIVE` → `INACTIVE` (skipping
  `CLOSING` entirely, unlike an intentional disconnect - see
  `MspSessionCoordinator.ts`'s own doc comment on why), disposing
  `MspClient` **then** `RNMspTransport` in that order. This is not
  independently observable from the UI, but a crash, hang, or the app
  becoming unresponsive on detach would indicate it went wrong.
- The debug panel itself unmounts (it only renders while connected), so
  there is no lingering status/identity display to check afterward - a
  fresh reconnect starts identification over from scratch.
- **Known, accepted, documented timing gap** (see `RNMspTransport.ts`'s
  own class-level comment, Step 0.4): if a `restartReceiveLoop()` call is
  racing the exact moment of detach, it may briefly reject with
  `UNKNOWN_SESSION` / surface a `RECOVERY_FAILED`/
  `MSP_RECOVERY_REQUIRED`-flavored state for a moment before the detach
  event arrives and corrects everything to `DISCONNECTED`/
  `MSP_DEVICE_DETACHED`. **This is expected, self-correcting behavior,
  not a bug** - only flag it as a failure if the app gets permanently
  stuck in that state rather than settling on `DISCONNECTED` within a
  second or two.

**Fail if:** the UI does not reach the disconnected state at all, the app
crashes/hangs, or it stays stuck in a recovery/error state indefinitely.

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 5 — No stale data leaks in after a restart

**Steps:**
1. With MSP active, generate a distinctive, easily-recognizable burst of
   traffic from the FC (e.g. request a specific known value).
2. Immediately trigger `restartReceiveLoop()` (same trigger as Test 3)
   mid-stream, ideally while more bytes are still arriving.
3. After the restart resolves, generate a second, different, distinctive
   burst of traffic.
4. Inspect the `RX (MSP)` log lines logged after the restart completes.

**Expected result:** every `RX (MSP)` log line logged AFTER the restart
resolves corresponds only to bytes genuinely sent by the FC after that
point - no leftover/buffered bytes from before the restart (e.g. a
partial frame that was mid-flight when `stopReading()` was called)
reappear mixed into frames logged afterward.

**Fail if:** any log line after the restart contains bytes that
plausibly belong to the pre-restart burst (e.g. duplicated bytes, or a
frame that only makes sense as a concatenation of old + new data).

- [ ] Pass / [ ] Fail — notes: ______________________

## Test 6 — MSP identification runs automatically and displays correctly (new, Pass 6.4b)

**Steps:**
1. Connect to the flight controller from the app's USB connection screen,
   exactly as in Test 1 - do not press anything else; identification
   starts automatically, fire-and-forget, the instant the session
   activates.
2. Immediately watch the debug panel's status line, above the Start/Stop/
   Send controls.
3. Once it settles, note the firmware/board block that appears below the
   status line.
4. Read off the metrics line beneath the firmware/board block.

**Expected result:**
- The status line briefly reads **"جارٍ التعرّف على وحدة التحكم…"**
  ("Identifying the flight controller...") - on a fast connection this
  may only be visible for a fraction of a second; that is fine, it is not
  a failure if it flashes by too quickly to screenshot.
- The status line then disappears (SUCCEEDED shows no status message of
  its own - see the identity block instead) and a labeled block appears
  showing:
  - **معرّف البرنامج الثابت** (firmware identifier) - the raw 4-character
    MSP identifier, e.g. `BTFL` for Betaflight, `INAV` for iNav, `EMUF`
    for EmuFlight.
  - **الفئة** (family) - `BETAFLIGHT`, `INAV`, `EMUFLIGHT`, or `UNKNOWN`
    for any other MSP-speaking firmware.
  - **اسم اللوحة** (board target name) - the FC's own target name string
    (e.g. `MATEKF722`, `OMNIBUSF4`, whatever the connected board reports).
  - Cross-check all three values against the FC's actual firmware/board -
    e.g. from Betaflight Configurator's own CLI `version`/`status` output
    on the same board, if available for comparison.
- Beneath that, a metrics line of the form
  `chunks=<N> bytes=<N> frames=<N> diagnostics=<N> duration=<N>ms`.
  Record these numbers below as a **smoke-level observation only** - this
  is not a performance benchmark, there is no pass/fail threshold on the
  exact values. Sanity-check only that: `chunks` and `bytes` are nonzero,
  `frames` is at least 3 (one each for MSP_API_VERSION, MSP_FC_VARIANT,
  MSP_BOARD_INFO), and `duration` is a plausible, small number of
  milliseconds for a local USB-serial link (not seconds).

**If identification fails instead** (e.g. connected to non-MSP hardware,
or a genuine protocol problem): the status line should read
**"تعذّر التعرّف على نوع وحدة التحكم، مع بقاء الاتصال قائمًا."**
("Failed to identify the flight controller type, but the connection
remains active.") and the connection itself should stay usable (no
firmware/board block, but also no disconnect) - this is an acceptable,
distinct outcome from the success path above, not itself a failure of
this test unless the FC is known-good MSP hardware.

**Fail if:** the status line never appears at all (no RUNNING message,
however brief - check logcat/timing if it seems to be skipped entirely),
the firmware/board block never appears despite a confirmed-MSP-speaking
FC and no FAILED message either, any of the three displayed values are
visibly wrong relative to the connected hardware, or the metrics line is
missing/shows all-zero values despite a successful identification.

- [ ] Pass / [ ] Fail — notes (record chunks/bytes/frames/diagnostics/duration here): ______________________

## Summary

| Test | Result |
|---|---|
| 1. Real bytes delivered via RNMspTransport | |
| 2. Real write reaches the FC | |
| 3. Manual restartReceiveLoop() resumes reading | |
| 4. Physical detach reaches DISCONNECTED via coordinator | |
| 5. No stale data leaks in after a restart | |
| 6. MSP identification runs automatically and displays correctly | |

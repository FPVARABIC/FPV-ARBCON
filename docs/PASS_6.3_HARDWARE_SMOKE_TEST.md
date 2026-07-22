# Pass 6.3 — Hardware Smoke Test Checklist (RNMspTransport + MspSessionCoordinator)

For Ahmed to run manually on real hardware. Not run or automated by
Claude — this document is manual-test documentation only.

## STATUS: BLOCKED UNTIL PASS 6.4

Pass 6.3 built `RNMspTransport` and `MspSessionCoordinator` and fully
unit-tested them (Jest, with fake/mocked transports — see
`src/platforms/react-native/protocol/*.test.ts`), but the two call sites
that would actually pair them with a live session
(`mspSessionCoordinator.openSession()` in `UsbConnectionScreen.tsx`'s
`handleConnect()`, and `.closeSession()` in `handleDisconnect()`) were
deliberately **not wired in** during Pass 6.3 — see that file's own
comments at those two spots. `UsbSerialDebugPanel`'s `mspActive` prop is
currently hardcoded to `false` at its one render site, so no `MspClient`
/ `RNMspTransport` pairing is ever reachable through the app's UI yet.

**Every test case below requires that Pass 6.4 wiring to be in place
first.** Do not attempt these against a Pass-6.3-only build — there is no
code path that would exercise `RNMspTransport` with a real device. This
checklist is written now, in full, so it is ready to execute the moment
Pass 6.4 lands the wiring, without needing to be rewritten.

## Prerequisites (once Pass 6.4 wiring is in place)

- An Android device with the app installed (debug build is fine).
- A flight controller (or equivalent CH340/FTDI-based USB-serial
  peripheral speaking MSP) connected via a USB-OTG cable.
- The temporary debug panel (`UsbSerialDebugPanel.tsx`) still present and
  reachable while connected — it is what makes the MSP-mode byte log
  (`RX (MSP) ...` log lines) visible for these checks, since Pass 6.4 is
  not expected to have shipped real protocol screens yet either.
- USB debugging / logcat access recommended, for cross-checking native
  transport errors against what the debug panel's log shows.

## Test 1 — Real bytes delivered via RNMspTransport

**Steps:**
1. Connect to the flight controller from the app's USB connection screen.
2. Confirm the debug panel shows the Arabic "MSP is active" notice and
   its Start/Stop/Send controls are visibly disabled.
3. Trigger any real MSP traffic from the flight-controller side (e.g. the
   FC periodically pushing telemetry, or a real MSP request issued by
   whatever Pass 6.4 screen/flow is now driving `MspClient`).
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
1. With MSP active and connected, issue a real MSP request via whatever
   Pass 6.4 flow calls `MspClient`'s request API (this exercises
   `RNMspTransport.writeBytes()` under the hood).
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
1. With MSP active and RX flowing (per Test 1), trigger whatever Pass 6.4
   path calls `restartReceiveLoop()` (this may be automatic, via
   `MspClient`'s own Pass 6.2b recovery orchestration reacting to a
   desync, or a manual trigger if Pass 6.4 exposes one — check with
   whoever implements Pass 6.4 for the exact trigger).
2. Confirm the underlying native call sequence is `stopReading()` then,
   only once that resolves, `startReading()` (visible in logcat if native
   logging is enabled).
3. After it resolves, generate more real MSP traffic from the FC (same as
   Test 1).

**Expected result:**
- RX resumes and new `RX (MSP)` log lines appear again after the restart,
  with no manual reconnect (no `closeSession()`/`openDevice()` cycle)
  required.
- `MspClient`'s connection state returns to a healthy state (whatever
  Pass 6.4's UI surfaces for this - e.g. no longer showing a
  desync/recovery indicator).

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
  (registered inside `openSession()`, once Pass 6.4 wires it) fires and
  tears the session down automatically, in order:
  `MspClient.dispose()` **then** `RNMspTransport.dispose()` (see
  `MspSessionCoordinator.ts`'s own doc comment for why the order
  matters) - this is not independently observable from the UI, but a
  crash, hang, or the app becoming unresponsive on detach would indicate
  it went wrong.
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

## Summary

| Test | Blocked until Pass 6.4? | Result |
|---|---|---|
| 1. Real bytes delivered via RNMspTransport | Yes | |
| 2. Real write reaches the FC | Yes | |
| 3. Manual restartReceiveLoop() resumes reading | Yes | |
| 4. Physical detach reaches DISCONNECTED via coordinator | Yes | |
| 5. No stale data leaks in after a restart | Yes | |

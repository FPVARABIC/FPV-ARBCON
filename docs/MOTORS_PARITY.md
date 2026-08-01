# Motors screen capability and parity record

This document records what the integrated FPV-ARBCON Motors screen actually
does, what it deliberately does not claim, and the remaining work needed for
broader configurator parity. It is a product/engineering record, not a reason
to copy another application's visual identity or wording.

Reference reviewed on 2026-07-31 against the latest stable Betaflight App
release available at the time (`2025.12.2`, tag commit `a2d0f506`):

- Betaflight Configurator Motors tab documentation:
  <https://betaflight.com/docs/wiki/app/motors-tab>
- Betaflight Configurator current `MotorsTab.vue` implementation.
- Betaflight Configurator DShot direction motor-driver implementation.

## Shipped in the current implementation

| Capability                       | FPV-ARBCON status               | Evidence / boundary                                                                                                                     |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Four individual motor outputs    | Complete                        | M1-M4 are equal selectors and can be tested repeatedly in any order in one healthy session.                                             |
| Hold-to-run interaction          | Complete                        | One 800 ms long press; release goes through the controller's all-stop route.                                                            |
| One-output command identity      | Complete                        | The selected visible slot is asserted against the exact active little-endian payload index.                                             |
| Emergency stop                   | Complete                        | Fixed outside the scroll view and never disabled by transient UI state.                                                                 |
| Session reuse                    | Complete                        | A confirmed normal stop returns to Ready after a fresh disarmed-state observation.                                                      |
| Quad X physical reference        | Complete, reference only        | A purpose-built airframe diagram shows the accepted M1-M4 position and expected props-out direction. It is explicitly not FC telemetry. |
| Visual observation workflow      | Complete                        | The operator can record the observed motor/position/direction; observations are volatile and never silently promoted to FC facts.       |
| Live motor configuration summary | Complete, read-only             | Motor count, protocol, and 3D state come from the controller's decoded session scope. Missing data stays unavailable.                   |
| Armed-state monitoring           | Complete                        | One fresh disarmed observation is awaited before Ready and monitoring continues during the usable session.                              |
| Honest battery boundary          | Complete                        | The controller does not infer cell count; the UI asks for manual battery/ESC suitability and never claims automatic 4S enforcement.     |
| Independent Motor/ESC settings   | Complete for API 1.47           | Five groups load under one exclusive transaction; changed groups only are persisted once and read back once.                            |
| Live motor/ESC readings          | Complete with capability limits | MSP_MOTOR and MSP_MOTOR_TELEMETRY use the canonical scheduler, freshness labels and bounded unsupported/link breakers.                  |
| Output reordering                | Complete for four-motor profile | Four attributed visual observations derive an MSP v2 map; save requires review, fresh DISARMED proof and readback.                      |
| Persistent DShot direction       | Complete for one ESC            | One reviewed blocking DShot direction+save command; acknowledgement is never presented as physical CW/CCW proof.                        |

## Complete functional gap audit

The comparison is by user capability, not by layout or wording. A checked
item below means the current FPV-ARBCON screen already provides the outcome;
an unchecked item is real remaining work. The upstream UI is not copied.

### 1. Airframe, mixer and output identity

- [x] Compact Quad X reference with an unambiguous front marker.
- [x] Exact M1-M4 selection identity through the command payload.
- [x] Operator-recorded position/direction observations.
- [ ] Read and name the active mixer instead of assuming Quad X.
- [ ] Select and persist a supported mixer.
- [x] Read, edit and persist the FC's props-in/props-out yaw flag.
- [x] Read the actual motor-output reorder table.
- [x] Guided output-reordering tool using the existing attributed four-motor
      observation flow, preview,
      validation and save.
- [ ] Render supported 2/3/4/6/8-output airframes; the current test path is
      deliberately limited to four outputs.

### 2. ESC and motor configuration

- [x] Read-only motor count, protocol and 3D state.
- [x] Edit and persist the ESC/motor protocol with API-aware
      choices.
- [x] `MOTOR_STOP` control with explicit separation from Emergency Stop.
- [x] `ESC_SENSOR` control with hardware/firmware dependency guidance.
- [x] Bidirectional DShot control with DShot-only visibility and reboot/
      verification guidance.
- [x] Motor pole-count input and validation.
- [x] Static motor idle percentage.
- [ ] Dynamic-idle minimum RPM display/edit ownership and its dependency on
      working bidirectional DShot.
- [x] Analog-protocol-only unsynchronised PWM and PWM frequency controls.
- [x] API-1.47 minimum-command and maximum-throttle fields.
- [x] 3D enable plus deadband-low, deadband-high and neutral values.
- [x] Dirty-state tracking, discard/reset, atomic save, read-back verification,
      reboot-required state and a failed-save recovery path.

### 3. Bench motor control

- [x] Deliberate session start, fixed low one-motor pulse and release-to-stop.
- [x] Repeat M1-M4 in any order in one healthy session.
- [x] Permanent emergency stop and lifecycle stop paths.
- [x] Fresh disarmed-state monitoring.
- [ ] Per-output continuous value control.
- [ ] Master control for all outputs.
- [x] Live FC-side output bars and numeric values, explicitly not physical
      rotation proof.
- [ ] Runtime support for the FC-reported motor count instead of a fixed four.
- [ ] A separately specified 3D test range and neutral/stop contract. The
      current controller must continue to reject 3D until this exists.
- [ ] Rate limiting/coalescing for variable controls, with a priority all-stop
      that is proven on the real Android USB path.

### 4. Direction tools

- [x] Versioned `MSP2_SEND_DSHOT_COMMAND` encoder and serialized transaction.
- [x] DShot-only compatibility gate and explicit ESC-firmware limitations.
- [x] Normal/reverse command for one selected observed ESC. Broadcast-to-all
      remains deliberately absent.
- [x] End-session, DISARMED-proof, blocking-command and ESC-save sequence.
- [ ] Guided direction wizard that spins, asks the operator what was observed,
      applies the requested direction and re-verifies.
- [x] Honest result language: command acknowledgement is not universal ESC
      direction readback.

### 5. Live motor and ESC telemetry

- [x] Poll and decode `MSP_MOTOR` for the FC's current output values.
- [x] Poll and decode `MSP_MOTOR_TELEMETRY` for per-output RPM/eRPM, invalid
      DShot percentage and ESC temperature.
- [x] Per-ESC voltage, current and consumed-mAh from MSP motor telemetry when
      the ESC/firmware actually supplies it.
- [ ] Capability/source labels for UART ESC telemetry, bidirectional DShot and
      Extended DShot Telemetry.
- [x] Freshness, unavailable, unsupported and malformed states;
      a missing value must never look like zero.
- [x] Telemetry quality warning around the upstream 1% error guidance, without
      treating an unpowered ESC's 100% as a wiring verdict.

### 6. Motor-noise diagnostics

- [ ] Live gyro/accelerometer chart during a controlled motor test.
- [ ] X/Y/Z and RMS values.
- [ ] Refresh-rate and scale controls.
- [ ] Reset-maximum action and visible maximum tracking.
- [ ] Explicit graph ownership so this polling cannot compete with a motor
      command or stop on the MSP FIFO.

### 7. Product and protocol foundations

- [ ] Version adapters for every read and write payload, not one payload shape
      applied to every firmware.
- [ ] Feature-capability detection for firmware builds that omit ESC telemetry,
      DShot telemetry or output reordering.
- [x] A configuration transaction capability separate from the motor-pulse
      capability. A settings screen must never obtain the pulse controller's
      lease or encoder.
- [x] A deliberate persistence policy: `MSP_EEPROM_WRITE` is confined by the
      production scanner to `MotorConfigurationController` and never reused by
      Setup calibration or generic tools.
- [x] Read-back verification after every FC-configuration/output-map save and explicit recovery when the
      physical session changes mid-transaction.
- [x] RTL, tablet/phone responsiveness, accessibility labels and minimum touch
      targets for every new control.
- [ ] Wire-fixture, lifecycle, transport-priority, release-bundle and focused
      real-device tests for every new command path.

## Recommended implementation order

The dependency order is mandatory. Rendering the final controls first would
create attractive but non-functional UI, which this project forbids.

1. **Read model:** expose all already-decoded motor/mixer/3D facts and add
   versioned output-reorder and telemetry decoders.
2. **Monitoring:** live outputs, ESC telemetry, power summary and the sensor
   chart, all read-only with freshness states.
3. **Configuration transaction:** isolated writer, dirty draft, validation,
   save/read-back/reboot and recovery semantics.
4. **Configuration UI:** mixer, protocol, idle, motor poles, DShot, ESC sensor,
   Motor Stop, analog-only fields and 3D fields.
5. **Direction and reorder tools:** reviewed MSP2 encoders, queueing, stop
   priority, save and visual verification.
6. **Variable motor controls:** per-output and master values only after their
   independent rate-limit/stop contract passes Android hardware tests.

## Target screen tree

The upgraded Arabic screen should be progressive rather than one long wall:

1. compact connection/arming status and permanent Emergency Stop;
2. compact airframe reference and output identity;
3. `اختبار المحركات` workspace: outputs, values, telemetry and controls;
4. `المراقبة` workspace: RPM/error/temperature/power and sensor graph;
5. `إعداد المحركات وESC`: mixer, protocol, idle and DShot-related settings;
6. `الأدوات`: direction wizard and output reorder;
7. advanced `3D / Analog` section shown only when relevant;
8. one sticky save/reset area that is completely separate from Emergency Stop.

The compact airframe is capped at 195 px, exactly half of the original 390 px
stage. Long physical-position and direction text remains in the selected-output
summary rather than forcing the diagram back to full-page size.

## UI information architecture

The operator flow is intentionally ordered by consequence:

1. remove propellers and acknowledge the physical bench conditions;
2. deliberately start the isolated motor-test session;
3. read one compact authoritative status and the first causal blocker;
4. use one integrated workspace containing FC facts, M1-M4 selection, the
   airframe reference, selected-output summary and hold control;
5. record an optional visual observation after a pulse;
6. keep Emergency Stop permanently reachable outside scrolling.

Developer diagnostics remain collapsed. Unsupported features are described as
limitations, not rendered as disabled controls that imply a working backend.

## Non-negotiable invariants

- The screen never imports the MSP client, transport, encoder, lease, command
  number, motor magnitude or vector builders.
- All activation goes through the existing operator port and controller gate.
- A visual acknowledgement proves receipt only; it never becomes automatic
  proof of rotation, RPM, temperature, direction or physical stop.
- No competitor name or visual identity appears in the shipped Arabic screen.
- Future parity work must add the protocol foundation and focused tests before
  adding a visible control.

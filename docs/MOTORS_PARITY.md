# Motors screen capability and parity record

This document records what the integrated FPV-ARBCON Motors screen actually
does, what it deliberately does not claim, and the remaining work needed for
broader configurator parity. It is a product/engineering record, not a reason
to copy another application's visual identity or wording.

Reference reviewed on 2026-07-31:

- Betaflight Configurator Motors tab documentation:
  <https://betaflight.com/docs/wiki/app/motors-tab>
- Betaflight Configurator current `MotorsTab.vue` implementation.
- Betaflight Configurator DShot direction motor-driver implementation.

## Shipped in the current implementation

| Capability                       | FPV-ARBCON status        | Evidence / boundary                                                                                                                     |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Four individual motor outputs    | Complete                 | M1-M4 are equal selectors and can be tested repeatedly in any order in one healthy session.                                             |
| Hold-to-run interaction          | Complete                 | One 800 ms long press; release goes through the controller's all-stop route.                                                            |
| One-output command identity      | Complete                 | The selected visible slot is asserted against the exact active little-endian payload index.                                             |
| Emergency stop                   | Complete                 | Fixed outside the scroll view and never disabled by transient UI state.                                                                 |
| Session reuse                    | Complete                 | A confirmed normal stop returns to Ready after a fresh disarmed-state observation.                                                      |
| Quad X physical reference        | Complete, reference only | A purpose-built airframe diagram shows the accepted M1-M4 position and expected props-out direction. It is explicitly not FC telemetry. |
| Visual observation workflow      | Complete                 | The operator can record the observed motor/position/direction; observations are volatile and never silently promoted to FC facts.       |
| Live motor configuration summary | Complete, read-only      | Motor count, protocol, and 3D state come from the controller's decoded session scope. Missing data stays unavailable.                   |
| Armed-state monitoring           | Complete                 | One fresh disarmed observation is awaited before Ready and monitoring continues during the usable session.                              |
| Honest battery boundary          | Complete                 | The controller does not infer cell count; the UI asks for manual battery/ESC suitability and never claims automatic 4S enforcement.     |

## Not implemented; no placeholder control is permitted

| Capability available in the reference configurator                     | Current status  | Required foundation before UI                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-motor continuous sliders and master slider                         | Not implemented | A separately reviewed variable-value command contract, rate limiting, stop semantics, and real-device tests. The current fixed low pulse remains unchanged.                                                                               |
| Persistent ESC direction reversal                                      | Not implemented | A versioned `MSP2_SEND_DSHOT_COMMAND` service, ESC-family compatibility rules, explicit save/verification handling, and hardware evidence. MSP does not provide a reliable universal direction readback, so the screen must not fake one. |
| Live eRPM/RPM, DShot error percentage, ESC temperature/voltage/current | Not implemented | Versioned telemetry decoders, capability detection, freshness/error states, and supported ESC telemetry.                                                                                                                                  |
| Mixer type and props-in/props-out configuration                        | Not implemented | Versioned read/write adapter plus save/reboot semantics. The current diagram is an expected reference only.                                                                                                                               |
| Motor protocol editing                                                 | Not implemented | Versioned configuration write, validation and rollback. Current protocol display is read-only.                                                                                                                                            |
| Digital idle / motor-stop / bidirectional DShot / ESC sensor controls  | Not implemented | Versioned adapters for each field with capability detection and persistence semantics.                                                                                                                                                    |
| 3D motor values and dead-band configuration                            | Not implemented | Dedicated 3D support design. The current test engine rejects 3D because it changes stop semantics.                                                                                                                                        |
| Motor poles and RPM filtering helpers                                  | Not implemented | Configuration source, validation rules and feature ownership outside the motor pulse controller.                                                                                                                                          |

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

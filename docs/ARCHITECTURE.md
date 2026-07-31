# Architecture

## Delivery targets

Android (React Native) is the first delivery target for FPV-ARBCON. Web and
Desktop (Windows, macOS, Linux) are future targets — not implemented at this
stage.

## Shared core

`src/core` is platform-independent, pure TypeScript. It has no dependency on
React, React Native, browser APIs, Node/Electron/Tauri APIs, or any native
module. As the project grows, the MSP codec, command queue, flight controller
state, and firmware adapters will all live here as shared, platform-independent
core modules, reusable across Android, Web, and Desktop.

## Transport per platform

Each platform will provide its own implementation of the `Transport` contract
defined in `src/core/transport`. That contract only describes generic binary
communication and lifecycle operations — it does not mention any specific
platform or protocol.

- **Android (React Native)**: the first platform implementation.
- **Web**: may later use WebUSB/WebSerial, or a WiFi/TCP bridge.
- **Desktop**: may later use an appropriate native serial/USB wrapper.

Platform-specific transport implementations — and any platform-specific
folders — will be added only when their respective stages begin. No Web or
Desktop functionality is implemented now.

## UI layer

`src/ui` currently contains only the React Native application layer for
Android. It is not assumed to be the only UI the core will ever have. Core
models, protocol types, command behavior, validation rules, firmware adapters,
and future state logic must never live under `src/ui` — they belong in
`src/core` so they can be reused by a future Web or Desktop UI.

## Known gaps — future hardening

Recorded deliberately, not scheduled. Each needs its own approval before any
change, because all of them sit in code that is currently frozen.

- **`LEASE_WORK_UNSETTLED` never retries.** `MspClient.releaseMotorTestLease`
  refuses to release the motor-test lease while lease-owned work is still
  active or queued, and answers `LEASE_WORK_UNSETTLED`
  (`src/core/protocol/mspClient.ts`). That refusal is correct — the request is
  neither cancelled nor discarded — but nothing ever retries the release once
  the work settles, so a caller that releases too early leaves the lease held
  and telemetry paused for the remainder of the session. `MotorsScreen`
  currently avoids this by waiting for the session to settle before releasing;
  a retry-on-settle inside `MspClient` itself would be more robust than any
  caller-side workaround, since it would hold for every future caller rather
  than for the one that remembered.

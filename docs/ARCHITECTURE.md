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

# Configurations system architecture

This document records the source and safety contract for the integrated
Configurations area. It exists so later work can review or extend the feature
without guessing at either the MSP wire layout or the ownership boundaries.

## Source baseline

- Betaflight firmware and configurator release `2025.12.2` / MSP API `1.47`.
- Betaflight Configurator `ConfigurationTab.vue`, `MSPHelper.js`, `Features.js`
  and `Beepers.js` at commit `5ed74193`.
- INAV Configurator's `tabs/configuration.js` and
  `tabs/configuration.html` were used to review section hierarchy and device
  summaries. INAV-only settings are not written through Betaflight payloads.

No external configurator is opened or embedded by this application. The
result is an Arabic-first FPV-ARBCON workflow backed by the flight
controller's own MSP responses.

## Ownership

Configurations owns only the current general-configuration fields:

- craft and pilot labels;
- FPV camera angle;
- arming angle, first-arm gyro calibration and auto-disarm delay;
- PID process denominator;
- general feature bits that are not owned by Motors, Ports or GPS;
- beeper conditions and DShot beacon conditions/tone.

Motors/ESC, serial assignments, GPS/GNSS and live setup telemetry remain
owned by their existing systems. Configurations links to those destinations
inside the same tab shell instead of duplicating their controls.

## Transaction contract

1. Only a live Betaflight MSP API 1.47 session is writable.
2. The app must be foregrounded, the MSP link ready, motor test inactive and
   no other configuration transaction running.
3. The controller rereads every writable group and rejects a stale base.
4. A fresh `MSP_STATUS_EX` plus the session-bound BOXIDS mapping must prove
   DISARMED before the first write.
5. Only changed groups are sent. Complete masks/payloads preserve every
   unrelated bit and field.
6. Ambiguous writes are never retried automatically.
7. EEPROM is committed once, the values are read back and compared, then one
   normal reboot is requested.

The screen creates no polling timer. Its system-status summary consumes the
existing shared `fcStatus` telemetry channel only while the tab is active.

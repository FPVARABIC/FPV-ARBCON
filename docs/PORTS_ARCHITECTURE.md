# Ports architecture

The Ports tab is part of the single `com.fpvarbcon` React Native application.
It is mounted by `MainTabsScreen`, consumes the canonical MSP session key, and
does not open a second transport, create another Android application, or ship a
separate APK.

## Wire contract

The implementation was checked against the upstream configurator and firmware
at the pinned local review revisions recorded during this pass:

- configurator `5ed74193a7572366dac2efee5ea13eb063100c2c`
- firmware `b41431ae981ced5086a63a89e8217fe6da02df33`

It uses the versioned MSP2 serial configuration messages (`0x1009` read,
`0x100A` write). A response is a count followed by uniform records containing
the identifier, the complete little-endian u32 function mask, four baud-rate
indexes, and any firmware extension bytes. Unknown function bits and extension
bytes are retained byte-for-byte so a newer target is not silently downgraded
by editing a known field.

The tab also reads the active serial receiver provider, build-option IDs, VTX
table availability/completeness, and the complete feature mask. The current
safe adapter is limited to the BTFL family with MSP API 1.46 or newer. Other
firmware families are rejected before a Ports request because their function
masks and sharing rules are not interchangeable.

## Save transaction

Saving is one ordered operation:

1. reject a backgrounded app, inactive/replaced session, recovering link, or
   active motor test;
2. acquire the shared configuration interlock and pause telemetry;
3. re-read the serial table and feature mask and reject a stale editor base;
4. read fresh BOXIDS and STATUS_EX evidence and prove DISARMED;
5. send the serial table once;
6. send the derived full feature mask once when it changed, preserving every
   unrelated bit;
7. persist with one EEPROM write;
8. read both groups back and compare them;
9. request one expected reboot.

No ambiguous serial, feature, or EEPROM write is retried automatically. A lost
reply is reported as unconfirmed and requires reconnecting and reading wire
truth again.

## Policy and compatibility

- at least one and at most two MSP ports;
- USB VCP always retains MSP;
- one Serial RX port;
- one port per telemetry, sensor, or peripheral function;
- provider-aware RX/telemetry sharing;
- exact MSP-sharing rules rather than treating every telemetry protocol alike;
- VTX over MSP requires MSP or RX on the same port;
- SoftSerial cannot host MSP/RX and is limited to supported active baud rates;
- API/build-option unsupported functions are not selectable;
- dormant baud fields do not manufacture validation failures;
- GPS and Blackbox AUTO values normalize only when those functions are active.

The UI is Arabic RTL and exposes the actual decoded port list. It uses
exclusive role pickers for telemetry, sensors, and peripherals, contextual
baud choices, active-baud summaries on collapsed cards, a visible validation
summary, protected reset/reload controls, and a single save-and-reboot action.
It never substitutes a static drawing for FC state.

## Upstream parity review

The table below records the evidence-based comparison with the current
official Configurator Ports tab and firmware serial contract. "Parity" means
the same operator service, not copied layout or source.

| Capability | Official Configurator behaviour | This application | Status |
| --- | --- | --- | --- |
| Enumerate real FC ports | Builds rows/cards from `MSP2_COMMON_SERIAL_CONFIG` | Decodes the same versioned table from the canonical session | Parity |
| MSP and Serial RX | Dedicated controls with sharing constraints | Dedicated controls; USB MSP is retained and non-editable | Parity + safer USB guard |
| Telemetry, sensors, peripherals | One selectable function in each role group | Exclusive Arabic role groups using the same known bits 0–17 | Parity |
| Firmware build gating | Hides/disables functions absent from build options | Disables proven-absent roles; unknown evidence stays conservative | Parity |
| Baud rates | Role-specific options, conditional on API version | Same role/API-specific sets; active rates also remain visible when collapsed | Parity + visibility |
| RX sharing | Provider-aware exceptions | Provider-aware exceptions including IBUS/MAVLink and VTX-MSP cases | Parity |
| VTX-MSP warning | Warns when a supported VTX table has zero bands, channels, or power levels | Uses the same availability and completeness distinction | Parity |
| SoftSerial | Restricts functions and active speed | Rejects MSP/RX and unsupported active rates before save | Parity |
| Feature coupling | Updates required feature flags with serial roles | Derives the complete feature mask while preserving unrelated bits | Parity |
| Unknown future data | Current UI does not edit unknown function bits | Preserves unknown u32 bits and record extension bytes byte-for-byte | Stronger forward preservation |
| Dirty reload | Reloads FC truth | Requires explicit confirmation before discarding edits | Stronger loss prevention |
| Save transaction | Serial config, feature config, EEPROM, reboot | Adds stale-base detection, DISARMED proof, telemetry exclusion, readback verification, and no ambiguous retry | Stronger transaction safety |
| Accessibility/mobile | Desktop table and mobile cards | RTL mobile-first cards, labelled switch/radio/button semantics and 44-point targets | Product-specific parity |

The comparison deliberately does not expose firmware functions that the
official Configurator itself does not currently expose in its Ports UI. Their
unknown mask bits are retained instead of guessed. Support for another
firmware family must be implemented as a separately proven wire adapter, not
by reusing Betaflight masks under a different product name.

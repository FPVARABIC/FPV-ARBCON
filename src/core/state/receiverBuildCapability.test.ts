/**
 * RECEIVER P4 CLOSURE - a writable enum value is not a compiled driver.
 *
 * The defect this suite exists to prevent: offering SBUS on a build that
 * only compiled CRSF. The write succeeds, the read-back matches, the FC
 * reboots, and the aircraft has no receiver - every check passes and the
 * pilot has lost control input. Nothing in MSP_RX_CONFIG can catch that,
 * because the enum accepts the byte regardless.
 *
 * The evidence that CAN catch it is MSP_BUILD_INFO's option list
 * (msp_build_info.c @ pinned 1.47), which is generated so that every
 * entry sits under the same `#ifdef` as the driver it names. These tests
 * pin the mapping from provider to option id, and - just as importantly -
 * the three-valued evidence state, because "absent from the report" and
 * "no report at all" must never be collapsed.
 */

import {
  BUILD_OPTION_RX_PPM, BUILD_OPTION_SERIALRX_CRSF, BUILD_OPTION_SERIALRX_SBUS,
  BUILD_OPTION_SERIALRX_SPEKTRUM, BUILD_OPTION_SERIALRX_XBUS,
  resolveModeAvailability, resolveProviderAvailability, selectableProviders,
} from './receiverBuildCapability';
import {
  RECEIVER_MODE_CAPABILITY, providerWriteIsPermitted,
  receiverModeIsSelectable, selectableReceiverModes,
} from './receiverModeCapability';

const CRSF_ONLY = new Set([BUILD_OPTION_SERIALRX_CRSF]);
const CRSF_AND_PPM = new Set([BUILD_OPTION_SERIALRX_CRSF, BUILD_OPTION_RX_PPM]);
const NOTHING_REPORTED = undefined;
const EMPTY_REPORT = new Set<number>();

describe('P4 closure: provider availability comes from the connected build', () => {
  it('maps every provider onto the option that guards its driver', () => {
    // rx.c serialRxInit #ifdef grouping, verified rather than inferred.
    expect(resolveProviderAvailability(9, CRSF_ONLY)).toBe('AVAILABLE');       // CRSF
    expect(resolveProviderAvailability(2, new Set([BUILD_OPTION_SERIALRX_SBUS]))).toBe('AVAILABLE');
    // One USE_SERIALRX_SPEKTRUM guard covers SRXL(10), 1024(15), 2048(1).
    const spektrum = new Set([BUILD_OPTION_SERIALRX_SPEKTRUM]);
    for (const provider of [1, 10, 15]) expect(resolveProviderAvailability(provider, spektrum)).toBe('AVAILABLE');
    // One USE_SERIALRX_XBUS guard covers MODE_B(5) and MODE_B_RJ01(6).
    const xbus = new Set([BUILD_OPTION_SERIALRX_XBUS]);
    for (const provider of [5, 6]) expect(resolveProviderAvailability(provider, xbus)).toBe('AVAILABLE');
  });

  it('a valid enum value is NOT support: SBUS on a CRSF-only build is UNAVAILABLE', () => {
    expect(resolveProviderAvailability(2, CRSF_ONLY)).toBe('UNAVAILABLE');
    expect(providerWriteIsPermitted(2, CRSF_ONLY)).toBe(false);
  });

  it('distinguishes "reported absent" from "never reported"', () => {
    expect(resolveProviderAvailability(2, CRSF_ONLY)).toBe('UNAVAILABLE');
    expect(resolveProviderAvailability(2, NOTHING_REPORTED)).toBe('NOT_PROVEN');
    expect(resolveProviderAvailability(2, EMPTY_REPORT)).toBe('NOT_PROVEN');
  });

  it('never treats NOT_PROVEN as permission to write', () => {
    for (const provider of [2, 9, 14]) {
      expect(providerWriteIsPermitted(provider, NOTHING_REPORTED)).toBe(false);
      expect(providerWriteIsPermitted(provider, EMPTY_REPORT)).toBe(false);
    }
  });

  it('reports NOT_PROVEN for providers no build option covers', () => {
    // TARGET_CUSTOM(11) is guarded by USE_SERIALRX_TARGET_CUSTOM, for
    // which msp_build_info.c emits nothing; NONE(0) is not a driver.
    for (const provider of [0, 11]) {
      expect(resolveProviderAvailability(provider, CRSF_ONLY)).toBe('NOT_PROVEN');
      expect(providerWriteIsPermitted(provider, CRSF_ONLY)).toBe(false);
    }
  });

  it('offers only proven providers, and offers none at all with no report', () => {
    expect(selectableProviders(CRSF_ONLY)).toEqual([9]);
    expect(selectableProviders(NOTHING_REPORTED)).toEqual([]);
    expect(selectableProviders(EMPTY_REPORT)).toEqual([]);
  });

  it('CRSF stays CRSF - one provider value, no ExpressLRS pseudo-entry', () => {
    expect(BUILD_OPTION_SERIALRX_CRSF).toBe(4097);
    expect(selectableProviders(new Set([BUILD_OPTION_SERIALRX_CRSF]))).toEqual([9]);
    const source = require('fs').readFileSync(require('path').join(__dirname, 'receiverBuildCapability.ts'), 'utf8');
    expect(source).not.toMatch(/ELRS|ExpressLRS/i);
  });
});

describe('P4 closure: mode availability', () => {
  it('proves PPM from the build, because BUILD_OPTION_RX_PPM exists', () => {
    expect(BUILD_OPTION_RX_PPM).toBe(4102);
    expect(resolveModeAvailability('PPM', CRSF_AND_PPM)).toBe('AVAILABLE');
    expect(resolveModeAvailability('PPM', CRSF_ONLY)).toBe('UNAVAILABLE');
    expect(resolveModeAvailability('PPM', NOTHING_REPORTED)).toBe('NOT_PROVEN');
  });

  it('can NEVER prove PARALLEL_PWM, because the firmware reports no option for it', () => {
    // Not a policy choice: msp_build_info.h has no
    // BUILD_OPTION_RX_PARALLEL_PWM at any value.
    for (const options of [CRSF_AND_PPM, CRSF_ONLY, EMPTY_REPORT, NOTHING_REPORTED]) {
      expect(resolveModeAvailability('PARALLEL_PWM', options)).toBe('NOT_PROVEN');
    }
    expect(RECEIVER_MODE_CAPABILITY.PARALLEL_PWM.classification).toBe('READ_ONLY');
    expect(receiverModeIsSelectable('PARALLEL_PWM', CRSF_AND_PPM)).toBe(false);
  });

  it('makes SERIAL selectable only when the build has at least one provider', () => {
    expect(receiverModeIsSelectable('SERIAL', CRSF_ONLY)).toBe(true);
    expect(receiverModeIsSelectable('SERIAL', EMPTY_REPORT)).toBe(false);
    expect(receiverModeIsSelectable('SERIAL', NOTHING_REPORTED)).toBe(false);
  });

  it('makes PPM selectable only when the build reported it', () => {
    expect(receiverModeIsSelectable('PPM', CRSF_AND_PPM)).toBe(true);
    expect(receiverModeIsSelectable('PPM', CRSF_ONLY)).toBe(false);
  });

  it('keeps MSP, SPI and NONE unselectable whatever the build reports', () => {
    for (const mode of ['MSP', 'SPI', 'NONE'] as const) {
      expect(receiverModeIsSelectable(mode, CRSF_AND_PPM)).toBe(false);
    }
  });

  it('offers nothing at all when the build proves nothing', () => {
    expect(selectableReceiverModes(NOTHING_REPORTED)).toEqual([]);
    expect(selectableReceiverModes(EMPTY_REPORT)).toEqual([]);
    expect(selectableReceiverModes(CRSF_AND_PPM)).toEqual(['PPM', 'SERIAL']);
    expect(selectableReceiverModes(CRSF_ONLY)).toEqual(['SERIAL']);
  });
});

describe('P4 closure: capability cannot leak across sessions', () => {
  it('is a pure function of the option set it is given, holding no state', () => {
    // There is nothing to go stale: every answer is derived from the
    // argument, so a new session simply passes a new set. The controller
    // re-reads MSP_BUILD_INFO inside each save transaction, which is what
    // makes an old board's answer unable to authorise a new board's write
    // (proved in ReceiverModeWrite.test.ts).
    expect(resolveProviderAvailability(2, CRSF_ONLY)).toBe('UNAVAILABLE');
    expect(resolveProviderAvailability(2, new Set([BUILD_OPTION_SERIALRX_SBUS]))).toBe('AVAILABLE');
    const source = require('fs').readFileSync(require('path').join(__dirname, 'receiverBuildCapability.ts'), 'utf8');
    // No module-level mutable cache of any kind.
    expect(source).not.toMatch(/^let /m);
    expect(source).not.toMatch(/new Map\(|new Set\(\)/);
  });
});

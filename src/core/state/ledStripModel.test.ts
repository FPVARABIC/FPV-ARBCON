import {
  classifyLedModeColorTuple,
  classifyLedStripBuildCapability,
  ledBaseFunctionDependency,
  ledLayerPriority,
  ledModeRuntimeStatus,
  ledOverlayDependency,
  ledSpecialSlotStatus,
  LedModeIndex,
  LedSpecialColorSlot,
  LED_BUILD_CONDITIONAL_LAYERS,
  LED_CAPABILITY_BYTE_ADVANCED,
  LED_CAPABILITY_BYTE_BASIC,
  LED_LAYER_PRIORITY_ORDER,
  LED_SPECIAL_SLOT_COUNT,
} from './ledStripModel';
import {LedBaseFunction, LedOverlayBit} from '../protocol/msp/decoding/ledStripWireContract';
import {F11_MODECOLOR_EXPECTED} from '../protocol/msp/__testUtils__/ledStripFixtures';

describe('build capability comes from the observed byte', () => {
  it('classifies the two values the firmware writes', () => {
    expect(classifyLedStripBuildCapability(LED_CAPABILITY_BYTE_ADVANCED)).toBe('ADVANCED_STATUS_MODE');
    expect(classifyLedStripBuildCapability(LED_CAPABILITY_BYTE_BASIC)).toBe('BASIC_LED_STRIP');
  });

  it('refuses to guess about a value no pinned tree emits', () => {
    expect(classifyLedStripBuildCapability(2)).toBe('UNRECOGNISED_CAPABILITY_BYTE');
    expect(classifyLedStripBuildCapability(255)).toBe('UNRECOGNISED_CAPABILITY_BYTE');
  });
});

describe('mode-colour tuples are classified, never discarded', () => {
  it('classifies every tuple of a real frame', () => {
    const classified = F11_MODECOLOR_EXPECTED.map(classifyLedModeColorTuple);
    expect(classified.filter((c) => c.kind === 'DIRECTIONAL_MODE_COLOR')).toHaveLength(36);
    expect(classified.filter((c) => c.kind === 'SPECIAL_COLOR')).toHaveLength(11);
    expect(classified.filter((c) => c.kind === 'AUX_CHANNEL')).toHaveLength(1);
    expect(classified.filter((c) => c.kind === 'UNKNOWN')).toHaveLength(0);
  });

  it('reads a directional tuple as mode plus direction', () => {
    expect(classifyLedModeColorTuple({mode: 3, slot: 4, value: 9})).toEqual({
      kind: 'DIRECTIONAL_MODE_COLOR', mode: 3, direction: 4, colorIndex: 9,
    });
  });

  it('reads mode 6 as a special colour slot', () => {
    expect(classifyLedModeColorTuple({mode: 6, slot: 10, value: 2})).toEqual({
      kind: 'SPECIAL_COLOR', slot: 10, colorIndex: 2,
    });
  });

  it('reads mode 7 as an aux CHANNEL, not a colour', () => {
    /* Sharing the third byte with the colour tuples is exactly why this
       classifier exists instead of a 6x6 matrix built in the decoder. */
    const aux = classifyLedModeColorTuple({mode: 7, slot: 0, value: 3});
    expect(aux).toEqual({kind: 'AUX_CHANNEL', channel: 3});
    expect(aux).not.toHaveProperty('colorIndex');
  });

  it('does not confuse the special mode with the aux mode', () => {
    expect(classifyLedModeColorTuple({mode: 6, slot: 0, value: 5}).kind).toBe('SPECIAL_COLOR');
    expect(classifyLedModeColorTuple({mode: 7, slot: 0, value: 5}).kind).toBe('AUX_CHANNEL');
  });

  it('carries an unrecognised tuple through instead of dropping it', () => {
    expect(classifyLedModeColorTuple({mode: 9, slot: 4, value: 7})).toEqual({
      kind: 'UNKNOWN', mode: 9, slot: 4, value: 7,
    });
    expect(classifyLedModeColorTuple({mode: 6, slot: 11, value: 1}).kind).toBe('UNKNOWN');
    expect(classifyLedModeColorTuple({mode: 7, slot: 1, value: 1}).kind).toBe('UNKNOWN');
    expect(classifyLedModeColorTuple({mode: 0, slot: 6, value: 1}).kind).toBe('UNKNOWN');
  });
});

describe('mode 5 is wire-known and runtime-inert', () => {
  it('marks the four unconditionally mapped modes', () => {
    for (const mode of [LedModeIndex.ORIENTATION, LedModeIndex.HEADFREE, LedModeIndex.HORIZON, LedModeIndex.ANGLE]) {
      expect(ledModeRuntimeStatus(mode)).toBe('RUNTIME_MAPPED');
    }
  });

  it('marks the mag mode as build-conditional', () => {
    expect(ledModeRuntimeStatus(LedModeIndex.MAG)).toBe('RUNTIME_MAPPED_WHEN_BUILT');
  });

  it('marks mode 5 as inert without deleting it from the model', () => {
    /* The firmware stores it, transmits it and validates writes to it, and
       no code path ever reads it. The reference tab offers it as a live
       control; presenting it as effective here would repeat that. */
    expect(LedModeIndex.BARO).toBe(5);
    expect(ledModeRuntimeStatus(LedModeIndex.BARO)).toBe('KNOWN_BUT_RUNTIME_INERT');
    expect(classifyLedModeColorTuple({mode: 5, slot: 2, value: 4}).kind).toBe('DIRECTIONAL_MODE_COLOR');
  });

  it('knows nothing about a mode index outside the directional range', () => {
    expect(ledModeRuntimeStatus(6)).toBeUndefined();
    expect(ledModeRuntimeStatus(7)).toBeUndefined();
  });
});

describe('special colour slots 8..10 survive as unknown', () => {
  it('names the eight the firmware enumerates', () => {
    expect(LedSpecialColorSlot).toEqual({
      DISARMED: 0, ARMED: 1, ANIMATION: 2, BACKGROUND: 3,
      BLINK_BACKGROUND: 4, GPS_NO_SATS: 5, GPS_NO_LOCK: 6, GPS_LOCKED: 7,
    });
    for (const slot of Object.values(LedSpecialColorSlot)) {
      expect(ledSpecialSlotStatus(slot)).toBe('NAMED');
    }
  });

  it('keeps the three unnamed slots the field still carries', () => {
    expect(LED_SPECIAL_SLOT_COUNT).toBe(11);
    expect(ledSpecialSlotStatus(8)).toBe('UNKNOWN_BUT_PRESERVED');
    expect(ledSpecialSlotStatus(9)).toBe('UNKNOWN_BUT_PRESERVED');
    expect(ledSpecialSlotStatus(10)).toBe('UNKNOWN_BUT_PRESERVED');
  });

  it('reports nothing for a slot outside the field', () => {
    expect(ledSpecialSlotStatus(11)).toBeUndefined();
    expect(ledSpecialSlotStatus(-1)).toBeUndefined();
  });

  it('includes the background slot the reference never exposes', () => {
    /* It is the colour of every LED with no base function, and the reference
       tab has no control for it at all. */
    expect(ledSpecialSlotStatus(LedSpecialColorSlot.BACKGROUND)).toBe('NAMED');
  });
});

describe('runtime layer priority', () => {
  it('runs the base function first and the warning layer last', () => {
    expect(LED_LAYER_PRIORITY_ORDER[0]).toBe('BASE_FUNCTION');
    expect(LED_LAYER_PRIORITY_ORDER[LED_LAYER_PRIORITY_ORDER.length - 1]).toBe('WARNING');
    expect(ledLayerPriority('BASE_FUNCTION')).toBe(0);
  });

  it('orders the timed layers exactly as the firmware applies them', () => {
    expect([...LED_LAYER_PRIORITY_ORDER]).toEqual([
      'BASE_FUNCTION', 'RAINBOW', 'BLINK', 'LARSON_SCANNER', 'THRUST_RING',
      'INDICATOR', 'VTX', 'GPS', 'BATTERY', 'RSSI', 'WARNING',
    ]);
  });

  it('puts warnings above every decorative layer', () => {
    for (const layer of ['RAINBOW', 'BLINK', 'LARSON_SCANNER', 'THRUST_RING', 'INDICATOR'] as const) {
      expect(ledLayerPriority('WARNING')).toBeGreaterThan(ledLayerPriority(layer));
    }
  });

  it('marks the two layers that only exist in some builds', () => {
    expect([...LED_BUILD_CONDITIONAL_LAYERS]).toEqual(['VTX', 'GPS']);
  });
});

describe('ordinal and geometry dependency metadata', () => {
  it('marks the base functions that walk the strip in wire order', () => {
    expect(ledBaseFunctionDependency(LedBaseFunction.THRUST_RING)).toBe('ORDINAL');
    expect(ledBaseFunctionDependency(LedBaseFunction.GPS_BAR)).toBe('ORDINAL');
    expect(ledBaseFunctionDependency(LedBaseFunction.BATTERY_BAR)).toBe('ORDINAL');
  });

  it('marks flight mode as geometry-dependent', () => {
    /* Its colour comes from the LED's direction bits, and which direction a
       position corresponds to is derived from the whole layout's extent. */
    expect(ledBaseFunctionDependency(LedBaseFunction.FLIGHT_MODE)).toBe('GEOMETRY');
  });

  it('marks the two ordinal overlays and the one geometry overlay', () => {
    expect(ledOverlayDependency(LedOverlayBit.RAINBOW)).toBe('ORDINAL');
    expect(ledOverlayDependency(LedOverlayBit.LARSON_SCANNER)).toBe('ORDINAL');
    expect(ledOverlayDependency(LedOverlayBit.INDICATOR)).toBe('GEOMETRY');
  });

  it('reports no dependency for the self-contained effects', () => {
    for (const fn of [LedBaseFunction.COLOR, LedBaseFunction.ARM_STATE, LedBaseFunction.BATTERY, LedBaseFunction.RSSI, LedBaseFunction.GPS, LedBaseFunction.ALTITUDE]) {
      expect(ledBaseFunctionDependency(fn)).toBeUndefined();
    }
    for (const overlay of [LedOverlayBit.THROTTLE, LedOverlayBit.BLINK, LedOverlayBit.VTX, LedOverlayBit.WARNING]) {
      expect(ledOverlayDependency(overlay)).toBeUndefined();
    }
  });
});

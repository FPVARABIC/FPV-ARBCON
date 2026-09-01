/**
 * AN OSD ROUND TRIP THROUGH A FLIGHT CONTROLLER WE DID NOT WRITE.
 *
 * =====================================================================
 * WHAT IS BEING PROVEN, AND WHAT DELIBERATELY IS NOT
 * =====================================================================
 *
 * This application renders NO OSD values - see osdPreviewIsolation.test.
 * The volts, amps, mAh, RSSI and satellites a pilot reads in the goggles
 * are drawn by the flight controller from its own sensors. So the thing
 * that CAN go wrong here is not a wrong reading; it is a wrong
 * ADDRESS: the operator switches on and positions element N, and the
 * flight controller applies it to element M.
 *
 * Positions travel positionally in a bare uint16 array with no
 * identifier on the wire, so nothing catches that. This file catches it.
 *
 * =====================================================================
 * WHY THE BYTES BELOW ARE HAND-WRITTEN
 * =====================================================================
 *
 * Feeding our own encoder's output to our own decoder proves only that
 * they agree with each other - two halves of the same mistake pass every
 * time. So the virtual flight controller here is written from
 * Betaflight's own source, transcribed field by field, and our encoder
 * and decoder are never used to produce an expectation:
 *
 *   serializer  betaflight/src/main/msp/msp.c, `case MSP_OSD_CONFIG:`
 *               (sbufWriteU8(osdFlags), video_system, units, rssi_alarm,
 *                cap_alarm U16, 0, itemCount, alt_alarm U16,
 *                item_pos[] U16, OSD_STAT_COUNT + states, OSD_TIMER_COUNT
 *                + timers U16, warnings low U16, OSD_WARNING_COUNT,
 *                warnings U32, profile count, selected, overlay_radio_mode,
 *                camera_frame_width, camera_frame_height,
 *                link_quality_alarm U16, rssi_dbm_alarm)
 *
 *   handler     betaflight/src/main/msp/msp.c, `case MSP_SET_OSD_CONFIG:`
 *               addr -1 general / -2 timer / else element, where the
 *               element branch reads a U16 value then an OPTIONAL screen
 *               byte: "0 is post flight statistics, 1 and above are in
 *               flight OSD screens", defaulting to 1 when absent.
 *
 *   @ betaflight/betaflight 1efac3e, retrieved 2026-08-21.
 *
 * The values are chosen to be unmistakable. A field read one byte early
 * or late, at the wrong width, or with the wrong sign produces a number
 * that could not be confused with the right one.
 */

import {decodeOsdConfiguration} from '../decoding/decodeOsdConfiguration';
import {encodeChangedOsdConfiguration} from '../encoding/encodeOsdConfiguration';
import {
  createOsdConfigurationDraft,
  osdPositionX,
  osdPositionY,
  osdVisibleInProfile,
  setOsdPosition,
  setOsdProfileVisibility,
} from '../../../state/osdConfigurationModel';
import type {MspOsdSnapshot} from '../decoding/decodeOsdConfiguration';

/* ------------------------------------------------------------------ *
 * The virtual flight controller
 * ------------------------------------------------------------------ */

/** OSD_ITEM_COUNT for the unconditional part of osd_items_e. */
const ITEM_COUNT = 88;
const STAT_COUNT = 6;
const TIMER_COUNT = 2;
const WARNING_COUNT = 14;
const PROFILE_COUNT = 3;

/**
 * `osdConfig_t` as this board holds it. Deliberately un-round numbers:
 * an off-by-one read lands on a value nobody could mistake for the
 * intended one.
 */
type VirtualOsdState = {
  units: number;
  rssiAlarm: number;
  capAlarm: number;
  altAlarm: number;
  itemPos: number[];
  statState: boolean[];
  timers: number[];
  enabledWarnings: number;
  profileIndex: number;
  overlayRadioMode: number;
  cameraFrameWidth: number;
  cameraFrameHeight: number;
  linkQualityAlarm: number;
  rssiDbmAlarm: number;
  videoSystem: number;
};

function freshBoard(): VirtualOsdState {
  const itemPos = new Array<number>(ITEM_COUNT).fill(0);
  /* Every element somewhere different, so "the right element moved" is
     distinguishable from "an element moved". x = index % 47,
     y = index % 17, both prime-ish strides so no two elements share a
     cell for a long way. Profile 1 visible on even indices only. */
  for (let index = 0; index < ITEM_COUNT; index += 1) {
    let packed = setOsdPosition(0, index % 47, index % 17);
    packed = setOsdProfileVisibility(packed, 1, index % 2 === 0);
    itemPos[index] = packed;
  }
  return {
    videoSystem: 3, // HD
    units: 1,
    rssiAlarm: 37,
    capAlarm: 1673,
    altAlarm: 742,
    itemPos,
    statState: [true, false, true, true, false, true],
    timers: [0x1421, 0x0a35],
    enabledWarnings: 0x0002a19f,
    profileIndex: 2,
    overlayRadioMode: 5,
    cameraFrameWidth: 27,
    cameraFrameHeight: 13,
    linkQualityAlarm: 63,
    rssiDbmAlarm: -97,
  };
}

/** A byte sink with the same primitives sbuf gives the firmware. */
class Sbuf {
  readonly bytes: number[] = [];
  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }
  u16(value: number): void {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
  }
  u32(value: number): void {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
}

/** `case MSP_OSD_CONFIG:` transcribed, in its own order. */
function serializeOsdConfig(board: VirtualOsdState): Uint8Array {
  const out = new Sbuf();
  // OSD_FLAGS_OSD_FEATURE | OSD_FLAGS_OSD_HARDWARE_MAX_7456 | DETECTED
  out.u8((1 << 0) | (1 << 4) | (1 << 5));
  out.u8(board.videoSystem);
  out.u8(board.units);
  out.u8(board.rssiAlarm);
  out.u16(board.capAlarm);
  out.u8(0); // reused old timer alarm low byte
  out.u8(ITEM_COUNT); // ...and its high byte, reused as the item count
  out.u16(board.altAlarm);
  for (const position of board.itemPos) out.u16(position);
  out.u8(STAT_COUNT);
  for (const enabled of board.statState) out.u8(enabled ? 1 : 0);
  out.u8(TIMER_COUNT);
  for (const timer of board.timers) out.u16(timer);
  out.u16(board.enabledWarnings & 0xffff);
  out.u8(WARNING_COUNT);
  out.u32(board.enabledWarnings);
  out.u8(PROFILE_COUNT);
  out.u8(board.profileIndex);
  out.u8(board.overlayRadioMode);
  out.u8(board.cameraFrameWidth);
  out.u8(board.cameraFrameHeight);
  out.u16(board.linkQualityAlarm);
  out.u16(board.rssiDbmAlarm & 0xffff); // int16 on the wire
  return Uint8Array.from(out.bytes);
}

type ApplyResult = {readonly ok: boolean; readonly reason?: string};

/** `case MSP_SET_OSD_CONFIG:` transcribed, including the screen byte. */
function applySetOsdConfig(
  board: VirtualOsdState,
  payload: Uint8Array,
): ApplyResult {
  let offset = 0;
  const u8 = () => payload[offset++];
  const u16 = () => {
    const value = payload[offset] | (payload[offset + 1] << 8);
    offset += 2;
    return value;
  };
  const remaining = () => payload.length - offset;

  const addr = u8();
  const signedAddr = (addr << 24) >> 24; // (int8_t)addr

  if (signedAddr === -1) {
    board.videoSystem = u8();
    board.units = u8();
    board.rssiAlarm = u8();
    board.capAlarm = u16();
    u16(); // skip unused
    board.altAlarm = u16();
    if (remaining() >= 2) board.enabledWarnings = u16();
    if (remaining() >= 4) {
      board.enabledWarnings =
        (payload[offset] |
          (payload[offset + 1] << 8) |
          (payload[offset + 2] << 16) |
          (payload[offset + 3] << 24)) >>>
        0;
      offset += 4;
    }
    if (remaining() >= 1) board.profileIndex = u8();
    if (remaining() >= 1) board.overlayRadioMode = u8();
    if (remaining() >= 2) {
      board.cameraFrameWidth = u8();
      board.cameraFrameHeight = u8();
    }
    if (remaining() >= 2) board.linkQualityAlarm = u16();
    if (remaining() >= 2) {
      const raw = u16();
      board.rssiDbmAlarm = (raw << 16) >> 16; // stored as int16
    }
    return {ok: true};
  }

  if (signedAddr === -2) {
    const index = u8();
    if (index > TIMER_COUNT) return {ok: false, reason: 'MSP_RESULT_ERROR'};
    board.timers[index] = u16();
    return {ok: true};
  }

  const value = u16();
  // "Get screen index, 0 is post flight statistics, 1 and above are in
  //  flight OSD screens" - absent means 1.
  const screen = remaining() >= 1 ? u8() : 1;
  if (screen === 0 && addr < STAT_COUNT) {
    board.statState[addr] = value !== 0;
    return {ok: true};
  }
  if (addr < ITEM_COUNT) {
    board.itemPos[addr] = value;
    return {ok: true};
  }
  return {ok: false, reason: 'MSP_RESULT_ERROR'};
}

function readBoard(board: VirtualOsdState): MspOsdSnapshot {
  return {
    config: decodeOsdConfiguration(serializeOsdConfig(board)),
    canvas: {columns: 53, rows: 20},
  };
}

/* ------------------------------------------------------------------ *
 * Reading what the board actually holds
 * ------------------------------------------------------------------ */

describe('the app reads the virtual board exactly as Betaflight serialises it', () => {
  const board = freshBoard();
  const snapshot = readBoard(board);

  it('reads every scalar field at the right offset, width and sign', () => {
    expect(snapshot.config.videoSystem).toBe(3);
    expect(snapshot.config.units).toBe(1);
    expect(snapshot.config.rssiAlarmPercent).toBe(37);
    expect(snapshot.config.capacityAlarmMah).toBe(1673);
    expect(snapshot.config.altitudeAlarm).toBe(742);
    expect(snapshot.config.enabledWarnings).toBe(0x0002a19f);
    expect(snapshot.config.profileCount).toBe(PROFILE_COUNT);
    expect(snapshot.config.selectedProfile).toBe(2);
    expect(snapshot.config.overlayRadioMode).toBe(5);
    expect(snapshot.config.cameraFrameWidth).toBe(27);
    expect(snapshot.config.cameraFrameHeight).toBe(13);
    expect(snapshot.config.linkQualityAlarmPercent).toBe(63);
    /* SIGNED. A dBm alarm read as unsigned would come back 65439 and be
       silently clamped or rejected somewhere far from here. */
    expect(snapshot.config.rssiDbmAlarm).toBe(-97);
  });

  it('reads every count the board declared, not a count of its own', () => {
    expect(snapshot.config.elementPositions).toHaveLength(ITEM_COUNT);
    expect(snapshot.config.statistics).toHaveLength(STAT_COUNT);
    expect(snapshot.config.timers).toHaveLength(TIMER_COUNT);
    expect(snapshot.config.warningCount).toBe(WARNING_COUNT);
    expect([...snapshot.config.statistics]).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
    expect([...snapshot.config.timers]).toEqual([0x1421, 0x0a35]);
  });

  it('unpacks every element to the cell the board put it in', () => {
    for (let index = 0; index < ITEM_COUNT; index += 1) {
      const packed = snapshot.config.elementPositions[index];
      expect(`${index}: x=${osdPositionX(packed)}`).toBe(
        `${index}: x=${index % 47}`,
      );
      expect(`${index}: y=${osdPositionY(packed)}`).toBe(
        `${index}: y=${index % 17}`,
      );
      expect(`${index}: p1=${osdVisibleInProfile(packed, 1)}`).toBe(
        `${index}: p1=${index % 2 === 0}`,
      );
    }
  });

  /**
   * x is SIX bits, split across the word: bits 4-0 and bit 10. An
   * implementation that used five bits would silently wrap every column
   * past 31 - which is most of an HD screen.
   */
  it('carries a column beyond 31, where the sixth bit lives', () => {
    const wide = setOsdPosition(0, 52, 19);
    expect(osdPositionX(wide)).toBe(52);
    expect(osdPositionY(wide)).toBe(19);
    expect(wide & 0x400).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Writing, and what the board holds afterwards
 * ------------------------------------------------------------------ */

describe('what the operator places is what the board applies', () => {
  it('moves the element that was moved, and only that one', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const before = [...board.itemPos];

    // Move RSSI dBm (index 55) to a cell nothing else occupies.
    const TARGET = 55;
    const draft = {
      ...createOsdConfigurationDraft(snapshot),
      elementPositions: snapshot.config.elementPositions.map((value, index) =>
        index === TARGET ? setOsdPosition(value, 43, 11) : value,
      ),
    };

    const writes = encodeChangedOsdConfiguration(snapshot, draft);
    expect(writes.map(write => write.group)).toEqual(['ELEMENT']);
    for (const write of writes) {
      expect(applySetOsdConfig(board, write.payload)).toEqual({ok: true});
    }

    const after = readBoard(board);
    expect(osdPositionX(after.config.elementPositions[TARGET])).toBe(43);
    expect(osdPositionY(after.config.elementPositions[TARGET])).toBe(11);

    // NOTHING ELSE MOVED. This is the assertion that catches a shifted
    // address: a write applied to the wrong index shows up here as two
    // changed elements, not one.
    const moved = board.itemPos
      .map((value, index) => (value === before[index] ? -1 : index))
      .filter(index => index >= 0);
    expect(moved).toEqual([TARGET]);
  });

  it('leaves profile visibility and variant untouched when only the cell changes', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const TARGET = 46; // LINK_QUALITY, visible in profile 1 (even index)
    const original = snapshot.config.elementPositions[TARGET];
    expect(osdVisibleInProfile(original, 1)).toBe(true);

    const draft = {
      ...createOsdConfigurationDraft(snapshot),
      elementPositions: snapshot.config.elementPositions.map((value, index) =>
        index === TARGET ? setOsdPosition(value, 7, 3) : value,
      ),
    };
    for (const write of encodeChangedOsdConfiguration(snapshot, draft)) {
      applySetOsdConfig(board, write.payload);
    }

    const after = readBoard(board).config.elementPositions[TARGET];
    expect(osdPositionX(after)).toBe(7);
    expect(osdPositionY(after)).toBe(3);
    // Still visible, and the variant bits are as they were.
    expect(osdVisibleInProfile(after, 1)).toBe(true);
    expect(after & 0xc000).toBe(original & 0xc000);
  });

  /**
   * The screen byte is the difference between "position element 3" and
   * "switch statistic 3 on". Both start with the same address byte, so
   * getting it wrong silently rewrites the wrong thing.
   */
  it('addresses elements and statistics distinctly, via the screen byte', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const statsBefore = [...board.statState];
    const positionsBefore = [...board.itemPos];

    // An ELEMENT write at index 1.
    const moveDraft = {
      ...createOsdConfigurationDraft(snapshot),
      elementPositions: snapshot.config.elementPositions.map((value, index) =>
        index === 1 ? setOsdPosition(value, 30, 9) : value,
      ),
    };
    for (const write of encodeChangedOsdConfiguration(snapshot, moveDraft)) {
      expect(write.payload[3]).toBe(1); // screen >= 1 -> element
      applySetOsdConfig(board, write.payload);
    }
    // Statistic 1 is untouched.
    expect(board.statState).toEqual(statsBefore);

    // A STATISTIC write at the same index 1.
    const statDraft = {
      ...createOsdConfigurationDraft(readBoard(board)),
      statistics: snapshot.config.statistics.map((value, index) =>
        index === 1 ? !value : value,
      ),
    };
    const statWrites = encodeChangedOsdConfiguration(readBoard(board), statDraft);
    expect(statWrites.map(write => write.group)).toEqual(['STATISTIC']);
    for (const write of statWrites) {
      expect(write.payload[3]).toBe(0); // screen 0 -> statistic
      applySetOsdConfig(board, write.payload);
    }
    expect(board.statState[1]).toBe(!statsBefore[1]);
    // ...and element 1 kept the cell the first write gave it.
    expect(osdPositionX(board.itemPos[1])).toBe(30);
    expect(board.itemPos[0]).toBe(positionsBefore[0]);
  });

  it('round-trips every general field, including the negative dBm alarm', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const draft = {
      ...createOsdConfigurationDraft(snapshot),
      rssiAlarmPercent: 41,
      capacityAlarmMah: 2340,
      altitudeAlarm: 1234,
      linkQualityAlarmPercent: 71,
      rssiDbmAlarm: -113,
      cameraFrameWidth: 29,
      cameraFrameHeight: 15,
      selectedProfile: 3,
      units: 0,
    };
    const writes = encodeChangedOsdConfiguration(snapshot, draft);
    expect(writes.map(write => write.group)).toEqual(['GENERAL']);
    expect(applySetOsdConfig(board, writes[0].payload)).toEqual({ok: true});

    const after = readBoard(board).config;
    expect(after.rssiAlarmPercent).toBe(41);
    expect(after.capacityAlarmMah).toBe(2340);
    expect(after.altitudeAlarm).toBe(1234);
    expect(after.linkQualityAlarmPercent).toBe(71);
    expect(after.rssiDbmAlarm).toBe(-113);
    expect(after.cameraFrameWidth).toBe(29);
    expect(after.cameraFrameHeight).toBe(15);
    expect(after.selectedProfile).toBe(3);
    expect(after.units).toBe(0);
    // Elements and statistics are not collateral damage of a general write.
    expect(board.itemPos).toEqual(freshBoard().itemPos);
  });

  it('writes a timer through the -2 address, and only the one timer', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const draft = {
      ...createOsdConfigurationDraft(snapshot),
      timers: [0x1421, 0x3b07],
    };
    const writes = encodeChangedOsdConfiguration(snapshot, draft);
    expect(writes.map(write => write.group)).toEqual(['TIMER']);
    expect(writes[0].payload[0]).toBe(0xfe);
    expect(writes[0].payload[1]).toBe(1);
    applySetOsdConfig(board, writes[0].payload);
    expect(board.timers).toEqual([0x1421, 0x3b07]);
  });

  /**
   * A save touches several groups. Each one must land on its own field
   * without the later writes undoing the earlier ones - the
   * shared-payload corruption case.
   */
  it('applies a mixed save without one group overwriting another', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const draft = {
      ...createOsdConfigurationDraft(snapshot),
      rssiAlarmPercent: 44,
      elementPositions: snapshot.config.elementPositions.map((value, index) =>
        index === 12 ? setOsdPosition(value, 21, 4) : value,
      ),
      statistics: snapshot.config.statistics.map((value, index) =>
        index === 4 ? !value : value,
      ),
      timers: [0x1421, 0x2c11],
    };
    const writes = encodeChangedOsdConfiguration(snapshot, draft);
    expect(writes.map(write => write.group)).toEqual([
      'GENERAL',
      'ELEMENT',
      'STATISTIC',
      'TIMER',
    ]);
    for (const write of writes) {
      expect(applySetOsdConfig(board, write.payload)).toEqual({ok: true});
    }

    const after = readBoard(board).config;
    expect(after.rssiAlarmPercent).toBe(44);
    expect(osdPositionX(after.elementPositions[12])).toBe(21);
    expect(osdPositionY(after.elementPositions[12])).toBe(4);
    expect(after.statistics[4]).toBe(!snapshot.config.statistics[4]);
    expect([...after.timers]).toEqual([0x1421, 0x2c11]);
    // And the untouched neighbours are exactly as they were.
    expect(after.elementPositions[11]).toBe(snapshot.config.elementPositions[11]);
    expect(after.elementPositions[13]).toBe(snapshot.config.elementPositions[13]);
  });

  it('emits nothing at all when nothing changed', () => {
    const board = freshBoard();
    const snapshot = readBoard(board);
    const unchanged = createOsdConfigurationDraft(snapshot);
    expect(encodeChangedOsdConfiguration(snapshot, unchanged)).toEqual([]);
  });

  /**
   * The board rejects an address past its own element count. Proving the
   * virtual controller enforces it keeps the other tests honest: they
   * pass because the addresses are right, not because nothing is checked.
   */
  it('is refused by the board when the address is out of range', () => {
    const board = freshBoard();
    const outOfRange = Uint8Array.from([ITEM_COUNT + 1, 0x00, 0x00, 1]);
    expect(applySetOsdConfig(board, outOfRange)).toEqual({
      ok: false,
      reason: 'MSP_RESULT_ERROR',
    });
  });
});

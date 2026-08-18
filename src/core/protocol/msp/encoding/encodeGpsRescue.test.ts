/**
 * WHAT LEAVES FOR THE FLIGHT CONTROLLER when a rescue parameter changes.
 *
 * The three properties that matter, in order of how badly getting them
 * wrong would end:
 *
 *   1. A round trip is byte-identical. Encoding a draft that changed
 *      nothing must reproduce the board's own payload exactly - if it
 *      does not, then every save silently rewrites something.
 *   2. The four autopilot fields are echoed, never re-derived. They drive
 *      Altitude Hold and Position Hold; a save from the GPS Rescue card
 *      must not move them.
 *   3. The frame never grows. The firmware guards each appended block
 *      with `sbufBytesRemaining(src) >= N`, so a short frame is safe and
 *      a long one writes into fields whose contract we never verified.
 */

import {decodeGpsRescue, GPS_RESCUE_FULL_BYTES, GPS_RESCUE_WITH_RATES_BYTES, GPS_RESCUE_BASE_BYTES} from '../decoding/decodeGpsRescue';
import {gpsRescuePayload} from '../../__testUtils__/gpsRescueFixtures';
import {createGpsRescueDraft} from '../../../state/gpsRescueConfigurationModel';
import {encodeChangedGpsRescue, encodeGpsRescue} from './encodeGpsRescue';

describe('encodeGpsRescue', () => {
  it('round-trips a board byte for byte when nothing was edited', () => {
    const payload = gpsRescuePayload();
    const snapshot = decodeGpsRescue(payload);

    const encoded = encodeGpsRescue(snapshot, createGpsRescueDraft(snapshot));

    expect(Array.from(encoded)).toEqual(Array.from(payload));
  });

  it('changes exactly the two bytes of the field that was edited', () => {
    const payload = gpsRescuePayload();
    const snapshot = decodeGpsRescue(payload);
    // 120 -> 300 moves BOTH bytes of the field (0x0078 -> 0x012C), so a
    // high byte left stale would show up here rather than hiding behind
    // a value whose top half happens to be unchanged.
    const draft = {...createGpsRescueDraft(snapshot), returnAltitudeM: 300};

    const encoded = encodeGpsRescue(snapshot, draft);

    const differing = Array.from(encoded).flatMap((byte, index) => (byte === payload[index] ? [] : [index]));
    expect(differing).toEqual([2, 3]);
    expect(new DataView(encoded.buffer).getUint16(2, true)).toBe(300);
  });

  it('echoes the autopilot fields it is not allowed to touch', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload({angle: 55, throttleHover: 1310}));
    const draft = {...createGpsRescueDraft(snapshot), minSats: 12};

    const view = new DataView(encodeGpsRescue(snapshot, draft).buffer);

    expect(view.getUint16(0, true)).toBe(55); // angle
    expect(view.getUint16(8, true)).toBe(1150); // throttleMin
    expect(view.getUint16(10, true)).toBe(1850); // throttleMax
    expect(view.getUint16(12, true)).toBe(1310); // throttleHover
  });
});

describe('the frame length follows the board, never this build', () => {
  it('writes 16 bytes to a board that sent 16', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload({}, GPS_RESCUE_BASE_BYTES));
    const encoded = encodeGpsRescue(snapshot, {...createGpsRescueDraft(snapshot), minSats: 11});
    expect(encoded).toHaveLength(GPS_RESCUE_BASE_BYTES);
  });

  it('writes 22 bytes to a board that sent 22', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload({}, GPS_RESCUE_WITH_RATES_BYTES));
    const encoded = encodeGpsRescue(snapshot, {...createGpsRescueDraft(snapshot), ascendRate: 700});
    expect(encoded).toHaveLength(GPS_RESCUE_WITH_RATES_BYTES);
    expect(new DataView(encoded.buffer).getUint16(16, true)).toBe(700);
  });

  it('does NOT try to reproduce the tail of a board newer than this build', () => {
    // Decoding capped presentFieldCount at 26, so the write is 26 and the
    // firmware's own length guards leave the newer fields alone. Writing
    // 34 bytes here would be inventing values for fields we never read.
    const future = new Uint8Array(GPS_RESCUE_FULL_BYTES + 8);
    future.set(gpsRescuePayload());
    future.fill(0xab, GPS_RESCUE_FULL_BYTES);
    const snapshot = decodeGpsRescue(future);

    const encoded = encodeGpsRescue(snapshot, {...createGpsRescueDraft(snapshot), minSats: 14});

    expect(encoded).toHaveLength(GPS_RESCUE_FULL_BYTES);
  });
});

describe('encodeChangedGpsRescue', () => {
  it('sends nothing at all when the draft matches the board', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload());
    expect(encodeChangedGpsRescue(snapshot, createGpsRescueDraft(snapshot))).toBeUndefined();
  });

  it('refuses to encode a value the firmware itself would reject', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload());
    // 4000 m is outside settings.c's 5..1000 for gps_rescue_return_alt.
    expect(() => encodeChangedGpsRescue(snapshot, {...createGpsRescueDraft(snapshot), returnAltitudeM: 4000})).toThrow(RangeError);
  });

  it('refuses a value that cannot survive the wire, whatever the range says', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload());
    // setUint16 would silently wrap this; the aircraft would get a number
    // nobody chose. Encoding must fail loudly instead.
    expect(() => encodeChangedGpsRescue(snapshot, {...createGpsRescueDraft(snapshot), descentDistanceM: 70000})).toThrow(RangeError);
  });
});

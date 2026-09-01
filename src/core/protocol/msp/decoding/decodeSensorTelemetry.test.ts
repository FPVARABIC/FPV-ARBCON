import {decodeAltitude, decodeRawImu} from './decodeSensorTelemetry';
describe('sensor telemetry decoders', () => {it('decodes all nine signed IMU axes', () => {const bytes = new Uint8Array(18); const view = new DataView(bytes.buffer); [-2048, 0, 2048, -90, 15, 180, -300, 20, 400].forEach((value, index) => view.setInt16(index * 2, value, true)); expect(decodeRawImu(bytes)).toEqual({accelerometer: {x: -2048, y: 0, z: 2048}, gyroscopeDps: {x: -90, y: 15, z: 180}, magnetometer: {x: -300, y: 20, z: 400}});}); it('decodes signed altitude and variometer', () => {const bytes = new Uint8Array(6); const view = new DataView(bytes.buffer); view.setInt32(0, -125, true); view.setInt16(4, -45, true); expect(decodeAltitude(bytes)).toEqual({altitudeCm: -125, variometerCms: -45});}); it('reads a truncated or extended frame instead of throwing', () => {
  // Betaflight reads MSP_RAW_IMU and MSP_ALTITUDE positionally with no length
  // guard (MSPHelper.js). These drive the live Sensors traces; one short frame
  // must not tear the screen down.
  expect(() => decodeRawImu(new Uint8Array(17))).not.toThrow();
  expect(decodeRawImu(new Uint8Array(17)).magnetometer.z).toBe(0);
  expect(() => decodeAltitude(new Uint8Array(5))).not.toThrow();
  expect(() => decodeRawImu(new Uint8Array(24))).not.toThrow();
 });});

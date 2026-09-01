/**
 * MSP2_GYRO_SENSOR_ACTIVE (0x300D) - which gyro was found in each slot.
 *
 * MSP2_SENSOR_CONFIG_ACTIVE's byte 0 reports one gyro: the first enabled
 * one. A board with two gyro devices has two answers, and this is the
 * command that gives both.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP2_GYRO_SENSOR_ACTIVE):
 *
 *     sbufWriteU8(dst, GYRO_COUNT);
 *     for (unsigned i = 0; i < GYRO_COUNT; i++) {
 *         sbufWriteU8(dst, detectedGyros[i]);
 *     }
 *
 * So: a count byte, then that many hardware bytes. GYRO_COUNT is how many
 * gyro SLOTS the build has, not how many gyros were found - every slot
 * appears, and an empty one appears as GYRO_NONE.
 *
 * AN EMPTY PAYLOAD IS LEGAL AND MEANS SOMETHING. The whole body sits
 * inside `#ifdef USE_GYRO`, with no `#else`. A build without gyro support
 * answers this command with zero bytes - not a count of zero, no bytes at
 * all. That is typed absence here rather than an empty list, because
 * "this firmware has no gyro support" and "this firmware has gyro support
 * and reports no slots" are different claims and only one of them is on
 * the wire.
 *
 * GYRO_NONE IS ZERO. Unlike the accelerometer, barometer and
 * magnetometer lists, `gyroHardware_e` starts `GYRO_NONE = 0,
 * GYRO_DEFAULT = 1` (src/main/drivers/accgyro/accgyro.h). A slot that
 * found nothing reports 0, and `detectedGyros` is memset to zero before
 * detection for exactly that reason (src/main/sensors/gyro_init.c). Read
 * with any other family's table, an empty slot would report as "the
 * default gyro".
 *
 * THE COUNT IS TRUSTED, THEN CHECKED. A count that promises more bytes
 * than arrived is a truncated frame and is refused. The alternative -
 * returning the slots that did fit - would report a two-gyro board as a
 * one-gyro board, which is exactly the kind of quiet downgrade this layer
 * exists to prevent.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';
import {NOT_AVAILABLE_IN_THIS_CONTRACT} from './decodeSensorConfig';
import type {NotAvailableInThisContract} from './decodeSensorConfig';
import {
  modelSensorHardware,
  type SensorHardwareValue,
} from './sensorHardwareCatalog';

export type GyroSensorActive =
  | {
      /** Zero-byte payload: no gyro support compiled into this firmware. */
      readonly kind: NotAvailableInThisContract;
    }
  | {
      readonly kind: 'REPORTED';
      /** The count byte, exactly as sent. */
      readonly declaredCount: number;
      /** One entry per gyro SLOT, in slot order. */
      readonly gyros: readonly SensorHardwareValue[];
      /** Bytes past the declared count. */
      readonly trailingByteCount: number;
    };

export function decodeGyroSensorActive(payload: Uint8Array): GyroSensorActive {
  if (payload.length === 0) {
    return Object.freeze({kind: NOT_AVAILABLE_IN_THIS_CONTRACT});
  }
  const reader = new MspPayloadReader(payload);
  const declaredCount = reader.readU8();
  if (reader.remaining() < declaredCount) {
    throw new MspPayloadReadError(
      `MSP2_GYRO_SENSOR_ACTIVE declared ${declaredCount} gyro slot(s) but only ` +
        `${reader.remaining()} byte(s) followed the count.`,
    );
  }
  const gyros: SensorHardwareValue[] = [];
  for (let slot = 0; slot < declaredCount; slot++) {
    gyros.push(modelSensorHardware('GYRO', reader.readU8()));
  }
  return Object.freeze({
    kind: 'REPORTED' as const,
    declaredCount,
    gyros: Object.freeze(gyros),
    trailingByteCount: reader.remaining(),
  });
}

/**
 * STAGE B - THE IMMUTABLE DEVICE FLASH PLAN.
 *
 * A complete plan cannot exist before the device has been asked what it is:
 * the flash window, the page geometry and the erase form all depend on the
 * chip id, and that answer only arrives inside the bootloader handshake. So
 * the screen produces an ACCEPTED image snapshot, and the flasher - which
 * owns the handshake - calls this pure builder once it knows the profile.
 *
 * The plan is the SINGLE executable source of truth. Erase form, write
 * addresses and bytes, progress totals, verification ranges and the GO
 * address all come from this one object. Nothing downstream re-chunks the
 * image, recomputes a total or reaches for a module constant.
 *
 * This module is pure: no transport, no timers, no runtime state. Lease
 * ownership and destructive state deliberately live elsewhere - they are
 * properties of an operation in progress, not of a plan.
 */

import type {ByteRange} from '../../../core/firmware-flasher/byteRange';
import {makeRange, rangeContainsRange} from '../../../core/firmware-flasher/byteRange';
import type {
  AcceptedImageSnapshot,
  PlannedWriteBlock,
} from '../../../core/firmware-flasher/imagePreflight';
import {FIXED_APPLICATION_BASE_ADDRESS} from '../../../core/firmware-flasher/imagePreflight';
import type {FlashErrorCode} from '../../../core/firmware-flasher/flashErrorCodes';

/** Shape only - the profile TABLE stays with the flasher and is unchanged. */
export interface Stm32ChipProfile {
  readonly flashBytes: number;
  readonly pageBytes: number;
  readonly label: string;
}

export type Stm32ErasePlan =
  | {readonly kind: 'MASS'; readonly extended: boolean}
  | {readonly kind: 'PAGES'; readonly extended: boolean; readonly pageCount: number};

export interface DeviceFlashPlan {
  readonly profile: Stm32ChipProfile;
  readonly chipId: number;
  /** The device's writable window, half-open. */
  readonly window: ByteRange;
  /** Exact ordered write blocks with owned bytes, carried from Stage A. */
  readonly blocks: readonly PlannedWriteBlock[];
  /** The one total the progress relay may use. */
  readonly totalBytes: number;
  readonly erase: Stm32ErasePlan;
  readonly goAddress: number;
  readonly goCoverage: {readonly covered: boolean; readonly contiguousBytesAtGo: number};
}

export interface DeviceFlashPlanRejection {
  readonly code: FlashErrorCode;
  readonly detail: string;
}

export type DeviceFlashPlanResult =
  | {readonly accepted: true; readonly plan: DeviceFlashPlan}
  | {readonly accepted: false; readonly rejections: readonly DeviceFlashPlanRejection[]};

export interface DeviceFlashPlanInput {
  readonly snapshot: AcceptedImageSnapshot;
  readonly profile: Stm32ChipProfile;
  readonly chipId: number;
  readonly extendedEraseAvailable: boolean;
  readonly fullErase: boolean;
}

/**
 * Builds the plan, or refuses. Every refusal here is still PRE-DESTRUCTIVE:
 * the caller may not emit an erase until it holds an accepted plan.
 */
export function buildDeviceFlashPlan(input: DeviceFlashPlanInput): DeviceFlashPlanResult {
  const {snapshot, profile, chipId, extendedEraseAvailable, fullErase} = input;
  const rejections: DeviceFlashPlanRejection[] = [];

  const windowRange = makeRange(FIXED_APPLICATION_BASE_ADDRESS, profile.flashBytes);
  if (!windowRange.ok) {
    return {
      accepted: false,
      rejections: [
        {
          code: 'FLASH_PLAN_ADDRESS_RANGE_INVALID',
          detail: `flash window for ${profile.label}: ${windowRange.rejection}`,
        },
      ],
    };
  }
  const window = windowRange.range;

  if (snapshot.totalBytes >= profile.flashBytes) {
    rejections.push({
      code: 'STM32_IMAGE_TOO_LARGE',
      detail: `${snapshot.totalBytes} bytes does not fit ${profile.label}`,
    });
  }

  for (const block of snapshot.blocks) {
    if (!rangeContainsRange(window, block.range)) {
      rejections.push({
        code: 'STM32_IMAGE_OUT_OF_FLASH',
        detail:
          `block [0x${block.range.start.toString(16)}, 0x${block.range.endExclusive.toString(16)}) ` +
          `falls outside [0x${window.start.toString(16)}, 0x${window.endExclusive.toString(16)})`,
      });
    }
  }

  const pageCount = Math.ceil(
    (snapshot.highestAddressExclusive - FIXED_APPLICATION_BASE_ADDRESS) / profile.pageBytes,
  );
  /* EXACT PARITY with the pre-repair guard, which sat in the standard-erase
   * branch and fired regardless of `fullErase` even though a mass erase
   * never sends a page list. Narrowing it to the selective path would WIDEN
   * the set of images this product is willing to erase, which is not this
   * repair's business; the only change is that the refusal now happens
   * before the erase phase is even reported rather than inside it. */
  if (!extendedEraseAvailable && pageCount > 256) {
    rejections.push({
      code: 'STM32_PAGE_COUNT_REQUIRES_EXTENDED_ERASE',
      detail: `${pageCount} pages exceeds the 256 a standard erase can address`,
    });
  }

  /* Re-proven against the FINAL blocks rather than trusted from Stage A:
   * the plan is what executes, so the plan must carry its own proof. */
  const goAddress = snapshot.goPolicy.address;
  const goCovered = snapshot.blocks.some(
    block => goAddress >= block.range.start && goAddress < block.range.endExclusive,
  );
  if (!goCovered) {
    rejections.push({
      code: 'FLASH_PLAN_GO_NOT_COVERED',
      detail: `GO target 0x${goAddress.toString(16)} is not covered by the planned bytes`,
    });
  }

  if (rejections.length > 0) return {accepted: false, rejections};

  const erase: Stm32ErasePlan = fullErase
    ? {kind: 'MASS', extended: extendedEraseAvailable}
    : {kind: 'PAGES', extended: extendedEraseAvailable, pageCount};

  return {
    accepted: true,
    plan: {
      profile,
      chipId,
      window,
      blocks: snapshot.blocks,
      totalBytes: snapshot.totalBytes,
      erase,
      goAddress,
      goCoverage: snapshot.goCoverage,
    },
  };
}

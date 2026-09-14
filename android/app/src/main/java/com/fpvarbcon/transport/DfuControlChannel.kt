package com.fpvarbcon.transport

/**
 * EVERYTHING A DFU WORKER DOES TO A DEVICE, AS FOUR FUNCTIONS.
 *
 * DfuUnprotectWorker and DfuExitWorker are short, linear sequences of
 * control transfers with safety rules woven through them - a read-unprotect
 * that must see the busy state before it believes an erase started, an exit
 * whose failed manifestation is only an error if the board is still
 * attached, a mandatory erase guard that must not be skipped. Those rules
 * are the whole reason the files exist and none of them could be executed
 * off-device, because the workers held a UsbManager, a UsbDevice and a
 * UsbDeviceConnection directly:
 *
 *   - UsbDeviceConnection has no public constructor, so a JVM unit test
 *     cannot make one. That was written here before it was ever measured;
 *     run 34785383699 measured it. Its constructor is package-private AND
 *     takes no arguments, its body is `new RuntimeException("Stub!");
 *     athrow`, close() is the same, and there are sixteen references to
 *     that marker in the class. UsbDeviceConnectionStubTest now asserts it
 *     in the unit-test JVM on every run;
 *   - UsbDevice has none either, so an INSTRUMENTATION test cannot make
 *     one on a device with no board plugged in;
 *   - and a real board is out of scope by instruction.
 *
 * So the protocol moved behind this interface and the workers became
 * adapters that open, claim, delegate, release and close. The sequences are
 * now driven in a JVM test by a scripted device that answers control
 * transfers from a table, including the answers a real STM32 ROM gives that
 * are easy to get wrong: a stall after read-unprotect, a device that
 * vanishes mid-sequence, a status frame that is the wrong length.
 *
 * [sleep] is here for the same reason. DfuUnprotectWorker waits the
 * board-reported erase delay plus a twenty-second safety guard, and a test
 * that really slept would take twenty seconds and would be measuring the
 * clock rather than the sequence. Injected, the guard is asserted as a
 * DURATION THAT WAS REQUESTED rather than a duration that was endured - so
 * a change that quietly shortened it fails, which a sleeping test could
 * not do.
 */
internal interface DfuControlChannel {
  /**
   * Mirrors UsbDeviceConnection.controlTransfer: returns the number of
   * bytes transferred, or a negative number on failure. [buffer] is filled
   * in place for a device-to-host transfer.
   */
  fun controlTransfer(
    requestType: Int,
    request: Int,
    value: Int,
    index: Int,
    buffer: ByteArray?,
    length: Int,
    timeoutMs: Int,
  ): Int

  /**
   * Whether the SAME physical device - matched on device id, vendor and
   * product, not merely "a DFU device" - is still enumerated.
   *
   * This is the identity check that stops a re-enumerated or swapped board
   * satisfying a request made about a different one. A worker that only
   * asked "is any DFU device present" would accept the wrong board.
   */
  fun isSameDeviceAttached(): Boolean

  /** Injected so a safety delay can be asserted instead of endured. */
  fun sleep(millis: Long)
}

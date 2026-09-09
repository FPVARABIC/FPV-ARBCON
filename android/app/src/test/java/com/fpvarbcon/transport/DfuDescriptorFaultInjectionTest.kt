package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * THE BYTES COME FROM THE DEVICE, SO THEY ARE NOT TRUSTED.
 *
 * findInterfaceStringIndex, decodeUsbStringDescriptor and
 * findDfuTransferSize all walk a raw USB descriptor block that a board
 * hands over. Until now they had two happy-path tests between them and no
 * fault injection at all - which is the wrong way round for the three
 * functions in this codebase whose entire input is attacker- or
 * malfunction-controlled, and whose answers decide which memory region
 * gets erased and how large each write is.
 *
 * The cases below are the malformed shapes a real bus produces: a
 * truncated read, a descriptor whose declared length runs past the buffer,
 * a zero length (which is what would spin a naive descriptor walk
 * forever), a string that is not a string, an odd number of UTF-16 bytes,
 * and a transfer size outside anything usable.
 *
 * Every one of them must produce a null or a bounded answer. None of them
 * may throw, hang, or read past the end of the array.
 */
class DfuDescriptorFaultInjectionTest {

  private fun bytes(vararg values: Int): ByteArray =
    ByteArray(values.size) { values[it].toByte() }

  /** bLength, bDescriptorType=0x04, bInterfaceNumber, bAlternateSetting, ..., iInterface */
  private fun interfaceDescriptor(
    number: Int,
    alternate: Int,
    stringIndex: Int,
    length: Int = 9,
    interfaceClass: Int = 0xfe,
    interfaceSubclass: Int = 0x01,
  ): ByteArray = bytes(
    length, 0x04, number, alternate, 0x00,
    interfaceClass, interfaceSubclass, 0x02, stringIndex,
  )

  /** bLength=9, bDescriptorType=0x21, bmAttributes, wDetachTimeOut, wTransferSize, bcdDFUVersion */
  private fun dfuFunctional(transferSize: Int, length: Int = 9): ByteArray = bytes(
    length, 0x21, 0x0b, 0xff, 0x00,
    transferSize and 0xff, (transferSize shr 8) and 0xff,
    0x1a, 0x01,
  )

  // =====================================================================
  // findInterfaceStringIndex
  // =====================================================================

  @Test
  fun anEmptyDescriptorBlockYieldsNoStringIndex() {
    assertNull(findInterfaceStringIndex(ByteArray(0), 0, 0))
  }

  @Test
  fun aSingleStrayByteYieldsNoStringIndex() {
    assertNull(findInterfaceStringIndex(bytes(0x09), 0, 0))
  }

  /**
   * A zero bLength is the shape that spins a descriptor walk forever:
   * offset never advances. It must terminate, and it must not answer.
   *
   * The timeout is deliberate. Without it, deleting the `length < 2`
   * guard turns this case into a HANG rather than a failure, and a
   * hanging suite tells a reader far less than a failing one. Two seconds
   * is thousands of times the real cost of walking four bytes.
   */
  @Test(timeout = 2_000)
  fun aZeroLengthDescriptorTerminatesInsteadOfLooping() {
    assertNull(findInterfaceStringIndex(bytes(0x00, 0x04, 0x00, 0x00), 0, 0))
    assertNull(findDfuTransferSize(bytes(0x00, 0x21, 0x00, 0x00), 0, 0))
  }

  @Test
  fun aLengthOfOneIsRejected() {
    assertNull(findInterfaceStringIndex(bytes(0x01, 0x04, 0x00, 0x00), 0, 0))
  }

  /** A declared length running past the buffer must not be read past. */
  @Test
  fun aDescriptorClaimingMoreBytesThanExistIsRejected() {
    assertNull(findInterfaceStringIndex(bytes(0x40, 0x04, 0x00, 0x00, 0x00), 0, 0))
  }

  @Test
  fun anInterfaceDescriptorTruncatedBeforeItsStringIndexIsNotRead() {
    // bLength 8 is a short interface descriptor: iInterface at offset+8 is
    // outside it, so it must be skipped rather than read from whatever
    // follows.
    val raw = interfaceDescriptor(number = 1, alternate = 0, stringIndex = 7, length = 8)
      .copyOf(8) + bytes(0xAA)
    assertNull(findInterfaceStringIndex(raw, 1, 0))
  }

  /** iInterface == 0 is USB's "there is no string here". */
  @Test
  fun aZeroStringIndexMeansNoString() {
    val raw = interfaceDescriptor(number = 1, alternate = 1, stringIndex = 0)
    assertNull(findInterfaceStringIndex(raw, 1, 1))
  }

  @Test
  fun aDifferentAlternateIsNotMistakenForTheWantedOne() {
    val raw = interfaceDescriptor(number = 1, alternate = 0, stringIndex = 4) +
      interfaceDescriptor(number = 1, alternate = 1, stringIndex = 5)
    assertEquals(4, findInterfaceStringIndex(raw, 1, 0))
    assertEquals(5, findInterfaceStringIndex(raw, 1, 1))
    assertNull(findInterfaceStringIndex(raw, 1, 2))
    assertNull(findInterfaceStringIndex(raw, 2, 0))
  }

  // =====================================================================
  // decodeUsbStringDescriptor
  // =====================================================================

  @Test
  fun aShortReadDecodesToNothing() {
    assertNull(decodeUsbStringDescriptor(ByteArray(0), 0))
    assertNull(decodeUsbStringDescriptor(bytes(0x04), 1))
  }

  @Test
  fun aDescriptorThatIsNotAStringIsRejected() {
    // Type 0x04 is an interface descriptor, not a string descriptor.
    assertNull(decodeUsbStringDescriptor(bytes(0x06, 0x04, 0x41, 0x00, 0x42, 0x00), 6))
  }

  @Test
  fun anEmptyStringDescriptorDecodesToNothing() {
    assertNull(decodeUsbStringDescriptor(bytes(0x02, 0x03), 2))
  }

  @Test
  fun aWhitespaceOnlyStringDecodesToNothing() {
    val raw = bytes(0x06, 0x03, 0x20, 0x00, 0x20, 0x00)
    assertNull(decodeUsbStringDescriptor(raw, 6))
  }

  @Test
  fun trailingNullsAreTrimmed() {
    val raw = bytes(0x08, 0x03, 0x41, 0x00, 0x42, 0x00, 0x00, 0x00)
    assertEquals("AB", decodeUsbStringDescriptor(raw, 8))
  }

  /**
   * A device that returns fewer bytes than it declared, and one that
   * declares fewer than it returned: the shorter of the two wins, and
   * neither reads past the buffer.
   */
  @Test
  fun theShorterOfDeclaredAndReceivedLengthIsUsed() {
    val raw = bytes(0x08, 0x03, 0x41, 0x00, 0x42, 0x00, 0x43, 0x00)
    assertEquals("A", decodeUsbStringDescriptor(raw, 4))
    val overDeclared = bytes(0x40, 0x03, 0x41, 0x00)
    assertEquals("A", decodeUsbStringDescriptor(overDeclared, 4))
  }

  /** An odd payload cannot be whole UTF-16 units; the stray byte is dropped. */
  @Test
  fun anOddNumberOfPayloadBytesIsTruncatedRatherThanDecodedRagged() {
    val raw = bytes(0x05, 0x03, 0x41, 0x00, 0x42)
    assertEquals("A", decodeUsbStringDescriptor(raw, 5))
  }

  @Test
  fun aDeclaredLengthOfZeroDecodesToNothing() {
    assertNull(decodeUsbStringDescriptor(bytes(0x00, 0x03, 0x41, 0x00), 4))
  }

  @Test
  fun aRealMemoryLayoutStringSurvivesTheRoundTrip() {
    val text = "@Internal Flash /0x08000000/04*016Kg,01*064Kg,07*128Kg"
    val payload = text.toByteArray(Charsets.UTF_16LE)
    val raw = bytes(payload.size + 2, 0x03) + payload
    assertEquals(text, decodeUsbStringDescriptor(raw, raw.size))
    // and it still parses as a layout, which is the only reason to read it
    assertEquals("Internal Flash", DfuMemoryLayout.parse(text).name)
  }

  // =====================================================================
  // findDfuTransferSize
  // =====================================================================

  @Test
  fun aFunctionalDescriptorBeforeAnyInterfaceIsNotAttributedToOne() {
    val raw = dfuFunctional(2048) + interfaceDescriptor(1, 0, 4)
    assertNull(findDfuTransferSize(raw, 1, 0))
  }

  @Test
  fun aFunctionalDescriptorBelongingToAnotherAlternateIsNotUsed() {
    val raw = interfaceDescriptor(1, 0, 4) + dfuFunctional(1024) +
      interfaceDescriptor(1, 1, 5) + dfuFunctional(2048)
    assertEquals(1024, findDfuTransferSize(raw, 1, 0))
    assertEquals(2048, findDfuTransferSize(raw, 1, 1))
    assertNull(findDfuTransferSize(raw, 1, 2))
  }

  @Test
  fun aTruncatedFunctionalDescriptorIsSkipped() {
    // bLength 6 cannot carry wTransferSize at offsets 5..6.
    val raw = interfaceDescriptor(1, 0, 4) + bytes(0x06, 0x21, 0x0b, 0xff, 0x00, 0x08)
    assertNull(findDfuTransferSize(raw, 1, 0))
  }

  @Test
  fun anImplausibleTransferSizeIsRefusedRatherThanUsed() {
    val tooSmall = interfaceDescriptor(1, 0, 4) + dfuFunctional(63)
    val tooLarge = interfaceDescriptor(1, 0, 4) + dfuFunctional(16 * 1024 + 1)
    val zero = interfaceDescriptor(1, 0, 4) + dfuFunctional(0)
    assertNull(findDfuTransferSize(tooSmall, 1, 0))
    assertNull(findDfuTransferSize(tooLarge, 1, 0))
    assertNull(findDfuTransferSize(zero, 1, 0))
  }

  /** The two ends of the accepted range are accepted. */
  @Test
  fun theBoundsOfTheAcceptedTransferSizeRangeAreInclusive() {
    assertEquals(64, findDfuTransferSize(interfaceDescriptor(1, 0, 4) + dfuFunctional(64), 1, 0))
    assertEquals(
      16 * 1024,
      findDfuTransferSize(interfaceDescriptor(1, 0, 4) + dfuFunctional(16 * 1024), 1, 0),
    )
  }

  @Test
  fun aBlockTruncatedAfterTheInterfaceYieldsNoTransferSize() {
    val raw = interfaceDescriptor(1, 0, 4) + bytes(0x09)
    assertNull(findDfuTransferSize(raw, 1, 0))
  }
}

package com.fpvarbcon.transport

import android.hardware.usb.UsbDeviceConnection

internal fun findInterfaceStringIndex(
  rawDescriptors: ByteArray,
  interfaceNumber: Int,
  alternateSetting: Int,
): Int? {
  var offset = 0
  while (offset + 2 <= rawDescriptors.size) {
    val length = rawDescriptors[offset].toInt() and 0xff
    val type = rawDescriptors[offset + 1].toInt() and 0xff
    if (length < 2 || offset + length > rawDescriptors.size) return null
    if (type == USB_DESCRIPTOR_TYPE_INTERFACE && length >= 9) {
      val number = rawDescriptors[offset + 2].toInt() and 0xff
      val alternate = rawDescriptors[offset + 3].toInt() and 0xff
      if (number == interfaceNumber && alternate == alternateSetting) {
        val index = rawDescriptors[offset + 8].toInt() and 0xff
        return index.takeIf { it != 0 }
      }
    }
    offset += length
  }
  return null
}

internal fun decodeUsbStringDescriptor(bytes: ByteArray, received: Int): String? {
  if (received < 2) return null
  val declared = bytes[0].toInt() and 0xff
  if ((bytes[1].toInt() and 0xff) != USB_DESCRIPTOR_TYPE_STRING) return null
  val usable = minOf(received, declared, bytes.size)
  if (usable < 4) return null
  val evenEnd = usable - ((usable - 2) % 2)
  return bytes.copyOfRange(2, evenEnd)
    .toString(Charsets.UTF_16LE)
    .trimEnd('\u0000')
    .takeIf { it.isNotBlank() }
}

internal fun findDfuTransferSize(
  rawDescriptors: ByteArray,
  interfaceNumber: Int,
  alternateSetting: Int,
): Int? {
  var offset = 0
  var inSelectedInterface = false
  while (offset + 2 <= rawDescriptors.size) {
    val length = rawDescriptors[offset].toInt() and 0xff
    val type = rawDescriptors[offset + 1].toInt() and 0xff
    if (length < 2 || offset + length > rawDescriptors.size) return null
    if (type == USB_DESCRIPTOR_TYPE_INTERFACE && length >= 9) {
      val number = rawDescriptors[offset + 2].toInt() and 0xff
      val alternate = rawDescriptors[offset + 3].toInt() and 0xff
      inSelectedInterface = number == interfaceNumber && alternate == alternateSetting
    } else if (inSelectedInterface && type == USB_DESCRIPTOR_TYPE_DFU_FUNCTIONAL && length >= 7) {
      val size = (rawDescriptors[offset + 5].toInt() and 0xff) or
        ((rawDescriptors[offset + 6].toInt() and 0xff) shl 8)
      return size.takeIf { it in MIN_DFU_TRANSFER_SIZE..MAX_DFU_TRANSFER_SIZE }
    }
    offset += length
  }
  return null
}

internal fun readInterfaceStringDescriptor(
  connection: UsbDeviceConnection,
  interfaceNumber: Int,
  alternateSetting: Int,
): String? {
  val stringIndex = findInterfaceStringIndex(
    connection.rawDescriptors ?: return null,
    interfaceNumber,
    alternateSetting,
  ) ?: return null
  val buffer = ByteArray(MAX_USB_STRING_DESCRIPTOR_BYTES)
  val languages = connection.controlTransfer(
    USB_REQUEST_TYPE_DEVICE_TO_HOST,
    USB_REQUEST_GET_DESCRIPTOR,
    USB_DESCRIPTOR_TYPE_STRING shl 8,
    0,
    buffer,
    buffer.size,
    USB_DESCRIPTOR_TIMEOUT_MS,
  )
  val languageId = if (languages >= 4) {
    (buffer[2].toInt() and 0xff) or ((buffer[3].toInt() and 0xff) shl 8)
  } else {
    DEFAULT_USB_LANGUAGE_ID
  }
  buffer.fill(0)
  val received = connection.controlTransfer(
    USB_REQUEST_TYPE_DEVICE_TO_HOST,
    USB_REQUEST_GET_DESCRIPTOR,
    (USB_DESCRIPTOR_TYPE_STRING shl 8) or stringIndex,
    languageId,
    buffer,
    buffer.size,
    USB_DESCRIPTOR_TIMEOUT_MS,
  )
  return if (received > 0) decodeUsbStringDescriptor(buffer, received) else null
}

private const val USB_DESCRIPTOR_TYPE_INTERFACE = 0x04
private const val USB_DESCRIPTOR_TYPE_STRING = 0x03
private const val USB_DESCRIPTOR_TYPE_DFU_FUNCTIONAL = 0x21
private const val USB_REQUEST_TYPE_DEVICE_TO_HOST = 0x80
private const val USB_REQUEST_GET_DESCRIPTOR = 0x06
private const val DEFAULT_USB_LANGUAGE_ID = 0x0409
private const val MAX_USB_STRING_DESCRIPTOR_BYTES = 255
private const val USB_DESCRIPTOR_TIMEOUT_MS = 2_000
private const val MIN_DFU_TRANSFER_SIZE = 64
private const val MAX_DFU_TRANSFER_SIZE = 16 * 1024

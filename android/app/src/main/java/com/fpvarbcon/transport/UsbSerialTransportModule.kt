package com.fpvarbcon.transport

import android.content.Context
import android.hardware.usb.UsbManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/**
 * Thin TurboModule bridge for USB serial transport. Only listDevices() has
 * real behavior in this pass - openDevice/closeSession/writeBytes are
 * temporary stubs that reject immediately until their approved passes land.
 */
class UsbSerialTransportModule(reactContext: ReactApplicationContext) :
  NativeUsbSerialTransportSpec(reactContext) {

  private val enumerator: UsbSerialDeviceEnumerator by lazy {
    val usbManager = reactApplicationContext.getSystemService(Context.USB_SERVICE) as UsbManager
    UsbSerialDeviceEnumerator(usbManager)
  }

  override fun listDevices(promise: Promise) {
    try {
      val result: WritableArray = Arguments.createArray()
      enumerator.enumerate().forEach { descriptor -> result.pushMap(descriptor.toWritableMap()) }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject(
        "DEVICE_ENUMERATION_FAILED",
        error.message ?: "Failed to enumerate attached USB devices.",
      )
    }
  }

  override fun openDevice(
    deviceId: Double,
    portIndex: Double,
    configuration: ReadableMap,
    promise: Promise,
  ) {
    promise.reject("NOT_IMPLEMENTED", "openDevice is not implemented yet.")
  }

  override fun closeSession(sessionId: String, promise: Promise) {
    promise.reject("NOT_IMPLEMENTED", "closeSession is not implemented yet.")
  }

  override fun writeBytes(sessionId: String, dataBase64: String, promise: Promise) {
    promise.reject("NOT_IMPLEMENTED", "writeBytes is not implemented yet.")
  }
}

private fun UsbSerialDeviceDescriptor.toWritableMap(): WritableMap {
  val map = Arguments.createMap()
  map.putInt("deviceId", deviceId)
  map.putInt("vendorId", vendorId)
  map.putInt("productId", productId)
  productName?.let { map.putString("productName", it) }
  manufacturerName?.let { map.putString("manufacturerName", it) }
  map.putString("driverType", driverType)
  map.putInt("portCount", portCount)
  return map
}

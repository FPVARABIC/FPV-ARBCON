package com.fpvarbcon.transport

/**
 * CLOSING THE USB CONNECTION, AND NOTHING ELSE.
 *
 * UsbSerialSession holds a connection for exactly one purpose: to close it
 * after the port, in the finally of close(). It never reads from it, never
 * writes to it and never asks it anything - the port does all of that, and
 * the port was handed the real connection when it was opened.
 *
 * It holds this instead of the platform class because of what run
 * 34785383699 measured, and for no other reason. The SDK's
 * android.hardware.usb.UsbDeviceConnection has a package-private
 * constructor whose bytecode is:
 *
 *   android.hardware.usb.UsbDeviceConnection();
 *     Code: 0: aload_0  1: invokespecial Object."<init>"
 *           4: new java/lang/RuntimeException  8: ldc // String Stub!
 *          13: athrow
 *
 * and close() throws the same marker. Sixteen references to "Stub!" in one
 * class. A JVM unit test cannot construct one and could not use one if it
 * did, which is why UsbSerialSession.kt sat at 0 of 33 covered lines while
 * being the class that decides the lock ordering between reading, writing
 * and closing a port.
 *
 * NO BEHAVIOUR MOVED HERE. This declares one method and implements none.
 * Every decision - the fair lock, the drain before the lock, the try whose
 * finally closes the connection, the order of the two closes - stayed in
 * UsbSerialSession, where it is now driven by UsbSerialSessionTest through
 * the real class. The production call site is a lambda one expression long:
 * `UsbConnectionHandle { connection.close() }`.
 *
 * UsbDeviceConnectionStubTest asserts the measurement this rests on, on
 * every run. When it starts failing, this interface should be deleted and
 * the real connection taken back.
 */
internal fun interface UsbConnectionHandle {
  /**
   * Closes the underlying USB connection. Whatever it throws belongs to
   * the caller: UsbSerialSession.close() deliberately does not swallow it.
   */
  fun close()
}

package android.hardware.usb

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT A JVM UNIT TEST CAN ACTUALLY DO WITH UsbDeviceConnection, RUN
 * RATHER THAN REASONED ABOUT.
 *
 * =====================================================================
 * WHY THIS FILE IS IN THE android.hardware.usb PACKAGE
 * =====================================================================
 *
 * Because that is the only place it CAN be. scripts/ci/probe-usb-connection-
 * seam.sh put the question to javac in run 34785383699 and got:
 *
 *   P2  REJECTED  UsbDeviceConnection() is not public in UsbDeviceConnection;
 *                 cannot be accessed from outside package
 *   P3  COMPILED  the same subclass declared INSIDE android.hardware.usb
 *
 * so a test that wants to construct one has to live in the platform's own
 * package. This file is that test, and it is a test rather than a script
 * because the question is about a RUNTIME, and the only runtime that
 * matters is the one Gradle's unit-test task actually starts.
 *
 * =====================================================================
 * WHAT THE STATIC EVIDENCE PREDICTED
 * =====================================================================
 *
 * The same run disassembled the class out of the only jar on that disk
 * carrying it, /usr/local/lib/android/sdk/platforms/android-37.2/android.jar:
 *
 *   android.hardware.usb.UsbDeviceConnection();
 *     Code: 0: aload_0   1: invokespecial Object."<init>"
 *           4: new java/lang/RuntimeException   8: ldc // String Stub!
 *          13: athrow
 *   public void close();
 *     Code: 0: new java/lang/RuntimeException   4: ldc // String Stub!
 *           9: athrow
 *   references to the string "Stub!" in this class's bytecode: 16
 *
 * A PREDICTION IS NOT A MEASUREMENT. javap read a jar; it did not read the
 * classpath the unit-test JVM is given, and those can differ - AGP has
 * historically generated a "mockable" android jar for unit tests with the
 * bodies rewritten. So this asserts what the bytecode says must happen and
 * prints, on every run, the ClassLoader and the code source the class was
 * ACTUALLY loaded from. If the answer ever changes - a different jar, or
 * returnDefaultValues switched on - these assertions fail and the failure
 * carries the jar that caused it, instead of a seam quietly outliving its
 * reason.
 *
 * THAT IS THIS FILE'S JOB. UsbSerialSession holds a UsbConnectionHandle
 * rather than a UsbDeviceConnection because of what is measured here. When
 * this test starts failing, that seam should be deleted, and the failure
 * message says so.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
class UsbDeviceConnectionStubTest {

  /**
   * Every line this file publishes carries this marker, because the JVM
   * test task's standard output is buried in an XML report that no log
   * tail reaches. The workflow greps for it.
   */
  private fun report(line: String) = println("usb-connection probe: $line")

  @Test
  fun `the unit test runtime loads UsbDeviceConnection from a jar whose bodies throw`() {
    val type = UsbDeviceConnection::class.java

    // WHERE THE CLASS CAME FROM. Printed whether or not anything fails,
    // because "the assertions passed" is worth nothing if nobody can say
    // which jar they passed against.
    val loader = type.classLoader
    val codeSource = type.protectionDomain?.codeSource?.location
    report("class            = ${type.name}")
    report("classLoader      = $loader")
    report("codeSource       = ${codeSource ?: "<none - loaded by a loader with no code source>"}")
    var parent = loader?.parent
    var depth = 0
    while (parent != null && depth < 8) {
      report("classLoader[$depth] parent = $parent")
      parent = parent.parent
      depth++
    }
    report("declared constructors = ${type.declaredConstructors.size}")
    for (constructor in type.declaredConstructors) {
      report("  $constructor")
    }

    // ONE: the subclass route, which is the one javac accepted.
    val fromSubclass = runCatching { object : UsbDeviceConnection() {} }.exceptionOrNull()
    report("constructing a subclass threw: ${describe(fromSubclass)}")

    // TWO: reflection, which does not need a subclass at all and which is
    // the route anyone reaching for a "clever" workaround would try next.
    val fromReflection = runCatching {
      type.getDeclaredConstructor().also { it.isAccessible = true }.newInstance()
    }.exceptionOrNull()
    report("constructing by reflection threw: ${describe(fromReflection)}")

    // Both must fail, or the seam in UsbSerialSession is unnecessary.
    assertNotNull(
      "A JVM unit test constructed a real UsbDeviceConnection through a subclass. That is the " +
        "opposite of what run 34785383699 measured in the bytecode, so the class now comes " +
        "from somewhere else: loader=$loader codeSource=$codeSource. UsbSerialSession's " +
        "UsbConnectionHandle seam exists only because this was impossible - if it is now " +
        "possible, delete the seam and take the real connection back.",
      fromSubclass,
    )
    assertNotNull(
      "A JVM unit test constructed a real UsbDeviceConnection by reflection. See the message " +
        "above: loader=$loader codeSource=$codeSource.",
      fromReflection,
    )

    // AND THE REFLECTIVE ONE MUST FAIL FOR THE STATED REASON. A
    // NoSuchMethodError or a SecurityException would mean something else
    // entirely and must not be read as confirmation.
    //
    // The REASON is pinned on the reflective route and not on the subclass
    // route, on purpose. Package-private access is enforced per RUNTIME
    // package - the pair (classloader, package name) - so if Gradle ever
    // hands the test classes and android.jar to different loaders, the
    // subclass route fails with IllegalAccessError before it ever reaches
    // the constructor's body. That is the same conclusion by a different
    // road, and pinning a message to it would make this case fail over a
    // classloader layout rather than over the platform. setAccessible(true)
    // bypasses the access check entirely, so the reflective route always
    // reaches the body and always reports what the body does.
    assertEquals(
      "the reflective constructor failed with something other than the SDK stub marker: " +
        describe(fromReflection),
      "Stub!",
      rootCause(fromReflection).message,
    )
    assertTrue(
      "the stub marker arrived as ${rootCause(fromReflection).javaClass.name}, not a " +
        "RuntimeException, so this is not the SDK stub behaviour it is taken for",
      rootCause(fromReflection) is RuntimeException,
    )
  }

  /**
   * AND close() CANNOT BE REACHED EITHER, which matters on its own: the one
   * thing UsbSerialSession does with a connection is close it, so even a
   * connection obtained some other way would be useless for testing that.
   */
  @Test
  fun `close cannot be exercised on this runtime either`() {
    val method = UsbDeviceConnection::class.java.getDeclaredMethod("close")
    report("close() declared as: $method")

    // There is no instance to call it on - that is the point of the case
    // above - so the question is put to the route that cannot be deflected
    // by an access check: reflection, which reaches the constructor's body
    // whatever classloader arrangement the test runtime happens to use.
    val constructed = runCatching {
      UsbDeviceConnection::class.java.getDeclaredConstructor()
        .also { it.isAccessible = true }
        .newInstance()
    }.exceptionOrNull()
    report("so close() is unreachable because construction threw: ${describe(constructed)}")
    assertNotNull(
      "a UsbDeviceConnection was constructed, so close() IS reachable and this case's reasoning " +
        "no longer holds",
      constructed,
    )
    assertEquals(
      "construction failed for a reason other than the SDK stub marker: ${describe(constructed)}",
      "Stub!",
      rootCause(constructed).message,
    )
  }

  private fun describe(thrown: Throwable?): String =
    if (thrown == null) {
      "<nothing - it succeeded>"
    } else {
      generateSequence(thrown) { it.cause }
        .joinToString(" <- ") { "${it.javaClass.name}(${it.message})" }
    }

  private fun rootCause(thrown: Throwable?): Throwable {
    requireNotNull(thrown) { "there is no exception to inspect" }
    return generateSequence(thrown) { it.cause }.last()
  }
}

package com.fpvarbcon

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.security.NetworkSecurityPolicy
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * THE MERGED MANIFEST AND THE RELEASE DEX, READ OFF AN INSTALLED APK.
 *
 * Everything here was previously argued from source. Source is not the
 * merged manifest: AGP merges the application's manifest with every
 * library's, and placeholders like `usesCleartextTraffic` are resolved per
 * build type by the React Native Gradle plugin, not by anything visible in
 * android/app/src/main/AndroidManifest.xml. The only honest way to check
 * what shipped is to ask the package manager on a device about the
 * installed package.
 *
 * androidTest runs against the RELEASE variant (see `testBuildType` in
 * android/app/build.gradle), so these assertions describe the artifact the
 * operator installs, not a debug convenience build.
 */
@RunWith(AndroidJUnit4::class)
class ReleasePackageContractTest {

  private val target = InstrumentationRegistry.getInstrumentation().targetContext
  private val packageManager: PackageManager = target.packageManager

  @Suppress("DEPRECATION")
  private fun components(flag: Int) =
    packageManager.getPackageInfo(target.packageName, flag)

  @Test
  fun backupIsDisabled() {
    val flags = target.applicationInfo.flags
    assertEquals(
      "FLAG_ALLOW_BACKUP is set: the manifest declares allowBackup=false, " +
        "so a merged library manifest has re-enabled it",
      0,
      flags and ApplicationInfo.FLAG_ALLOW_BACKUP,
    )
  }

  /**
   * The release build type sets the `usesCleartextTraffic` placeholder to
   * "false" (AgpConfiguratorUtils.kt). This is the runtime consequence.
   */
  @Test
  fun releaseForbidsCleartextTraffic() {
    assertFalse(
      "the release package permits cleartext HTTP",
      NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted,
    )
  }

  @Test
  fun rtlIsSupported() {
    assertTrue(
      "FLAG_SUPPORTS_RTL is absent, so the Arabic UI would lay out left-to-right",
      (target.applicationInfo.flags and ApplicationInfo.FLAG_SUPPORTS_RTL) != 0,
    )
  }

  /**
   * The attack surface of this app is meant to be exactly one launcher
   * Activity. Anything else exported - an Activity, Service, Receiver or
   * Provider merged in from a dependency - is reachable by any other app
   * on the device and has to be justified deliberately, not discovered.
   */
  @Test
  fun onlyTheLauncherActivityIsExported() {
    val info = components(
      PackageManager.GET_ACTIVITIES or
        PackageManager.GET_SERVICES or
        PackageManager.GET_RECEIVERS or
        PackageManager.GET_PROVIDERS,
    )
    val exported = mutableListOf<String>()
    info.activities?.forEach { if (it.exported) exported += "activity ${it.name}" }
    info.services?.forEach { if (it.exported) exported += "service ${it.name}" }
    info.receivers?.forEach { if (it.exported) exported += "receiver ${it.name}" }
    info.providers?.forEach { if (it.exported) exported += "provider ${it.name}" }

    assertEquals(
      "unexpected exported components in the merged manifest: $exported",
      listOf("activity com.fpvarbcon.MainActivity"),
      exported,
    )
  }

  /**
   * The permission set is small on purpose. A new permission arriving
   * through a merged library manifest is a product decision, so it must
   * fail here rather than ship silently.
   */
  @Test
  fun declaresOnlyTheExpectedPermissions() {
    @Suppress("DEPRECATION")
    val declared = packageManager
      .getPackageInfo(target.packageName, PackageManager.GET_PERMISSIONS)
      .requestedPermissions
      ?.toSortedSet()
      ?: sortedSetOf()

    assertEquals(
      "the merged manifest requests permissions this app did not declare",
      sortedSetOf("android.permission.INTERNET"),
      declared,
    )
  }

  /**
   * The release DEX check in CI greps the APK for `Lcom/fpvarbcon/debug/`.
   * This is the same claim proved from inside the running process: the
   * app's own class loader must not be able to resolve the debug-only
   * diagnostic package.
   */
  @Test
  fun releaseCarriesNoDebugOnlyClasses() {
    val loader = target.classLoader
    for (name in listOf(
      "com.fpvarbcon.debug.UsbAppLogCapturePackage",
      "com.fpvarbcon.debug.UsbAppLogCaptureModule",
      "com.fpvarbcon.debug.UsbBoundedProcessReader",
    )) {
      var resolved = true
      try {
        loader.loadClass(name)
      } catch (_: ClassNotFoundException) {
        resolved = false
      }
      assertFalse("$name is present in the release package", resolved)
    }
  }
}

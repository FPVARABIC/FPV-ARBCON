package com.fpvarbcon

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.os.Build
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
    // The permission guard is captured alongside the name. An exported
    // component behind a permission an ordinary app cannot hold is a very
    // different thing from an open one, and a failure here has to say
    // which of the two it found rather than leaving that to be looked up
    // afterwards. androidx.profileinstaller and androidx.startup are both
    // on the runtime classpath, so components from a merged library
    // manifest are a live possibility, not a hypothetical.
    info.activities?.forEach { if (it.exported) exported += "activity ${it.name} guard=${it.permission}" }
    info.services?.forEach { if (it.exported) exported += "service ${it.name} guard=${it.permission}" }
    info.receivers?.forEach { if (it.exported) exported += "receiver ${it.name} guard=${it.permission}" }
    // ProviderInfo has no single `permission` field - a provider is guarded
    // by readPermission and writePermission separately, which is also the
    // more useful thing to see, since a provider can be readable by anyone
    // and writable by nobody.
    info.providers?.forEach {
      if (it.exported) {
        exported += "provider ${it.name} read=${it.readPermission} write=${it.writePermission}"
      }
    }

    // THE EXPECTED SET, AND WHY EACH ENTRY IS IN IT.
    //
    // This list was written from source before the instrumentation lane
    // had ever executed, and the first real run corrected it: run
    // 34366909557 reported
    //
    //   unexpected exported components in the merged manifest:
    //   [activity com.fpvarbcon.MainActivity guard=null,
    //    receiver androidx.profileinstaller.ProfileInstallReceiver
    //             guard=android.permission.DUMP]
    //
    // The receiver comes from androidx.profileinstaller, which is on the
    // runtime classpath, and the GUARD IS THE POINT. It is exported so
    // that `adb shell cmd package compile` and the Play Store's profile
    // tooling can reach it, and it is behind android.permission.DUMP,
    // which Android's own permission reference describes as "Not for use
    // by third-party applications." An ordinary app on the device cannot
    // hold it, so this is not open attack surface.
    //
    // The guard string is part of the expectation on purpose. If a future
    // androidx.profileinstaller ships that receiver without its
    // permission, the entry becomes "guard=null", stops matching, and
    // this test fails - which is the case worth catching. Anything else
    // that becomes exported fails here too.
    assertEquals(
      "unexpected exported components in the merged manifest: $exported",
      listOf(
        "activity com.fpvarbcon.MainActivity guard=null",
        "receiver androidx.profileinstaller.ProfileInstallReceiver guard=android.permission.DUMP",
      ),
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

    // As with the exported components, the first real instrumentation run
    // corrected a list that had only ever been read off source:
    //
    //   expected:<[android.permission.INTERNET]> but was:
    //   <[android.permission.INTERNET,
    //     com.fpvarbcon.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION]>
    //
    // The second one is declared by androidx.core's manifest, namespaced
    // to THIS application id, and it exists so that
    // ContextCompat.registerReceiver(..., RECEIVER_NOT_EXPORTED) can keep
    // a dynamically registered receiver private on API levels below 33 -
    // which is exactly what UsbHotplugMonitor asks for. Removing it would
    // mean giving up that guarantee on older devices.
    //
    // It is allowed here only as a name; whether it is SAFE is asserted
    // separately below, against the device rather than against a
    // description of it.
    assertEquals(
      "the merged manifest requests permissions this app did not declare",
      sortedSetOf(
        "android.permission.INTERNET",
        "${target.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
      ),
      declared,
    )
  }

  /**
   * The permission androidx.core injects is only harmless because of its
   * protection level: signature means no app can hold it unless it is
   * signed with this app's own key. A normal or dangerous permission of
   * the same name would be a different thing entirely - any app could
   * request it and then reach the receivers it guards.
   *
   * So the allowance above is not taken on trust. This asks the package
   * manager on the device what the protection level actually is, and
   * fails if it is anything but signature.
   */
  @Test
  fun theInjectedReceiverPermissionIsSignatureLevel() {
    val name = "${target.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
    val info = try {
      @Suppress("DEPRECATION")
      packageManager.getPermissionInfo(name, 0)
    } catch (error: PackageManager.NameNotFoundException) {
      throw AssertionError(
        "$name is requested by the merged manifest but not declared by any installed package, " +
          "so nothing on the device defines what holding it means",
        error,
      )
    }
    // protectionLevel packs the base level together with flags, and the
    // two ways of separating them are split by API level.
    // PROTECTION_MASK_BASE is "deprecated in API level 28. Use
    // #getProtection() instead"; minSdkVersion here is 24, so both paths
    // are real and the matrix runs 24 and 30 as well as 34 and 36.
    val base = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.protection
    } else {
      @Suppress("DEPRECATION")
      info.protectionLevel and PermissionInfo.PROTECTION_MASK_BASE
    }
    assertEquals(
      "$name has protection level ${info.protectionLevel} (base $base). Only " +
        "PROTECTION_SIGNATURE (${PermissionInfo.PROTECTION_SIGNATURE}) keeps it out of reach of " +
        "every app not signed with this app's key; at any lower level another app could hold it " +
        "and reach the receivers it guards.",
      PermissionInfo.PROTECTION_SIGNATURE,
      base,
    )
    assertEquals(
      "$name is declared by ${info.packageName}, not by this application",
      target.packageName,
      info.packageName,
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

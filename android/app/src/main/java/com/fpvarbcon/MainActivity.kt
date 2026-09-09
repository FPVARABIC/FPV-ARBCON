package com.fpvarbcon

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "FPVArbcon"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * NOTHING IS DISCARDED HERE, WHICH IS THE POINT.
   *
   * An earlier comment on this method said it "discards Activity state
   * persisted during Activity restarts". It does not, and it must not:
   * savedInstanceState is passed straight through to super.onCreate. The
   * old React Native template achieved the same end with
   * `super.onCreate(null)`, throwing away every restored piece of state
   * to avoid one problem with fragments; react-native-screens 4.26.2
   * replaced that blunt instrument with this factory, and its README
   * gives exactly the line below.
   *
   * What the factory does, from the library's own source: for any
   * restored fragment whose class belongs to the react-native-screens
   * package it substitutes an AutoRemovingFragment, which removes itself
   * from the parent fragment manager as soon as it reaches ON_CREATED
   * ("can prevent duplicated fragment instances, as React will render new
   * ones on activity restart"). Every other fragment is instantiated
   * normally.
   *
   * So the restoration that survives a configuration change or a
   * process death is intact, and only the screen fragments React is about
   * to re-render are dropped. Assignment before super.onCreate is
   * required: super is what restores the fragments, so a factory set
   * afterwards would be installed too late to affect any of them.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()
    super.onCreate(savedInstanceState)
  }
}

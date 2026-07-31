import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './locales/ar.json';

/**
 * ONE ARABIC CATALOGUE, ONE APP.
 *
 * THE DEFECT THIS CLOSES, recorded so it is never re-introduced. The
 * motor-test subtree used to live in a separate `ar.motorTest.json`,
 * merged only behind a `__DEV__`-guarded require (`motorTestStrings.ts`).
 *
 * R3 gave the ENGINE seam and the SCREEN seam a build-variant fallback
 * (`motorTestEngineVariant.hardwareTest.ts` -> `hardwareTestBenchScreen`,
 * `variantMotorTestBindingFactory`) so the internal Hardware Test variant
 * - which is `initWith release`, and therefore has `__DEV__ === false` -
 * would still carry them. It did NOT give the same fallback to the i18n
 * seam. So the Hardware Test APK shipped the motor screen and the motor
 * engine with the Arabic strings compiled out, and i18next did what it
 * does on a missing key: returned the key. Every label on the device
 * rendered as `motorsScreen.title`, `motorsScreen.blockReason.*` and so
 * on. The strings were never missing from translation - they were missing
 * from the build.
 *
 * The catalogue is now a single file, statically imported, with no build
 * conditional of any kind. `i18nCoverage.test.ts` fails the build if any
 * key referenced in source is absent from it, so silent key fallback
 * cannot reach an APK again.
 */
i18n.use(initReactI18next).init({
  resources: {
    ar: { translation: ar },
  },
  lng: 'ar',
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
});

export default i18n;

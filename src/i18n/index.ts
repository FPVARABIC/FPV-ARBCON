import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './locales/ar.json';
import { motorTestStrings } from './motorTestStrings';

i18n.use(initReactI18next).init({
  resources: {
    // Phase 2I: the motor-test subtree is merged only when it resolved -
    // i.e. in development. In a production bundle `motorTestStrings` is
    // `undefined` and the whole subtree, including its emergency copy, is
    // absent from the shipped bytes. See motorTestStrings.ts.
    ar: { translation: { ...ar, ...(motorTestStrings ?? {}) } },
  },
  lng: 'ar',
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
});

export default i18n;

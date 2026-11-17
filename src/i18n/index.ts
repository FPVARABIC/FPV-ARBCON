import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';

import nl from './locales/nl.json';

// The Dutch edition always ships its complete catalogue, including all
// motor controls, safety notices and recovery messages. No build-time gate.
i18n.use(initReactI18next).init({
  resources: {nl: {translation: nl}},
  lng: 'nl',
  fallbackLng: 'nl',
  supportedLngs: ['nl'],
  interpolation: {escapeValue: false},
});

export default i18n;

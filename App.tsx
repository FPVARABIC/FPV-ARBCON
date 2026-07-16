/**
 * FPV-ARBCON
 *
 * @format
 */

import React from 'react';
import { I18nManager, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import './src/i18n';
import { UsbConnectionScreen } from './src/ui';

if (!I18nManager.isRTL) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(true);
}

function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <UsbConnectionScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;

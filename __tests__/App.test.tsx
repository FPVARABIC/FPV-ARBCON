/**
 * @format
 */

jest.mock('../src/platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import { I18nManager, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import i18n from '../src/i18n';

test('renders the USB connection screen and forces RTL', async () => {
  const allowRTLSpy = jest.spyOn(I18nManager, 'allowRTL');
  const forceRTLSpy = jest.spyOn(I18nManager, 'forceRTL');

  const App = require('../App').default;

  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  const texts = renderer!.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));

  expect(texts).toContain(i18n.t('app.name'));
  expect(texts).toContain(i18n.t('connection.instructionPrimary'));
  expect(allowRTLSpy).toHaveBeenCalledWith(true);
  expect(forceRTLSpy).toHaveBeenCalledWith(true);
});

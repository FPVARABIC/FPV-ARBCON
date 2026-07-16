/**
 * @format
 */

import React from 'react';
import { I18nManager, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

test('renders the under-construction placeholder and forces RTL', async () => {
  const allowRTLSpy = jest.spyOn(I18nManager, 'allowRTL');
  const forceRTLSpy = jest.spyOn(I18nManager, 'forceRTL');

  const App = require('../App').default;

  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  const text = renderer!.root.findByType(Text);
  expect(text.props.children).toBe('قيد الإنشاء');
  expect(allowRTLSpy).toHaveBeenCalledWith(true);
  expect(forceRTLSpy).toHaveBeenCalledWith(true);
});

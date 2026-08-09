/**
 * @jest-environment jsdom
 *
 * THE BROWSER ALERT IS A SAFETY SURFACE, NOT A CONVENIENCE.
 *
 * react-native-web's Alert.alert is `alert() {}` - a genuine no-op. Every
 * assertion here is about a decision that silently disappears without
 * this module: the unsaved-changes prompt, the pre-EEPROM-write save
 * confirmation, and (the one that matters) MainTabsScreen's warning that
 * the motor-stop path did not complete.
 *
 * These tests drive the module the way the shared screens do - through
 * `Alert.alert` itself, never through the internal queue - because that
 * is the only call the screens make and therefore the only contract worth
 * protecting.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Alert} from 'react-native';

import {
  WebAlertHost,
  installWebAlert,
  resetWebAlertQueueForTests,
} from './webAlert';

/** React 19 requires the initial mount to be inside act() as well. */
function render(): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<WebAlertHost />);
  });
  return tree;
}

/**
 * `deep: false` matters. Pressable forwards its testID to the host View it
 * renders, so a naive findAll returns the Pressable AND its inner View for
 * a single button - which reads as "two buttons" and would make a
 * one-button dialog look like two.
 */
function findByTestId(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(node => node.props?.testID === testID, {deep: false});
}

function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string): void {
  const [target] = findByTestId(tree, testID);
  act(() => {
    target.props.onPress();
  });
}

function unmount(tree: ReactTestRenderer.ReactTestRenderer): void {
  act(() => {
    tree.unmount();
  });
}

beforeAll(() => {
  installWebAlert();
});

afterEach(() => {
  act(() => {
    resetWebAlertQueueForTests();
  });
});

describe('installWebAlert', () => {
  it('replaces react-native-web\'s no-op so an alert actually appears', () => {
    const tree = render();
    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(0);

    act(() => {
      Alert.alert('عنوان', 'رسالة');
    });

    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(1);
    expect(findByTestId(tree, 'web-alert-title')[0].props.children).toBe('عنوان');
    expect(findByTestId(tree, 'web-alert-message')[0].props.children).toBe('رسالة');
    unmount(tree);
  });

  it('is idempotent - installing twice does not stack wrappers', () => {
    installWebAlert();
    installWebAlert();
    const tree = render();

    act(() => {
      Alert.alert('مرة واحدة');
    });

    // A stacked wrapper would enqueue the same dialog more than once and
    // leave a second copy behind after the first is dismissed.
    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(1);
    press(tree, 'web-alert-button-0');
    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(0);
    unmount(tree);
  });

  it('supplies a default acknowledgement button when a caller passes none', () => {
    const tree = render();

    act(() => {
      Alert.alert('بدون أزرار');
    });

    expect(findByTestId(tree, 'web-alert-button-0')).toHaveLength(1);
    expect(findByTestId(tree, 'web-alert-button-1')).toHaveLength(0);
    unmount(tree);
  });
});

describe('WebAlertHost button handling', () => {
  it('invokes the pressed button\'s handler and only that one', () => {
    const cancel = jest.fn();
    const proceed = jest.fn();
    const tree = render();

    act(() => {
      Alert.alert('تغييرات غير محفوظة', 'لديك تغييرات لم تُحفظ.', [
        {text: 'العودة للحفظ', style: 'cancel', onPress: cancel},
        {text: 'الانتقال دون حفظ', onPress: proceed},
      ]);
    });
    press(tree, 'web-alert-button-1');

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(0);
    unmount(tree);
  });

  it('tolerates a button with no handler', () => {
    const tree = render();

    act(() => {
      Alert.alert('تعذر الانتقال بأمان', 'لم يكتمل مسار إيقاف المحركات.', [
        {text: 'حسناً'},
      ]);
    });

    expect(() => press(tree, 'web-alert-button-0')).not.toThrow();
    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(0);
    unmount(tree);
  });

  it('shows a handler-raised follow-up dialog instead of eating it', () => {
    // PortsScreen and ConfigurationsScreen both chain confirm -> result.
    // If dismissal ran after the handler, this second dialog would be
    // removed the instant it was raised and the operator would never see
    // the outcome of a write they just authorized.
    const tree = render();

    act(() => {
      Alert.alert('تأكيد الحفظ', undefined, [
        {
          text: 'حفظ',
          onPress: () => {
            Alert.alert('تم الحفظ');
          },
        },
      ]);
    });
    press(tree, 'web-alert-button-0');

    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(1);
    expect(findByTestId(tree, 'web-alert-title')[0].props.children).toBe('تم الحفظ');
    unmount(tree);
  });

  it('queues concurrent alerts and shows them one at a time, in order', () => {
    const tree = render();

    act(() => {
      Alert.alert('الأول');
      Alert.alert('الثاني');
    });

    expect(findByTestId(tree, 'web-alert-title')[0].props.children).toBe('الأول');
    press(tree, 'web-alert-button-0');
    expect(findByTestId(tree, 'web-alert-title')[0].props.children).toBe('الثاني');
    unmount(tree);
  });
});

describe('WebAlertHost dismissal semantics', () => {
  it('Escape closes the dialog WITHOUT choosing a button for the operator', () => {
    // React Native's Android dialog is cancelable by default and hardware
    // Back closes it without invoking any handler. Escape matches that.
    // Auto-selecting "confirm" here would authorize an EEPROM write the
    // operator never approved.
    const cancel = jest.fn();
    const proceed = jest.fn();
    const tree = render();

    act(() => {
      Alert.alert('تأكيد', 'سيتم الحفظ في الذاكرة الدائمة.', [
        {text: 'إلغاء', style: 'cancel', onPress: cancel},
        {text: 'حفظ', style: 'destructive', onPress: proceed},
      ]);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    });

    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
    unmount(tree);
  });

  it('ignores unrelated keys', () => {
    const tree = render();

    act(() => {
      Alert.alert('يبقى مفتوحًا');
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
    });

    expect(findByTestId(tree, 'web-alert-host')).toHaveLength(1);
    unmount(tree);
  });

  it('shows an alert raised before the host mounted', () => {
    // A screen that alerts during its very first render raises the
    // dialog before <WebAlertHost/>'s own subscribe effect has run.
    act(() => {
      Alert.alert('مبكر');
    });
    const tree = render();

    expect(findByTestId(tree, 'web-alert-title')[0].props.children).toBe('مبكر');
    unmount(tree);
  });
});

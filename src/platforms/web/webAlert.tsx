/**
 * A REAL Alert.alert() FOR THE BROWSER.
 *
 * THE DEFECT THIS CLOSES. react-native-web ships `Alert.alert` as a
 * literal no-op - `alert() {}`, verified by reading the installed package,
 * not assumed. Every shared screen in this app uses Alert.alert for
 * decisions that are not cosmetic:
 *
 *   - MainTabsScreen: "you have unsaved changes" and, more importantly,
 *     "the motor-stop path did not complete" when a departure listener
 *     throws;
 *   - PortsScreen / ConfigurationsScreen / GpsScreen: the save
 *     confirmation that precedes an EEPROM write;
 *   - FirmwareFlasherScreen: the erase gate.
 *
 * Left alone, all of those would silently do nothing on Web. The
 * unsaved-changes prompt would never appear (the tab would just switch),
 * and - the one that matters - a failed motor-stop would show the operator
 * no warning at all while the screen stayed put, which reads as "nothing
 * happened" rather than "the motors may still be live". Substituting
 * window.confirm() is not an option either: it is blocking, it cannot
 * express three buttons, and it cannot be styled RTL.
 *
 * So the browser build installs this implementation over the no-op at
 * startup and renders <WebAlertHost/> once at the root. The shared screens
 * are not modified and do not know this exists - they keep calling
 * Alert.alert exactly as they do on Android.
 *
 * DISMISSAL SEMANTICS, chosen to match Android rather than the web's own
 * habits: React Native's Android dialog is cancelable by default and the
 * hardware Back button closes it WITHOUT invoking any button handler. The
 * Escape key here does exactly that - it never picks a button for the
 * operator. For "unsaved changes" that means staying put; for a save
 * confirmation it means not writing. Both are the conservative outcome,
 * which is the only acceptable default for a dialog that can precede an
 * EEPROM write.
 */

import React, {useCallback, useEffect, useState} from 'react';
import {Alert, Pressable, StyleSheet, Text, View} from 'react-native';
import type {AlertButton} from 'react-native';

import {colors, radii, spacing, typography} from '../../ui/theme';

type AlertRequest = {
  readonly id: number;
  readonly title: string;
  readonly message?: string;
  readonly buttons: readonly AlertButton[];
};

/** The default button when a caller passes none - RN does the same. */
const DEFAULT_BUTTONS: readonly AlertButton[] = [{text: 'حسناً'}];

let nextRequestId = 1;
let queue: readonly AlertRequest[] = [];
const listeners = new Set<(current: AlertRequest | null) => void>();

function publish(): void {
  const current = queue[0] ?? null;
  for (const listener of [...listeners]) {
    listener(current);
  }
}

function enqueue(
  title: string,
  message?: string,
  buttons?: readonly AlertButton[],
): void {
  const request: AlertRequest = {
    id: nextRequestId,
    title,
    message,
    buttons: buttons && buttons.length > 0 ? buttons : DEFAULT_BUTTONS,
  };
  nextRequestId += 1;
  queue = [...queue, request];
  publish();
}

function dismiss(id: number): void {
  queue = queue.filter(request => request.id !== id);
  publish();
}

/**
 * Replaces react-native-web's no-op Alert.alert with the queue above.
 * Idempotent: calling it twice does not stack two wrappers, because the
 * installed function is tagged and recognized on a second call.
 */
type TaggedAlert = typeof Alert.alert & {__fpvArbconWebAlert?: true};

export function installWebAlert(): void {
  const current = Alert.alert as TaggedAlert;
  if (current.__fpvArbconWebAlert === true) {
    return;
  }
  const replacement = ((
    title: string,
    message?: string,
    buttons?: readonly AlertButton[],
  ) => {
    enqueue(title, message, buttons);
  }) as TaggedAlert;
  replacement.__fpvArbconWebAlert = true;
  // The cast is confined to this one assignment: react-native-web types
  // Alert.alert as a plain method, and replacing it is precisely the
  // point of this module.
  (Alert as unknown as {alert: TaggedAlert}).alert = replacement;
}

/** Test seam only - drops any queued dialogs. Never called by the app. */
export function resetWebAlertQueueForTests(): void {
  queue = [];
  publish();
}

/**
 * Renders the front dialog of the queue, if any. Mounted exactly once, at
 * the application root, ABOVE the navigator so a dialog survives a
 * navigation state change that happens underneath it.
 */
export function WebAlertHost(): React.JSX.Element | null {
  const [current, setCurrent] = useState<AlertRequest | null>(queue[0] ?? null);

  useEffect(() => {
    listeners.add(setCurrent);
    // Re-read on mount: an alert raised between module load and this
    // effect (a screen that alerts during its first render) would
    // otherwise stay invisible until some later, unrelated publish().
    setCurrent(queue[0] ?? null);
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);

  const activeId = current?.id;

  useEffect(() => {
    if (activeId === undefined || typeof window === 'undefined') {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Android hardware-Back parity: close, invoke nothing.
        dismiss(activeId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeId]);

  const handlePress = useCallback((request: AlertRequest, button: AlertButton) => {
    // Dismiss FIRST. A handler that itself raises the next alert (the
    // save-then-confirm chains in PortsScreen and ConfigurationsScreen do
    // exactly this) must not have its new dialog removed by this one's
    // own cleanup running afterwards.
    dismiss(request.id);
    button.onPress?.();
  }, []);

  if (!current) {
    return null;
  }

  return (
    <View style={styles.backdrop} testID="web-alert-host">
      <View style={styles.dialog} accessibilityRole="alert">
        <Text style={styles.title} testID="web-alert-title">
          {current.title}
        </Text>
        {current.message ? (
          <Text style={styles.message} testID="web-alert-message">
            {current.message}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {current.buttons.map((button, index) => (
            <Pressable
              // The button list for one dialog is fixed for that dialog's
              // whole lifetime, so the index is a stable key here.
              key={index}
              testID={`web-alert-button-${index}`}
              onPress={() => handlePress(current, button)}
              style={({pressed}) => [
                styles.button,
                button.style === 'destructive' && styles.buttonDestructive,
                button.style === 'cancel' && styles.buttonCancel,
                pressed && styles.buttonPressed,
              ]}>
              <Text
                style={[
                  styles.buttonLabel,
                  button.style === 'destructive' && styles.buttonLabelDestructive,
                  button.style === 'cancel' && styles.buttonLabelCancel,
                ]}>
                {button.text ?? 'حسناً'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(2, 11, 15, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    // Above the navigator and every screen-level overlay.
    zIndex: 1000,
  },
  dialog: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  message: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  actions: {
    // RTL: index 0 is the RIGHTMOST action, matching the tab strip's own
    // convention in src/navigation/tabs.ts. Wraps rather than shrinking,
    // so a three-button dialog stays legible on a narrow viewport.
    flexDirection: 'row-reverse',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    minWidth: 96,
    alignItems: 'center',
  },
  buttonCancel: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  buttonDestructive: {
    borderColor: colors.error,
    backgroundColor: colors.surfaceAlt,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonLabel: {
    ...typography.sectionTitle,
    color: colors.accentStrong,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  buttonLabelCancel: {
    color: colors.textSecondary,
  },
  buttonLabelDestructive: {
    color: colors.error,
  },
});

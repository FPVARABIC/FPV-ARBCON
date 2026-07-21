import React, {useCallback, useEffect, useRef, useState} from 'react';
import {NativeModules, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';

/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.3, PASS5.3-DEBUG-LOGCAT) - a plain
 * (non-TurboModule) NativeModule registered by UsbAppLogCapturePackage.kt,
 * entirely separate from the real UsbSerialTransport TurboModule/contract.
 * Only ever captures THIS app's own process logcat output (see
 * UsbAppLogCaptureModule.kt's own class-level note for exactly why this
 * needs no android.permission.READ_LOGS, and for the Android 13+ consent-
 * dialog caveat found during that same investigation). Accessed via the
 * old-style NativeModules registry, not TurboModuleRegistry, since it is
 * not a Codegen'd TurboModule.
 */
async function captureAppLog(): Promise<string> {
  const nativeModule = NativeModules.UsbAppLogCapture as {captureAppLog?: () => Promise<string>} | undefined;
  if (!nativeModule?.captureAppLog) {
    throw new Error('UsbAppLogCapture native module is not available on this build.');
  }
  return nativeModule.captureAppLog();
}

/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.4) - extracted out of
 * UsbSerialDebugPanel.tsx (which stays gated on isConnected/activeSessionId)
 * because capturing this app's own logcat needs neither a session nor a
 * connected transport client - it calls UsbAppLogCapture directly. Before
 * this pass, the log-capture button lived only inside that gated panel,
 * making it unreachable exactly when it is most needed: the confirmed
 * openDevice() hang (see UsbSerialTransportModule's own class-level Pass 5.4
 * note) means a stuck connect attempt never reaches 'connected', so this
 * panel is now rendered unconditionally, independent of connection state.
 *
 * NOT a real app screen, NOT part of the final design - delete this file
 * (and its one render site in UsbConnectionScreen.tsx, clearly marked there)
 * once real protocol screens exist and this is no longer needed.
 */
export default function UsbAppLogCapturePanel(): React.JSX.Element {
  // null = hidden. Toggling to hidden always clears this (rather than just
  // hiding a stale capture) so the next "Capture App Log" press always
  // re-captures fresh output, per this feature's own requirement.
  const [appLog, setAppLog] = useState<string | null>(null);
  const [appLogCapturing, setAppLogCapturing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Toggles between capture/hide. Hiding always clears appLog to null (not
  // just visually collapsing a stale capture), so pressing "Capture App
  // Log" again after hiding always re-captures fresh output, never re-shows
  // an old one - Ahmed will want to repeat this across multiple attempts.
  const handleToggleAppLog = useCallback(async () => {
    if (appLog !== null) {
      setAppLog(null);
      return;
    }
    setAppLogCapturing(true);
    try {
      const captured = await captureAppLog();
      if (!mountedRef.current) {
        return;
      }
      setAppLog(captured.length > 0 ? captured : '(empty capture - no log lines were produced for this process)');
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setAppLog(`Failed to capture app log: ${message}`);
    } finally {
      if (mountedRef.current) {
        setAppLogCapturing(false);
      }
    }
  }, [appLog]);

  return (
    <View style={styles.container}>
      <Text style={styles.debugLabel}>⚠ DEBUG - APP LOG CAPTURE (temporary, Pass 5.3/5.4)</Text>
      <View style={styles.logHeaderRow}>
        <Text style={styles.sectionTitle}>App Log Capture (own process, no adb needed)</Text>
        <Pressable
          testID="debug-toggle-app-log"
          disabled={appLogCapturing}
          onPress={handleToggleAppLog}
          style={[styles.button, appLogCapturing && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>
            {appLogCapturing ? 'Capturing...' : appLog !== null ? 'Hide Log' : 'Capture App Log'}
          </Text>
        </Pressable>
      </View>

      {appLog !== null ? (
        <ScrollView style={styles.log} nestedScrollEnabled>
          <Text selectable style={styles.logText}>
            {appLog}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderWidth: 2,
    borderColor: colors.warning,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceAlt,
  },
  debugLabel: {
    ...typography.sectionTitle,
    color: colors.warning,
    marginBottom: spacing.xs,
  },
  logHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.accent,
  },
  buttonDisabled: {
    backgroundColor: colors.disabled,
  },
  buttonText: {
    ...typography.caption,
    color: colors.background,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  log: {
    maxHeight: 260,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  logText: {
    ...typography.mono,
    color: colors.textPrimary,
    writingDirection: 'ltr',
    textAlign: 'left',
  },
});

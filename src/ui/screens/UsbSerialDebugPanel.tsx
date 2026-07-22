import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';
import type {TransportError, UsbSerialTransportClient} from '../../platforms/react-native/transport';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  parseByteInput,
} from './usbSerialDebugPanelBytes';

/**
 * TEMPORARY DEBUG SCAFFOLDING (Pass 5.3) - NOT a real app screen, NOT part
 * of the final design. Exists solely so the RX/TX real-hardware manual test
 * plan can actually be executed: start/stop the receive loop, send known or
 * arbitrary byte sequences, and watch a raw log of every onDataReceived/
 * onError event and every write's resolve/reject outcome.
 *
 * Calls ONLY the existing public UsbSerialTransportClient methods
 * (startReading/stopReading/writeBytes/onDataReceived/onError) exactly as
 * they already exist - this file does not touch, wrap, or add anything to
 * the transport layer (Kotlin or TS) itself.
 *
 * PASS5.4: the standalone "Capture App Log" feature (PASS5.3-DEBUG-LOGCAT)
 * that used to live at the bottom of this same panel has moved to its own
 * UsbAppLogCapturePanel.tsx, rendered unconditionally in
 * UsbConnectionScreen.tsx - it needs neither a session nor a connected
 * client, and gating it behind isConnected made it unreachable exactly when
 * a stuck connect attempt makes it most needed. This panel keeps only the
 * RX/TX manual test controls, which do genuinely require an open session.
 *
 * Delete this file (and its one integration point in
 * UsbConnectionScreen.tsx, clearly marked there the same way) once real
 * protocol screens (Setup, PID, etc.) exist and this is no longer needed.
 *
 * PASS6.3 (Step 3): READ-ONLY MONITOR EXCLUSIVITY. Once an MspClient is
 * active for this session (mspActive prop, driven by
 * MspSessionCoordinator - see UsbConnectionScreen.tsx's own hook-point
 * comments), this panel's Start Reading/Stop Reading/Send controls are
 * DISABLED (not hidden) - MSP protocol traffic and this panel's own manual
 * RX loop control/writes must never compete for the same physical byte
 * stream. The panel still displays incoming bytes while mspActive: it
 * registers its OWN independent listener directly on the SAME
 * RNMspTransport instance MspClient itself uses (Step 1's multi-listener
 * support), never a second, separate subscription to the raw underlying
 * client - see the mspActive-branched effects below.
 *
 * PASS6.3 (Step 3 final correction): the disabled={mspActive} styling on
 * the buttons is a UX layer only, NOT the safety mechanism. The real
 * guard is mspActiveRef, a ref kept in sync via useLayoutEffect (not a
 * useCallback dependency) - a caller that already holds a stale reference
 * to handleStartReading/handleStopReading/sendBytes (e.g. a previously
 * captured callback or an old event-listener closure) must still be
 * blocked at CALL TIME by reading current, live state, not by however
 * mspActive happened to read when that particular closure was created.
 */

const MAX_DEBUG_LOG_ENTRIES = 200;

const PRESET_BYTE_SEQUENCES: ReadonlyArray<{label: string; bytes: number[]}> = [
  {label: '1,2,3,4,5', bytes: [1, 2, 3, 4, 5]},
  {label: 'AA 55', bytes: [0xaa, 0x55]},
];

interface DebugLogEntry {
  id: number;
  timestamp: number;
  text: string;
}

/** No Intl/toLocaleTimeString dependency - matches ValidationLog's own reasoning. */
function formatDebugTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

interface Props {
  sessionId: string;
  client: UsbSerialTransportClient;
  /** True once MspSessionCoordinator.openSession() has been called for
   * this exact session (and until closeSession()/detach) - see
   * UsbConnectionScreen.tsx's own hook-point comments. Disables this
   * panel's write/RX-loop-control buttons and switches its own byte log
   * to read from the shared RNMspTransport instance instead of a second,
   * separate raw client subscription. */
  mspActive: boolean;
}

export default function UsbSerialDebugPanel({sessionId, client, mspActive}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [reading, setReading] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [byteInput, setByteInput] = useState('1,2,3,4,5');
  const mountedRef = useRef(true);
  const nextIdRef = useRef(1);
  // Synchronous internal guard for handleStartReading/handleStopReading/
  // sendBytes - see the class-level doc comment above. useLayoutEffect
  // (not useEffect): the ref must already be current by the time this
  // render becomes interactive, not merely eventually consistent.
  const mspActiveRef = useRef(mspActive);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    mspActiveRef.current = mspActive;
  }, [mspActive]);

  const appendLog = useCallback((text: string) => {
    if (!mountedRef.current) {
      return;
    }
    const entry: DebugLogEntry = {id: nextIdRef.current++, timestamp: Date.now(), text};
    setEntries(prev => [entry, ...prev].slice(0, MAX_DEBUG_LOG_ENTRIES));
  }, []);

  // Attach-log + native transport errors - unconditional, unaffected by
  // mspActive (a native read error is still meaningful diagnostic info
  // regardless of whether an MspClient exists for this session).
  useEffect(() => {
    appendLog('debug panel attached to this session');
    const unsubscribeError = client.onError(event => {
      if (event.sessionId !== undefined && event.sessionId !== sessionId) {
        return;
      }
      appendLog(`ERR ${event.code}: ${event.message}`);
    });
    return () => {
      unsubscribeError();
    };
  }, [client, sessionId, appendLog]);

  // RAW byte log - only while NOT mspActive (exactly this panel's original,
  // pre-Pass-6.3 behavior: its own filtered, self-decoded subscription
  // directly on the underlying client). Explicit cleanup below detaches
  // this the moment mspActive flips true, sessionId changes, or the panel
  // unmounts - mirroring UsbConnectionScreen.tsx's own hot-plug
  // subscription useEffect, this codebase's established pattern for every
  // subscription lifecycle: never rely on the far side (here,
  // RNMspTransport.dispose()) eventually clearing its own listeners as a
  // substitute for this effect managing its own subscription explicitly.
  useEffect(() => {
    if (mspActive) {
      return undefined;
    }
    const unsubscribeData = client.onDataReceived(event => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const bytes = base64ToBytes(event.dataBase64);
      appendLog(`RX  ${bytes.length}B  hex=[${bytesToHex(bytes)}]  base64Len=${event.dataBase64.length}`);
    });
    return () => {
      unsubscribeData();
    };
  }, [client, sessionId, mspActive, appendLog]);

  // MSP-active byte log - only while mspActive. Registers its OWN
  // independent listener directly on the SAME RNMspTransport instance
  // MspClient itself uses (Step 1's multi-listener support) - never a
  // second, separate subscription to the raw underlying client. One
  // synchronous getActiveTransport() lookup per mspActive/sessionId change
  // (see UsbConnectionScreen.tsx's own comment on why mspActive and
  // MspSessionCoordinator.openSession() are always in sync by the time
  // this effect runs) - not polling, not re-checked on every render.
  // Cleanup explicitly unsubscribes, same reasoning as the raw-log effect
  // above.
  useEffect(() => {
    if (!mspActive) {
      return undefined;
    }
    const transport = mspSessionCoordinator.getActiveTransport(sessionId);
    if (!transport) {
      return undefined;
    }
    const unsubscribeMspData = transport.onDataReceived(bytes => {
      appendLog(`RX (MSP)  ${bytes.length}B  hex=[${bytesToHex(bytes)}]`);
    });
    return () => {
      unsubscribeMspData();
    };
  }, [sessionId, mspActive, appendLog]);

  const handleStartReading = useCallback(async () => {
    if (mspActiveRef.current) {
      appendLog('DEBUG_CONTROL_BLOCKED_BY_MSP');
      return;
    }
    setReadBusy(true);
    appendLog('startReading() called');
    try {
      await client.startReading(sessionId);
      if (!mountedRef.current) {
        return;
      }
      setReading(true);
      appendLog('startReading() resolved');
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const transportError = error as TransportError;
      appendLog(`startReading() rejected: ${transportError.code} ${transportError.nativeMessage}`);
    } finally {
      if (mountedRef.current) {
        setReadBusy(false);
      }
    }
  }, [client, sessionId, appendLog]);

  const handleStopReading = useCallback(async () => {
    if (mspActiveRef.current) {
      appendLog('DEBUG_CONTROL_BLOCKED_BY_MSP');
      return;
    }
    setReadBusy(true);
    appendLog('stopReading() called');
    try {
      await client.stopReading(sessionId);
      if (!mountedRef.current) {
        return;
      }
      setReading(false);
      appendLog('stopReading() resolved');
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const transportError = error as TransportError;
      appendLog(`stopReading() rejected: ${transportError.code} ${transportError.nativeMessage}`);
    } finally {
      if (mountedRef.current) {
        setReadBusy(false);
      }
    }
  }, [client, sessionId, appendLog]);

  // Deliberately NOT gated on any "busy" flag - concurrent, rapid-fire
  // writes (including while RX is actively running) are exactly the
  // scenario the real-hardware test plan requires exercising, so the UI
  // must never serialize or block them.
  const sendBytes = useCallback(
    (bytes: Uint8Array, label: string) => {
      if (mspActiveRef.current) {
        appendLog('DEBUG_CONTROL_BLOCKED_BY_MSP');
        return;
      }
      const dataBase64 = bytesToBase64(bytes);
      appendLog(`TX  (${label}) ${bytes.length}B  hex=[${bytesToHex(bytes)}]`);
      client
        .writeBytes(sessionId, dataBase64)
        .then(() => {
          if (mountedRef.current) {
            appendLog(`writeBytes() resolved (${label})`);
          }
        })
        .catch((error: TransportError) => {
          if (mountedRef.current) {
            appendLog(`writeBytes() rejected (${label}): ${error.code} ${error.nativeMessage}`);
          }
        });
    },
    [client, sessionId, appendLog],
  );

  const handleSendCustom = useCallback(() => {
    const bytes = parseByteInput(byteInput);
    if (!bytes) {
      appendLog(`could not parse "${byteInput}" - use comma/space-separated 0-255 or 0xNN values`);
      return;
    }
    sendBytes(bytes, 'custom');
  }, [byteInput, sendBytes, appendLog]);

  const handleClearLog = useCallback(() => setEntries([]), []);

  const logText = entries.map(entry => `[${formatDebugTimestamp(entry.timestamp)}] ${entry.text}`).join('\n');

  return (
    <View style={styles.container}>
      <Text style={styles.debugLabel}>⚠ DEBUG - RX/TX MANUAL TEST PANEL (temporary, Pass 5.3)</Text>
      <Text style={styles.sessionText}>session: {sessionId}</Text>

      {mspActive ? (
        <Text style={styles.mspActiveNotice} accessibilityRole="text">
          التحكم بالقراءة والإرسال معطّل لأن بروتوكول MSP نشط حاليًا لهذه الجلسة - هذه اللوحة تعرض البيانات
          الواردة فقط دون التدخل فيها.
        </Text>
      ) : null}

      <View style={styles.row}>
        <Pressable
          testID="debug-start-reading"
          disabled={readBusy || reading || mspActive}
          onPress={handleStartReading}
          style={[styles.button, (readBusy || reading || mspActive) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Start Reading</Text>
        </Pressable>
        <Pressable
          testID="debug-stop-reading"
          disabled={readBusy || !reading || mspActive}
          onPress={handleStopReading}
          style={[styles.button, (readBusy || !reading || mspActive) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Stop Reading</Text>
        </Pressable>
      </View>
      <Text style={styles.statusText}>{reading ? 'Reading: ACTIVE' : 'Reading: stopped'}</Text>

      <View style={styles.row}>
        {PRESET_BYTE_SEQUENCES.map(preset => (
          <Pressable
            key={preset.label}
            testID={`debug-send-preset-${preset.label}`}
            disabled={mspActive}
            onPress={() => sendBytes(Uint8Array.from(preset.bytes), preset.label)}
            style={[styles.button, mspActive && styles.buttonDisabled]}>
            <Text style={styles.buttonText}>Send [{preset.label}]</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.sendRow}>
        <TextInput
          testID="debug-byte-input"
          style={styles.textInput}
          value={byteInput}
          onChangeText={setByteInput}
          placeholder="e.g. 1,2,3,4,5 or 0xAA,0x55"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          testID="debug-send-custom"
          disabled={mspActive}
          onPress={handleSendCustom}
          style={[styles.button, mspActive && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      </View>

      <View style={styles.logHeaderRow}>
        <Text style={styles.sectionTitle}>Debug Log</Text>
        <Pressable testID="debug-clear-log" onPress={handleClearLog} style={styles.clearButton}>
          <Text style={styles.clearButtonText}>Clear Log</Text>
        </Pressable>
      </View>

      {entries.length === 0 ? (
        <Text style={styles.emptyText}>No debug log entries yet.</Text>
      ) : (
        <ScrollView style={styles.log} nestedScrollEnabled>
          <Text selectable style={styles.logText}>
            {logText}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
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
  sessionText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'ltr',
    marginBottom: spacing.md,
  },
  mspActiveNotice: {
    ...typography.caption,
    color: colors.warning,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
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
  statusText: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'ltr',
    marginBottom: spacing.md,
  },
  textInput: {
    flex: 1,
    ...typography.mono,
    color: colors.textPrimary,
    writingDirection: 'ltr',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
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
  clearButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  clearButtonText: {
    ...typography.caption,
    color: colors.accent,
  },
  emptyText: {
    ...typography.caption,
    color: colors.textSecondary,
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

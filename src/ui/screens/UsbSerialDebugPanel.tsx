import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {colors, radii, spacing, typography} from '../theme';
import type {TransportError, UsbSerialTransportClient} from '../../platforms/react-native/transport';
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
 * the transport layer (Kotlin or TS) itself, and adds no new native module
 * method or contract.
 *
 * Delete this file (and its one integration point in
 * UsbConnectionScreen.tsx, clearly marked there the same way) once real
 * protocol screens (Setup, PID, etc.) exist and this is no longer needed.
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
}

export default function UsbSerialDebugPanel({sessionId, client}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [reading, setReading] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [byteInput, setByteInput] = useState('1,2,3,4,5');
  const mountedRef = useRef(true);
  const nextIdRef = useRef(1);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const appendLog = useCallback((text: string) => {
    if (!mountedRef.current) {
      return;
    }
    const entry: DebugLogEntry = {id: nextIdRef.current++, timestamp: Date.now(), text};
    setEntries(prev => [entry, ...prev].slice(0, MAX_DEBUG_LOG_ENTRIES));
  }, []);

  // Subscribed only while this panel is mounted - i.e. only while a session
  // is connected (see its one render site in UsbConnectionScreen.tsx).
  useEffect(() => {
    const unsubscribeData = client.onDataReceived(event => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const bytes = base64ToBytes(event.dataBase64);
      appendLog(`RX  ${bytes.length}B  hex=[${bytesToHex(bytes)}]  base64Len=${event.dataBase64.length}`);
    });
    const unsubscribeError = client.onError(event => {
      if (event.sessionId !== undefined && event.sessionId !== sessionId) {
        return;
      }
      appendLog(`ERR ${event.code}: ${event.message}`);
    });
    appendLog('debug panel attached to this session');
    return () => {
      unsubscribeData();
      unsubscribeError();
    };
  }, [client, sessionId, appendLog]);

  const handleStartReading = useCallback(async () => {
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

      <View style={styles.row}>
        <Pressable
          testID="debug-start-reading"
          disabled={readBusy || reading}
          onPress={handleStartReading}
          style={[styles.button, (readBusy || reading) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Start Reading</Text>
        </Pressable>
        <Pressable
          testID="debug-stop-reading"
          disabled={readBusy || !reading}
          onPress={handleStopReading}
          style={[styles.button, (readBusy || !reading) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>Stop Reading</Text>
        </Pressable>
      </View>
      <Text style={styles.statusText}>{reading ? 'Reading: ACTIVE' : 'Reading: stopped'}</Text>

      <View style={styles.row}>
        {PRESET_BYTE_SEQUENCES.map(preset => (
          <Pressable
            key={preset.label}
            testID={`debug-send-preset-${preset.label}`}
            onPress={() => sendBytes(Uint8Array.from(preset.bytes), preset.label)}
            style={styles.button}>
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
        <Pressable testID="debug-send-custom" onPress={handleSendCustom} style={styles.button}>
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

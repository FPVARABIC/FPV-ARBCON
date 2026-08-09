import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  rawCliSessionController,
  type CliCommandResult,
  type RawCliPhase,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  colors,
  radii,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';

export type CliScreenPort = Pick<
  typeof rawCliSessionController,
  | 'getPhase'
  | 'getOutput'
  | 'getIdentification'
  | 'subscribe'
  | 'begin'
  | 'execute'
  | 'saveTextFile'
  | 'clearOutput'
  | 'saveAndClose'
  | 'exitWithoutSave'
>;

interface Props {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onCliBusyChange: (busy: boolean) => void;
  readonly cli?: CliScreenPort;
}

const QUICK_COMMANDS = Object.freeze([
  { command: 'status', label: 'الحالة' },
  { command: 'version', label: 'الإصدار' },
  { command: 'diff all', label: 'diff all' },
  { command: 'dump all', label: 'dump all' },
  { command: 'tasks', label: 'المهام' },
  { command: 'resource show all', label: 'الموارد' },
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseLabel(phase: RawCliPhase): string {
  switch (phase) {
    case 'IDLE':
      return 'غير نشط';
    case 'ENTERING':
      return 'دخول CLI…';
    case 'ACTIVE':
      return 'جاهز للأوامر';
    case 'SENDING':
      return 'انتظار prompt…';
    case 'CLOSING':
      return 'إغلاق الجلسة…';
  }
}

export default function CliScreen({
  sessionKey,
  active,
  onCliBusyChange,
  cli = rawCliSessionController,
}: Props): React.JSX.Element {
  const { maxWidth } = useContentEnvelope(true);
  const [phase, setPhase] = useState<RawCliPhase>(() => cli.getPhase());
  const [output, setOutput] = useState(() => cli.getOutput());
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [failure, setFailure] = useState<string>();
  const [hasCliError, setHasCliError] = useState(false);
  const [status, setStatus] = useState(
    'ابدأ جلسة CLI صريحة. ستتوقف التليمترية مؤقتًا حتى الخروج.',
  );

  const sync = useCallback(() => {
    setPhase(cli.getPhase());
    setOutput(cli.getOutput());
  }, [cli]);

  useEffect(() => {
    sync();
    return cli.subscribe(sync);
  }, [cli, sync]);

  useEffect(() => {
    onCliBusyChange(phase !== 'IDLE');
  }, [onCliBusyChange, phase]);

  useEffect(
    () => () => {
      if (cli.getPhase() !== 'IDLE')
        cli.exitWithoutSave().catch(() => undefined);
    },
    [cli],
  );

  const identity = useMemo(() => {
    if (!sessionKey) return 'لا توجد جلسة Flight Controller.';
    const state = cli.getIdentification(sessionKey.sessionId);
    if (state.status === 'SUCCEEDED') {
      return `${state.identity.firmware.knownFamily} · ${state.identity.firmware.identifier} · MSP ${state.identity.apiVersion.apiVersionMajor}.${state.identity.apiVersion.apiVersionMinor} · ${state.identity.board.boardIdentifier}`;
    }
    if (state.status === 'FAILED') return 'فشل تثبيت هوية المتحكم.';
    return state.status === 'RUNNING'
      ? 'جارٍ تثبيت هوية المتحكم…'
      : 'هوية المتحكم غير جاهزة.';
  }, [cli, sessionKey]);

  const isOpen = phase !== 'IDLE';
  const canSend = phase === 'ACTIVE' && command.trim().length > 0;

  const start = useCallback(async () => {
    if (!sessionKey || !active || cli.getPhase() !== 'IDLE') return;
    setFailure(undefined);
    setHasCliError(false);
    setHistory([]);
    setHistoryCursor(-1);
    setStatus('إيقاف استطلاع MSP وحجز الرابط ثم انتظار CLI prompt…');
    onCliBusyChange(true);
    try {
      await cli.begin(sessionKey);
      sync();
      setStatus('الجلسة جاهزة. لن يُرسل save إلا من زر الحفظ الصريح.');
    } catch (error) {
      setFailure(errorText(error));
      sync();
      onCliBusyChange(false);
    }
  }, [active, cli, onCliBusyChange, sessionKey, sync]);

  const runCommand = useCallback(
    async (candidate: string) => {
      if (cli.getPhase() !== 'ACTIVE') return;
      const normalized = candidate.trim();
      if (!normalized) return;
      setFailure(undefined);
      setStatus(`إرسال: ${normalized}`);
      try {
        const result: CliCommandResult = await cli.execute(normalized);
        setHistory(current =>
          [normalized, ...current.filter(item => item !== normalized)].slice(
            0,
            40,
          ),
        );
        setHistoryCursor(-1);
        setCommand('');
        if (result.error) {
          setHasCliError(true);
          setFailure(
            'أعاد CLI خطأ. حُظر save لهذه الجلسة؛ اخرج دون حفظ وراجع الأمر.',
          );
        } else {
          setStatus(`اكتمل ${normalized} وعاد prompt.`);
        }
      } catch (error) {
        setFailure(errorText(error));
      } finally {
        sync();
      }
    },
    [cli, sync],
  );

  const browseHistory = useCallback(
    (direction: -1 | 1) => {
      if (!history.length) return;
      const next = Math.max(
        -1,
        Math.min(history.length - 1, historyCursor + direction),
      );
      setHistoryCursor(next);
      setCommand(next < 0 ? '' : history[next]);
    },
    [history, historyCursor],
  );

  const downloadOutput = useCallback(async () => {
    if (!output.trim() || cli.getPhase() !== 'ACTIVE') return;
    setFailure(undefined);
    try {
      const saved = await cli.saveTextFile(
        `betaflight-cli-${Date.now()}.txt`,
        output,
      );
      if (!saved) throw new Error('لم يكتمل حفظ سجل CLI على الجهاز.');
      setStatus('حُفظ سجل CLI في ملف نصي.');
    } catch (error) {
      setFailure(errorText(error));
    }
  }, [cli, output]);

  const discard = useCallback(async () => {
    setFailure(undefined);
    try {
      await cli.exitWithoutSave();
      setStatus('خرجت من CLI دون إرسال save.');
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      sync();
      onCliBusyChange(false);
    }
  }, [cli, onCliBusyChange, sync]);

  const confirmSave = useCallback(() => {
    Alert.alert(
      'حفظ وإعادة تشغيل المتحكم',
      'سيُرسل الأمر save الآن، ثم قد ينقطع USB أثناء إعادة تشغيل Flight Controller. هل راجعت diff all؟',
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'حفظ وإعادة تشغيل',
          style: 'destructive',
          onPress: () => {
            cli
              .saveAndClose()
              .then(() => {
                setStatus(
                  'أُرسل save وأُغلقت الجلسة. أعد الاتصال إذا لم يعد USB تلقائيًا.',
                );
                setHasCliError(false);
              })
              .catch(error => setFailure(errorText(error)))
              .finally(() => {
                sync();
                onCliBusyChange(false);
              });
          },
        },
      ],
    );
  }, [cli, onCliBusyChange, sync]);

  return (
    <View style={styles.root} testID="cli-screen">
      <ScrollView contentContainerStyle={[styles.content, { maxWidth }]}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            RAW BETAFLIGHT CLI · EXCLUSIVE LINK
          </Text>
          <Text style={styles.title}>سطر الأوامر</Text>
          <Text style={styles.subtitle}>
            أداة متقدمة تتصل بـCLI الحقيقي. لا تُرسل save تلقائيًا، وتوقف
            التليمترية طوال امتلاك الرابط.
          </Text>
          <View style={styles.identityRow}>
            <Text style={styles.identity}>{identity}</Text>
            <Text style={[styles.phase, isOpen && styles.phaseOpen]}>
              {phaseLabel(phase)}
            </Text>
          </View>
        </View>

        <View style={styles.warning} accessibilityRole="alert">
          <Text style={styles.warningTitle}>قبل فتح CLI</Text>
          <Text style={styles.warningText}>
            انزع المراوح، وأنهِ جلسة المحركات، ولا تفصل USB أثناء أمر جارٍ.
            الأوامر الخاطئة قد تمنع الإقلاع؛ التقط diff all قبل أي تعديل.
          </Text>
        </View>

        {failure ? (
          <View style={styles.error} accessibilityRole="alert">
            <Text style={styles.errorText}>{failure}</Text>
          </View>
        ) : null}

        {!isOpen ? (
          <Pressable
            testID="cli-start"
            disabled={!sessionKey || !active}
            onPress={() => start().catch(() => undefined)}
            style={[styles.start, (!sessionKey || !active) && styles.disabled]}
          >
            <Text style={styles.startText}>ابدأ جلسة CLI الآمنة</Text>
          </Pressable>
        ) : (
          <>
            <View style={styles.quickCard}>
              <Text style={styles.sectionTitle}>أوامر قراءة سريعة</Text>
              <Text style={styles.hint}>
                أزرار معروفة للقراءة والتشخيص؛ لا تحفظ شيئًا.
              </Text>
              <View style={styles.quickGrid}>
                {QUICK_COMMANDS.map(item => (
                  <Pressable
                    key={item.command}
                    testID={`cli-quick-${item.command}`}
                    disabled={phase !== 'ACTIVE'}
                    onPress={() =>
                      runCommand(item.command).catch(() => undefined)
                    }
                    style={[
                      styles.quick,
                      phase !== 'ACTIVE' && styles.disabled,
                    ]}
                  >
                    <Text style={styles.quickText}>{item.label}</Text>
                    <Text style={styles.quickCode}>{item.command}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <View style={styles.terminalCard}>
              <View style={styles.terminalHeader}>
                <Text style={styles.terminalTitle}>مخرجات المتحكم الحية</Text>
                <View style={styles.terminalTools}>
                  <Pressable
                    testID="cli-download-output"
                    disabled={!output.trim() || phase !== 'ACTIVE'}
                    onPress={() => downloadOutput().catch(() => undefined)}
                  >
                    <Text style={styles.toolText}>تنزيل السجل</Text>
                  </Pressable>
                  <Pressable
                    testID="cli-clear-output"
                    disabled={phase !== 'ACTIVE'}
                    onPress={() => {
                      try {
                        cli.clearOutput();
                        sync();
                      } catch (error) {
                        setFailure(errorText(error));
                      }
                    }}
                  >
                    <Text style={styles.toolText}>مسح العرض</Text>
                  </Pressable>
                </View>
              </View>
              <ScrollView style={styles.terminal} nestedScrollEnabled>
                <Text
                  selectable
                  style={styles.terminalText}
                  testID="cli-output"
                >
                  {output || '# بانتظار المخرجات…'}
                </Text>
              </ScrollView>
              <View style={styles.commandRow}>
                <TextInput
                  testID="cli-command-input"
                  value={command}
                  onChangeText={setCommand}
                  onSubmitEditing={() =>
                    runCommand(command).catch(() => undefined)
                  }
                  editable={phase === 'ACTIVE'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="مثال: get gyro_lpf1_static_hz"
                  placeholderTextColor={colors.textMuted}
                  style={styles.commandInput}
                />
                <Pressable
                  testID="cli-send"
                  disabled={!canSend}
                  onPress={() => runCommand(command).catch(() => undefined)}
                  style={[styles.send, !canSend && styles.disabled]}
                >
                  <Text style={styles.sendText}>إرسال</Text>
                </Pressable>
              </View>
              <View style={styles.historyRow}>
                <Pressable onPress={() => browseHistory(1)}>
                  <Text style={styles.toolText}>السابق ↑</Text>
                </Pressable>
                <Pressable onPress={() => browseHistory(-1)}>
                  <Text style={styles.toolText}>الأحدث ↓</Text>
                </Pressable>
                <Text style={styles.historyCount}>
                  سجل هذه الجلسة: {history.length}
                </Text>
              </View>
            </View>

            <View style={styles.decision}>
              <View style={styles.decisionCopy}>
                <Text style={styles.sectionTitle}>إنهاء الجلسة</Text>
                <Text style={styles.hint}>
                  الخروج دون حفظ يتراجع عن التعديلات المؤقتة. save يثبتها ويعيد
                  تشغيل المتحكم.
                </Text>
              </View>
              <View style={styles.decisionActions}>
                <Pressable
                  testID="cli-discard"
                  disabled={phase !== 'ACTIVE'}
                  onPress={() => discard().catch(() => undefined)}
                  style={styles.discard}
                >
                  <Text style={styles.discardText}>خروج دون حفظ</Text>
                </Pressable>
                <Pressable
                  testID="cli-save"
                  disabled={phase !== 'ACTIVE' || hasCliError}
                  onPress={confirmSave}
                  style={[
                    styles.save,
                    (phase !== 'ACTIVE' || hasCliError) && styles.disabled,
                  ]}
                >
                  <Text style={styles.saveText}>save وإعادة التشغيل</Text>
                </Pressable>
              </View>
            </View>
          </>
        )}

        <View style={styles.status}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
        <Text style={styles.hardware}>
          REQUIRES HARDWARE TEST · نجاح prompt لا يثبت صحة الأمر أو ملاءمة الضبط
          للطائرة؛ راجع مخرجات CLI واختبر على الطاولة بلا مراوح.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: {
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
    gap: spacing.lg,
  },
  hero: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  eyebrow: { ...typography.eyebrow, color: colors.accentStrong },
  title: {
    ...typography.display,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  identityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  identity: { ...typography.caption, color: colors.textMuted },
  phase: {
    ...typography.caption,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    fontWeight: '700',
  },
  phaseOpen: { color: colors.success, backgroundColor: colors.accentSoft },
  warning: {
    backgroundColor: '#FFF7E6',
    borderWidth: 1,
    borderColor: '#E6B75D',
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  warningTitle: { ...typography.sectionTitle, color: colors.warning },
  warningText: {
    ...typography.body,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  error: {
    backgroundColor: '#FFF0F2',
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  errorText: { ...typography.body, color: colors.error, textAlign: 'right' },
  start: {
    minHeight: 54,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.xl,
  },
  startText: { ...typography.sectionTitle, color: colors.accentText },
  disabled: { opacity: 0.42 },
  quickCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  hint: { ...typography.caption, color: colors.textMuted, textAlign: 'right' },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quick: {
    minWidth: 145,
    flexGrow: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    gap: spacing.xs,
  },
  quickText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  quickCode: {
    ...typography.mono,
    color: colors.accentStrong,
    textAlign: 'left',
  },
  terminalCard: {
    overflow: 'hidden',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: '#223344',
    backgroundColor: '#0B1118',
  },
  terminalHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: '#111C27',
  },
  terminalTitle: { ...typography.sectionTitle, color: '#E7F5F3' },
  terminalTools: { flexDirection: 'row', gap: spacing.lg },
  toolText: { ...typography.caption, color: colors.accent, fontWeight: '700' },
  terminal: { height: 360, padding: spacing.md },
  terminalText: {
    ...typography.mono,
    color: '#C8F7E8',
    textAlign: 'left',
    writingDirection: 'ltr',
  },
  commandRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#223344',
  },
  commandInput: {
    ...typography.mono,
    flex: 1,
    minHeight: 48,
    color: '#F3FFFC',
    backgroundColor: '#111C27',
    borderWidth: 1,
    borderColor: '#365064',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    textAlign: 'left',
    writingDirection: 'ltr',
  },
  send: {
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
  },
  sendText: { ...typography.body, color: colors.accentText, fontWeight: '700' },
  historyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  historyCount: {
    ...typography.caption,
    color: '#91A3B4',
    marginStart: 'auto',
  },
  decision: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  decisionCopy: { gap: spacing.xs },
  decisionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  discard: {
    minHeight: 50,
    flex: 1,
    minWidth: 210,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  discardText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  save: {
    minHeight: 50,
    flex: 1,
    minWidth: 210,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.error,
    borderRadius: radii.md,
  },
  saveText: { ...typography.body, color: colors.white, fontWeight: '700' },
  status: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  statusText: {
    ...typography.body,
    color: colors.accentText,
    textAlign: 'right',
  },
  hardware: {
    ...typography.caption,
    color: colors.warning,
    textAlign: 'center',
  },
});

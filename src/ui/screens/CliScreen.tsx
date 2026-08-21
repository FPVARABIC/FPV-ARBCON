import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  rawCliSessionController,
  type CliCommandResult,
  type RawCliPhase,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {PROSE_MEASURE, colors, noticeSurface, radii, spacing, typography, useContentEnvelope} from '../theme';
import {Icon} from '../icons';
import {firmwareFamilyLabel} from '../presentation/brandSafeText';
import {readInteraction} from '../components/controls/interaction';
import {MIN_TOUCH_TARGET} from '../components/controls';

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

/**
 * How far from the bottom still counts as "at the bottom". A few pixels of
 * slack keeps rounding and momentum from silently detaching the follow.
 */
const TERMINAL_STICK_SLACK = 24;

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
  const { t } = useTranslation();
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

  /**
   * FOLLOW THE OUTPUT, BUT LET GO WHEN THE OPERATOR READS BACK.
   *
   * Betaflight scrolls its terminal to the bottom on every write
   * (writeToOutput in src/js/tabs/cli.js). Ours never scrolled at all, so on
   * a long answer - `diff all` is thousands of lines - new output landed
   * below the fold and the operator had to chase it by hand.
   *
   * Following blindly is the opposite mistake: it yanks the view away from
   * someone scrolled up reading an error. So the view sticks to the bottom
   * only while it is ALREADY at the bottom; scrolling up releases it, and
   * scrolling back down re-arms it.
   */
  const terminalRef = useRef<ScrollView>(null);
  const stickToBottom = useRef(true);
  const onTerminalScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y;
      stickToBottom.current = distanceFromBottom <= TERMINAL_STICK_SLACK;
    },
    [],
  );
  const onTerminalContentSizeChange = useCallback(() => {
    if (stickToBottom.current)
      terminalRef.current?.scrollToEnd({animated: false});
  }, []);

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

  /**
   * CLI FINAL: a professional terminal opens READY. When this tab is
   * active over a live session and no CLI window exists, entry begins
   * immediately - no intermediate start screen. One attempt per
   * activation: a failed entry parks with its real reason and an
   * explicit retry, it never loops.
   */
  const autoEntryTried = useRef(false);
  useEffect(() => {
    if (!active || sessionKey === undefined) {
      autoEntryTried.current = false;
      return;
    }
    if (autoEntryTried.current || cli.getPhase() !== 'IDLE') return;
    autoEntryTried.current = true;
    start().catch(() => undefined);
  });

  /**
   * CLI FINAL: the connection died under an open CLI window (the parent
   * clears sessionKey when the physical session ends). Terminate the
   * CLI state truthfully and release every lease so the next session
   * starts from a clean link - never an ambiguous half-open terminal.
   */
  useEffect(() => {
    if (sessionKey === undefined && cli.getPhase() !== 'IDLE') {
      cli.exitWithoutSave().catch(() => undefined);
      setFailure('انقطع اتصال Flight Controller؛ أُنهيت جلسة CLI وتحرر الرابط بأمان.');
      onCliBusyChange(false);
    }
  }, [cli, onCliBusyChange, sessionKey]);

  const identity = useMemo(() => {
    if (!sessionKey) return 'لا توجد جلسة Flight Controller.';
    const state = cli.getIdentification(sessionKey.sessionId);
    if (state.status === 'SUCCEEDED') {
      /*
       * A BOARD THAT DID NOT NAME ITSELF IS NOT NAMED "undefined".
       *
       * This template interpolated board.boardIdentifier unconditionally,
       * and that field is genuinely optional - plenty of boards answer
       * MSP_BOARD_INFO without one. The screen then printed the literal
       * string "undefined" as if it were the board's identity. Found by
       * the width sweep, which reads what is actually on screen.
       *
       * The segment is omitted rather than filled with a placeholder:
       * saying nothing about a board that said nothing is the honest
       * rendering.
       *
       * AND THIS LINE USED TO BE THE LOUDEST BRAND CLAIM IN THE APP.
       *
       * It read `firmware.knownFamily` and `firmware.identifier` straight
       * out of the decoded identity, so the CLI header printed
       * "BETAFLIGHT · BTFL · MSP 1.47 · SPBEF405V5" - the project's name
       * twice, in the app's own chrome, above the app's own terminal.
       *
       * Both fields say the same thing to an operator, and neither is
       * something they can act on. What they CAN act on is whether this
       * application has verified the dialect their board speaks, which is
       * what firmwareFamilyLabel reports. The decoded values are
       * untouched; only this rendering changed - and the terminal below
       * still prints whatever the board itself answers to `version`,
       * because that text is the board speaking, not this application.
       */
      const {firmware, apiVersion, board} = state.identity;
      const parts = [
        firmwareFamilyLabel(firmware.knownFamily),
        `MSP ${apiVersion.apiVersionMajor}.${apiVersion.apiVersionMinor}`,
      ];
      if (
        typeof board.boardIdentifier === 'string' &&
        board.boardIdentifier.length > 0
      ) {
        parts.push(board.boardIdentifier);
      }
      return parts.join(' · ');
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
        `fpv-arbcon-cli-${Date.now()}.txt`,
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
            // THE THREE STAGES, SAID OUT LOUD.
            //
            // `save` reboots the flight controller, so the link is about
            // to die on purpose. Before this, the screen simply announced
            // that the session had closed and told the operator to
            // reconnect "if USB does not come back" - which read as the
            // app having thrown them out for no stated reason, and left
            // every other screen holding a dead session id.
            //
            // The reboot is now a declared lifecycle (fcRebootRecovery.ts):
            // the CLI records the expectation before the bytes go out, the
            // shell recognises the resulting loss as expected rather than
            // as a fault, and the connection workspace reconnects on its
            // own. All this has to do is narrate it honestly.
            setStatus(
              'أُرسل save → يُعاد تشغيل Flight Controller → جارٍ إعادة الاتصال…',
            );
            cli
              .saveAndClose()
              .then(() => {
                setStatus(
                  'حُفظت الإعدادات ويُعاد تشغيل Flight Controller. سيعود الاتصال تلقائيًا خلال ثوانٍ.',
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
        {/* CLI FINAL: ONE compact header - the terminal is the product
            here, so nothing bulky stands before it. The full safety
            teaching lives where it acts: the save confirmation. */}
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>سطر الأوامر</Text>
            <Text style={styles.identity}>{identity}</Text>
          </View>
          <Text style={[styles.phase, isOpen && styles.phaseOpen]}>
            {phaseLabel(phase)}
          </Text>
        </View>
        <Text style={styles.safetyLine} accessibilityRole="alert">
          انزع المراوح، ولا تفصل USB أثناء أمر جارٍ. التليمترية متوقفة طوال
          امتلاك CLI للرابط، ولا يُرسل save إلا من زره الصريح.
        </Text>

        {failure ? (
          <View style={styles.error} accessibilityRole="alert">
            <Text style={styles.errorText}>{failure}</Text>
            {!isOpen && sessionKey !== undefined && active ? (
              <Pressable
                testID="cli-start"
                onPress={() => start().catch(() => undefined)}
                style={styles.retry}
              >
                <Text style={styles.retryText}>إعادة محاولة الدخول</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {sessionKey === undefined ? (
          <View style={styles.noSession} testID="cli-no-session">
            <Text style={styles.noSessionText}>
              لا توجد جلسة Flight Controller. اتصل بالمتحكم أولًا ثم افتح
              CLI؛ الطرفية تدخل الجلسة تلقائيًا.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.terminalCard}>
              <View style={styles.terminalHeader}>
                <Text style={styles.terminalTitle}>مخرجات المتحكم الحية</Text>
                <View style={styles.terminalTools}>
                  <Pressable
                    testID="cli-download-output"
                    accessibilityRole="button"
                    accessibilityLabel="تنزيل السجل"
                    accessibilityState={{
                      disabled: !output.trim() || phase !== 'ACTIVE',
                    }}
                    disabled={!output.trim() || phase !== 'ACTIVE'}
                    onPress={() => downloadOutput().catch(() => undefined)}
                    style={state => {
                      const {pressed, hovered} = readInteraction(state);
                      return [
                        styles.tool,
                        (hovered || pressed) && styles.toolActive,
                        (!output.trim() || phase !== 'ACTIVE') &&
                          styles.toolDisabled,
                      ];
                    }}
                  >
                    <Icon name="download" size={18} color={colors.accent} />
                    <Text style={styles.toolText}>تنزيل السجل</Text>
                  </Pressable>
                  <Pressable
                    testID="cli-clear-output"
                    accessibilityRole="button"
                    accessibilityLabel="مسح العرض"
                    accessibilityState={{disabled: phase !== 'ACTIVE'}}
                    disabled={phase !== 'ACTIVE'}
                    style={state => {
                      const {pressed, hovered} = readInteraction(state);
                      return [
                        styles.tool,
                        (hovered || pressed) && styles.toolActive,
                        phase !== 'ACTIVE' && styles.toolDisabled,
                      ];
                    }}
                    onPress={() => {
                      try {
                        cli.clearOutput();
                        sync();
                      } catch (error) {
                        setFailure(errorText(error));
                      }
                    }}
                  >
                    <Icon name="trash-2" size={18} color={colors.accent} />
                    <Text style={styles.toolText}>مسح العرض</Text>
                  </Pressable>
                </View>
              </View>
              <ScrollView
                ref={terminalRef}
                style={styles.terminal}
                nestedScrollEnabled
                onScroll={onTerminalScroll}
                scrollEventThrottle={64}
                onContentSizeChange={onTerminalContentSizeChange}
                testID="cli-terminal-scroll"
              >
                <Text
                  /* Selectable ON PURPOSE: the terminal log is meant to
                     be read and copied. The shell's non-selectable chrome
                     policy (index.html) names this testID explicitly as
                     an opt-out, so it keeps native selection and a real
                     caret. */
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
                <Pressable
                  onPress={() => browseHistory(1)}
                  accessibilityRole="button"
                  accessibilityLabel="الأمر السابق"
                  style={state => {
                    const {pressed, hovered} = readInteraction(state);
                    return [styles.tool, (hovered || pressed) && styles.toolActive];
                  }}
                >
                  {/* Vertical: 'earlier in the list', not a reading
                      direction, so raw geometry and never an alias. */}
                  <Icon name="arrow-up" size={18} color={colors.accent} />
                  <Text style={styles.toolText}>السابق</Text>
                </Pressable>
                <Pressable
                  onPress={() => browseHistory(-1)}
                  accessibilityRole="button"
                  accessibilityLabel="الأمر الأحدث"
                  style={state => {
                    const {pressed, hovered} = readInteraction(state);
                    return [styles.tool, (hovered || pressed) && styles.toolActive];
                  }}
                >
                  <Icon name="arrow-down" size={18} color={colors.accent} />
                  <Text style={styles.toolText}>الأحدث</Text>
                </Pressable>
                <Text style={styles.historyCount}>
                  سجل هذه الجلسة: {history.length}
                </Text>
              </View>
            </View>

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
          {t('hardwareVerification.behaviourTitle')} · نجاح prompt لا يثبت صحة
          الأمر أو ملاءمة الضبط للطائرة؛ راجع مخرجات CLI واختبر على الطاولة بلا
          مراوح.
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
  /* CLI FINAL: one compact header row instead of a hero card - the
     terminal is the first real surface on this screen. */
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerCopy: { flex: 1, minWidth: 0, gap: 2 },
  eyebrow: { ...typography.eyebrow, color: colors.accentStrong },
  title: {
    ...typography.title,
    color: colors.textPrimary,
    textAlign: 'right',
  },
  identity: { ...typography.caption, color: colors.textMuted },
  safetyLine: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    textAlign: 'right',
    backgroundColor: colors.warningSoft,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, maxWidth: PROSE_MEASURE},
  noSession: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  noSessionText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right', maxWidth: PROSE_MEASURE},
  retry: {
    marginTop: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.error,
  },
  retryText: { ...typography.body, color: colors.error, fontWeight: '700' },
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
  error: {...noticeSurface, backgroundColor: colors.errorSoft,
    borderColor: colors.error},
  errorText: { ...typography.body, color: colors.error, textAlign: 'right', maxWidth: PROSE_MEASURE},
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
  hint: { ...typography.caption, color: colors.textMuted, textAlign: 'right', maxWidth: PROSE_MEASURE},
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
    ...typography.bodyStrong,
    color: colors.textPrimary,
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
  /* Terminal chrome sits on the dark terminal surface, so it keeps local
     colours rather than the light shared Button - but it now obeys the
     same target floor and state rules. */
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
  },
  toolActive: { backgroundColor: 'rgba(94, 234, 212, 0.16)' },
  toolDisabled: { opacity: 0.45 },
  toolText: { ...typography.label, color: colors.accent, maxWidth: PROSE_MEASURE},
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
    /* A flex item will not shrink below its own intrinsic width unless
       told it may, and a text input's intrinsic width is generous. At
       360 that left the input 21px wider than the row could give it and
       pushed the send button clean off the card's left edge (measured:
       the card needed 315px of 306). Nothing changes at any width where
       the row already fits. */
    minWidth: 0,
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
    textAlign: 'right', maxWidth: PROSE_MEASURE},
  hardware: {
    ...typography.caption,
    color: colors.warning,
    textAlign: 'center', maxWidth: PROSE_MEASURE},
});

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
import { useTranslation } from 'react-i18next';
import {
  filterCompatiblePresets,
  type FirmwarePresetCategory,
  type FirmwarePresetSummary,
} from '../../core';
import {
  firmwarePresetRepository,
  rawCliSessionController,
  type CliBatchResult,
  type LoadedFirmwarePreset,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  colors,
  radii,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';
import {Icon} from '../icons';

export type PresetsRepositoryPort = Pick<
  typeof firmwarePresetRepository,
  'loadIndex' | 'loadFirmwareVersion' | 'loadPreset' | 'commands'
>;

export type PresetsCliPort = Pick<
  typeof rawCliSessionController,
  | 'getPhase'
  | 'begin'
  | 'captureDiffAll'
  | 'saveTextFile'
  | 'executeBatch'
  | 'saveAndClose'
  | 'exitWithoutSave'
>;

interface Props {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onCliBusyChange: (busy: boolean) => void;
  readonly repository?: PresetsRepositoryPort;
  readonly cli?: PresetsCliPort;
}
const CATEGORY_LABEL: Record<FirmwarePresetCategory, string> = {
  TUNE: 'Tune',
  RATES: 'Rates',
  OSD: 'OSD',
  VTX: 'VTX',
  LEDS: 'LEDs',
  MODES: 'Modes',
  FILTERS: 'Filters',
  RC_LINK: 'RC Link',
  BNF: 'BNF',
  OTHER: 'Other',
};
const ALL_CATEGORIES: readonly FirmwarePresetCategory[] = [
  'TUNE',
  'RATES',
  'FILTERS',
  'RC_LINK',
  'MODES',
  'OSD',
  'VTX',
  'LEDS',
  'BNF',
  'OTHER',
];
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function PresetsScreen({
  sessionKey,
  active,
  onCliBusyChange,
  repository = firmwarePresetRepository,
  cli = rawCliSessionController,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { maxWidth } = useContentEnvelope(true);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [firmwareVersion, setFirmwareVersion] = useState<string>();
  const [presets, setPresets] = useState<readonly FirmwarePresetSummary[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FirmwarePresetCategory | 'ALL'>(
    'ALL',
  );
  const [selected, setSelected] = useState<FirmwarePresetSummary>();
  const [loaded, setLoaded] = useState<LoadedFirmwarePreset>();
  const [selectedOptions, setSelectedOptions] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [backupReady, setBackupReady] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [batch, setBatch] = useState<CliBatchResult>();
  const [cliOpen, setCliOpen] = useState(false);
  const [status, setStatus] = useState(
    'حمّل الفهرس الرسمي ثم اختر حزمة متوافقة.',
  );
  const setBusy = useCallback(
    (busy: boolean) => onCliBusyChange(busy),
    [onCliBusyChange],
  );
  const loadCatalog = useCallback(async () => {
    if (!sessionKey) return;
    setLoading(true);
    setFailure(undefined);
    setSelected(undefined);
    setLoaded(undefined);
    try {
      const [index, version] = await Promise.all([
        repository.loadIndex(),
        repository.loadFirmwareVersion(sessionKey),
      ]);
      const compatible = filterCompatiblePresets(index, version.versionString);
      setFirmwareVersion(version.versionString);
      setPresets(compatible);
      setStatus(
        compatible.length
          ? `عُثر على ${compatible.length} حزمة متوافقة مع ${version.versionString}.`
          : `لا توجد حزم في المصدر الرسمي للإصدار ${version.versionString}.`,
      );
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [repository, sessionKey]);
  useEffect(() => {
    if (active && presets.length === 0 && !loading && failure === undefined)
      loadCatalog().catch(() => undefined);
  }, [active, failure, loadCatalog, loading, presets.length]);
  useEffect(
    () => () => {
      if (cli.getPhase() !== 'IDLE')
        cli.exitWithoutSave().catch(() => undefined);
    },
    [cli],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return presets.filter(
      preset =>
        (category === 'ALL' || preset.category === category) &&
        (!needle ||
          [preset.title, preset.author ?? '', ...preset.keywords]
            .join(' ')
            .toLowerCase()
            .includes(needle)),
    );
  }, [category, presets, query]);
  const choosePreset = useCallback(
    async (preset: FirmwarePresetSummary) => {
      setSelected(preset);
      setLoaded(undefined);
      setDetailsLoading(true);
      setFailure(undefined);
      setBackupReady(false);
      setBatch(undefined);
      try {
        const detail = await repository.loadPreset(preset);
        setLoaded(detail);
        setSelectedOptions(
          new Set(
            detail.document.options
              .filter(option => option.checkedByDefault)
              .map(option => option.name),
          ),
        );
        setStatus('تم التحقق من بصمة الملف. راجع الوصف والخيارات قبل التطبيق.');
      } catch (error) {
        setFailure(errorText(error));
      } finally {
        setDetailsLoading(false);
      }
    },
    [repository],
  );
  const toggleOption = useCallback(
    (name: string) => {
      if (!loaded) return;
      setSelectedOptions(current => {
        const next = new Set(current);
        const option = loaded.document.options.find(item => item.name === name);
        if (next.has(name)) next.delete(name);
        else {
          if (option?.exclusive && option.group)
            for (const sibling of loaded.document.options)
              if (sibling.group === option.group) next.delete(sibling.name);
          next.add(name);
        }
        return next;
      });
    },
    [loaded],
  );
  const commands = useMemo(
    () => (loaded ? repository.commands(loaded, selectedOptions) : []),
    [loaded, repository, selectedOptions],
  );
  const createBackup = useCallback(async () => {
    if (!sessionKey) return;
    setBusy(true);
    setFailure(undefined);
    setStatus('إنشاء نسخة diff all من المتحكم…');
    try {
      await cli.begin(sessionKey);
      const backup = await cli.captureDiffAll();
      const saved = await cli.saveTextFile(
        `betaflight-backup-${firmwareVersion ?? 'unknown'}.txt`,
        backup,
      );
      if (!saved)
        throw new Error('لم يكتمل حفظ ملف النسخة الاحتياطية على الجهاز.');
      await cli.exitWithoutSave();
      setBackupReady(true);
      setStatus('حُفظت نسخة diff all. يمكنك الآن تطبيق الحزمة مؤقتًا.');
    } catch (error) {
      await cli.exitWithoutSave().catch(() => undefined);
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [cli, firmwareVersion, sessionKey, setBusy]);
  const applyNow = useCallback(async () => {
    if (!sessionKey || !loaded || !backupReady || commands.length === 0) return;
    setBusy(true);
    setFailure(undefined);
    setBatch(undefined);
    setProgress({ done: 0, total: commands.length });
    setStatus('تطبيق الأوامر داخل CLI دون save…');
    try {
      await cli.begin(sessionKey);
      setCliOpen(true);
      const result = await cli.executeBatch(commands, (done, total) =>
        setProgress({ done, total }),
      );
      setBatch(result);
      setStatus(
        result.errors.length
          ? `ظهرت ${result.errors.length} أخطاء CLI. الحفظ محظور؛ اخرج دون حفظ.`
          : 'اكتمل التطبيق المؤقت بلا أخطاء. راجع النتيجة ثم احفظ أو اخرج دون حفظ.',
      );
    } catch (error) {
      setCliOpen(false);
      setBusy(false);
      setFailure(errorText(error));
    }
  }, [backupReady, cli, commands, loaded, sessionKey, setBusy]);
  const confirmApply = useCallback(() => {
    if (!loaded) return;
    const warning = loaded.completeWarning.trim();
    Alert.alert(
      'تطبيق Preset مؤقتًا',
      `${warning ? `${warning}\n\n` : ''}سيُرسل ${
        commands.length
      } أمرًا إلى CLI دون save. أبقِ المراوح منزوعة.`,
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'تطبيق مؤقت',
          style: 'destructive',
          onPress: () => applyNow().catch(() => undefined),
        },
      ],
    );
  }, [applyNow, commands.length, loaded]);
  const closeWithoutSave = useCallback(async () => {
    try {
      await cli.exitWithoutSave();
      setStatus('خرجت من CLI دون save؛ لم تُثبت الحزمة.');
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setCliOpen(false);
      setBusy(false);
    }
  }, [cli, setBusy]);
  const save = useCallback(async () => {
    try {
      await cli.saveAndClose();
      setStatus(
        'أُرسل save وأعيد تشغيل المتحكم. أعد الاتصال إذا لم تعد القراءة تلقائيًا.',
      );
      setBackupReady(false);
    } catch (error) {
      setFailure(errorText(error));
      return;
    } finally {
      setCliOpen(false);
      setBusy(false);
    }
  }, [cli, setBusy]);
  return (
    <View style={styles.root} testID="presets-screen">
      <ScrollView contentContainerStyle={[styles.content, { maxWidth }]}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            BETAFLIGHT OFFICIAL PRESETS · HASH VERIFIED · CLI REVIEW
          </Text>
          <Text style={styles.title}>الحزم الجاهزة</Text>
          <Text style={styles.subtitle}>
            حزم Betaflight الرسمية والمتوافقة فقط؛ معاينة ونسخة احتياطية وتطبيق
            مؤقت قبل الحفظ.
          </Text>
          <View style={styles.identityRow}>
            <Text style={styles.identity}>
              Firmware: {firmwareVersion ?? '—'}
            </Text>
            <Text style={styles.identity}>المصدر: presets.betaflight.com</Text>
          </View>
        </View>
        {failure ? (
          <View style={styles.error}>
            <Text style={styles.errorText}>{failure}</Text>
          </View>
        ) : null}
        <View style={styles.toolbar}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="ابحث بالاسم أو المؤلف أو الكلمة…"
            placeholderTextColor={colors.textMuted}
            style={styles.search}
            editable={!cliOpen}
          />
          <Pressable
            testID="presets-reload"
            style={styles.reload}
            onPress={() => loadCatalog().catch(() => undefined)}
            disabled={loading || cliOpen}
          >
            <Text style={styles.reloadText}>
              {loading ? 'تحميل…' : 'تحديث الفهرس'}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categories}
        >
          <Pressable
            onPress={() => setCategory('ALL')}
            style={[styles.chip, category === 'ALL' && styles.chipOn]}
          >
            <Text style={styles.chipText}>الكل</Text>
          </Pressable>
          {ALL_CATEGORIES.map(item => (
            <Pressable
              key={item}
              onPress={() => setCategory(item)}
              style={[styles.chip, category === item && styles.chipOn]}
            >
              <Text style={styles.chipText}>{CATEGORY_LABEL[item]}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.workspace}>
          <View style={styles.list}>
            <Text style={styles.sectionTitle}>
              الحزم المتوافقة ({filtered.length})
            </Text>
            {filtered.slice(0, 160).map(preset => (
              <Pressable
                key={preset.fullPath}
                testID={`preset-${preset.fullPath}`}
                onPress={() => choosePreset(preset).catch(() => undefined)}
                style={[
                  styles.preset,
                  selected?.fullPath === preset.fullPath && styles.presetOn,
                ]}
              >
                <View style={styles.badges}>
                  <Text style={styles.badge}>
                    {CATEGORY_LABEL[preset.category]}
                  </Text>
                  <Text style={styles.badge}>{preset.status}</Text>
                </View>
                <Text style={styles.presetTitle}>{preset.title}</Text>
                <Text style={styles.meta}>
                  {preset.author ?? 'Betaflight community'} ·{' '}
                  {preset.firmwareVersions.join(', ')}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.detail}>
            <Text style={styles.sectionTitle}>المراجعة قبل التطبيق</Text>
            {detailsLoading ? (
              <Text style={styles.hint}>تحميل الملف والتحقق من بصمته…</Text>
            ) : null}
            {!loaded ? (
              <Text style={styles.hint}>
                اختر Preset من القائمة لعرض ما سيتغير.
              </Text>
            ) : (
              <>
                <Text style={styles.detailTitle}>{loaded.summary.title}</Text>
                {loaded.document.descriptions.map((line, index) => (
                  <Text key={index} style={styles.description}>
                    {line || ' '}
                  </Text>
                ))}
                {loaded.completeWarning ? (
                  <View style={styles.warning}>
                    <Text style={styles.warningText}>
                      {loaded.completeWarning}
                    </Text>
                  </View>
                ) : null}
                {loaded.document.options.length ? (
                  <View style={styles.options}>
                    <Text style={styles.subhead}>الخيارات</Text>
                    {loaded.document.options.map(option => (
                      <Pressable
                        key={option.name}
                        testID={`preset-option-${option.name}`}
                        onPress={() => toggleOption(option.name)}
                        accessibilityRole={
                          option.exclusive ? 'radio' : 'checkbox'
                        }
                        accessibilityLabel={option.name}
                        accessibilityState={{
                          checked: selectedOptions.has(option.name),
                          selected: selectedOptions.has(option.name),
                        }}
                        aria-checked={selectedOptions.has(option.name)}
                        style={[
                          styles.option,
                          selectedOptions.has(option.name) && styles.optionOn,
                        ]}
                      >
                        <Icon
                          name={
                            selectedOptions.has(option.name)
                              ? 'circle-check'
                              : 'circle'
                          }
                          size={20}
                          color={
                            selectedOptions.has(option.name)
                              ? colors.accentStrong
                              : colors.textMuted
                          }
                        />
                        <View style={styles.optionCopy}>
                          <Text style={styles.optionName}>{option.name}</Text>
                          {option.group ? (
                            <Text style={styles.meta}>
                              {option.group}
                              {option.exclusive ? ' · اختيار واحد' : ''}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                <View style={styles.commandSummary}>
                  <Text style={styles.commandCount}>{commands.length}</Text>
                  <Text style={styles.hint}>
                    أمر CLI بعد تطبيق الخيارات وINCLUDE
                  </Text>
                </View>
                <Pressable
                  testID="presets-backup"
                  style={[styles.primary, cliOpen && styles.disabled]}
                  disabled={cliOpen}
                  onPress={() => createBackup().catch(() => undefined)}
                >
                  <Text style={styles.primaryText}>
                    {backupReady
                      ? 'نسخة diff all محفوظة'
                      : '1 · أنشئ واحفظ نسخة diff all'}
                  </Text>
                </Pressable>
                <Pressable
                  testID="presets-apply"
                  style={[
                    styles.apply,
                    (!backupReady || cliOpen || !commands.length) &&
                      styles.disabled,
                  ]}
                  disabled={!backupReady || cliOpen || !commands.length}
                  onPress={confirmApply}
                >
                  <Text style={styles.applyText}>2 · طبّق مؤقتًا دون save</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
        {progress.total ? (
          <View style={styles.progress}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(
                    (progress.done * 100) / progress.total,
                  )}%`,
                },
              ]}
            />
            <Text style={styles.progressText}>
              {progress.done}/{progress.total}
            </Text>
          </View>
        ) : null}
        {cliOpen ? (
          <View style={styles.decision} accessibilityRole="alert">
            <Text style={styles.decisionTitle}>
              {batch?.errors.length
                ? 'أخطاء CLI — الحفظ محظور'
                : 'الحزمة مطبقة مؤقتًا'}
            </Text>
            {batch?.errors.map((item, index) => (
              <Text key={index} style={styles.cliError}>
                {item.command}:{' '}
                {item.response.replace(/\s+/g, ' ').slice(0, 240)}
              </Text>
            ))}
            <View style={styles.decisionActions}>
              <Pressable
                testID="presets-discard"
                style={styles.cancel}
                onPress={() => closeWithoutSave().catch(() => undefined)}
              >
                <Text style={styles.cancelText}>إلغاء والخروج دون حفظ</Text>
              </Pressable>
              <Pressable
                testID="presets-save"
                style={[
                  styles.save,
                  Boolean(batch?.errors.length) && styles.disabled,
                ]}
                disabled={Boolean(batch?.errors.length)}
                onPress={() => save().catch(() => undefined)}
              >
                <Text style={styles.saveText}>حفظ وإعادة تشغيل FC</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <View style={styles.status}>
          <Text style={styles.statusText}>{status}</Text>
        </View>
        <Text style={styles.hardware}>
          {t('hardwareVerification.behaviourTitle')} · نجاح إرسال CLI لا يثبت
          جودة الضبط أو سلامة الطيران؛ اختبر على الطاولة بلا مراوح.
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
    padding: spacing.lg,
    gap: spacing.md,
  },
  hero: {
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: spacing.xs,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  identityRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  identity: {
    ...typography.caption,
    color: colors.accentText,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
  },
  error: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.error,
  },
  errorText: {
    // Was weight+colour with no token, so the blocked-session message
    // rendered in the system fallback font. Measured in a browser.
    ...typography.bodyStrong,
    color: colors.error,
    writingDirection: 'rtl',
  },
  toolbar: { flexDirection: 'row', gap: spacing.sm },
  search: {
    flex: 1,
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    textAlign: 'right',
  },
  reload: {
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
  },
  reloadText: {...typography.label, color: colors.accentStrong},
  categories: { gap: spacing.xs, paddingVertical: spacing.xs },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accentStrong },
  chipText: {...typography.label, color: colors.textPrimary},
  workspace: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  list: { flexGrow: 1, flexBasis: 340, gap: spacing.sm },
  detail: {
    flexGrow: 2,
    flexBasis: 480,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: spacing.md,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  preset: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: spacing.xs,
  },
  presetOn: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
  },
  badges: { flexDirection: 'row', gap: spacing.xs },
  badge: {
    ...typography.caption,
    color: colors.accentStrong,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.pill,
  },
  presetTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  meta: { ...typography.caption, color: colors.textMuted },
  hint: {
    ...typography.body,
    color: colors.textMuted,
    writingDirection: 'rtl',
  },
  detailTitle: {
    ...typography.sectionTitle,
    color: colors.accentStrong,
    writingDirection: 'rtl',
  },
  description: {
    ...typography.body,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  warning: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  warningText: { color: colors.warning, writingDirection: 'rtl' },
  options: { gap: spacing.xs },
  subhead: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  option: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  optionOn: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
  },
  optionCopy: { flex: 1 },
  optionName: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  commandSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  commandCount: {...typography.display, color: colors.accentStrong},
  primary: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentStrong,
  },
  primaryText: {...typography.label, color: colors.accentStrong},
  apply: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  applyText: {...typography.label, color: colors.textPrimary},
  disabled: { opacity: 0.4 },
  progress: {
    height: 28,
    borderRadius: radii.pill,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    justifyContent: 'center',
  },
  progressFill: {
    position: 'absolute',
    height: '100%',
    backgroundColor: colors.accent,
  },
  progressText: {
    textAlign: 'center',
    color: colors.textPrimary,
    fontWeight: '700',
  },
  decision: {
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.warning,
    gap: spacing.sm,
  },
  decisionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  cliError: {
    ...typography.caption,
    color: colors.error,
    writingDirection: 'ltr',
  },
  decisionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cancel: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  cancelText: { color: colors.error, fontWeight: '700' },
  save: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  saveText: { color: colors.textPrimary, fontWeight: '700' },
  status: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
  },
  statusText: {
    ...typography.label,
    color: colors.accentText,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  hardware: {
    ...typography.caption,
    color: colors.warning,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});

/**
 * RENAMING, COPYING AND RESETTING A PROFILE - EACH SAYING WHAT IT REALLY DID.
 *
 * =====================================================================
 * WHY THESE THREE LIVE TOGETHER AND BEHIND THE EXPERT TIER
 * =====================================================================
 *
 * They are the operations that act on a profile AS A WHOLE rather than on
 * a value inside it, and every one of them can lose work. None belongs in
 * the default tier next to the profile picker, where a mis-tap costs a
 * tune.
 *
 * =====================================================================
 * THE THREE TRUTHS THIS CARD REFUSES TO BLUR
 * =====================================================================
 *
 * NAMES ARE EIGHT BYTES, NOT EIGHT CHARACTERS (§21). The firmware's buffer
 * is `sizeof(profileName) - 1` bytes and it TRUNCATES silently, then
 * acknowledges - so a name that does not fit comes back as a different
 * name that looks saved. The encoder refuses instead, this card counts
 * BYTES as the operator types, and the controller reads the name back
 * before reporting anything. The ASCII restriction is OUR product policy,
 * not a firmware limit, and is described as such.
 *
 * COPYING ONTO THE ACTIVE PROFILE IS REFUSED BY US, NOT BY THE BOARD
 * (§22). The firmware would do it - and would leave the stored
 * configuration and the running behaviour disagreeing, because the
 * handler runs no re-initialisation afterwards. That is a trap, so this
 * card will not offer it; the sentence says whose rule it is.
 *
 * RESET DOES NOT PERSIST, AND IS NOT FULLY VERIFIED (§23). The firmware
 * command rewrites the profile in RAM and writes no EEPROM. This app can
 * observe part of the result and says exactly which part; the rest is
 * untested rather than assumed. It is never called "restored to defaults
 * and saved".
 */

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import {
  MAX_PROFILE_NAME_BYTES,
  profileNameByteLength,
} from '../../../core/protocol/msp/encoding/encodeProfileCommands';
import {Button, ChoiceChips, NoticeBox} from '../controls';
import {Icon} from '../../icons';
import {colors, radii, spacing, typography} from '../../theme';

export const PROFILE_MANAGEMENT_COPY = Object.freeze({
  title: 'إدارة الملفات',
  hint: 'عمليات تطال الملف كله. راجع أثرها قبل تنفيذها.',
  renameTitle: 'اسم الملف',
  renameHint:
    'يخزّن المتحكم الاسم في ثمانية BYTES. التطبيق يقصر الأحرف على ASCII كسياسة '
    + 'منتج - لا كحدّ من البرنامج الثابت - ويقرأ الاسم بعد الكتابة للتحقق.',
  renameTooLong: (bytes: number): string =>
    `الاسم يشغل ${bytes} بايت والحدّ ${MAX_PROFILE_NAME_BYTES}. المتحكم يقتطع بصمت `
    + 'ثم يؤكّد، فلن نرسله: اختصره بنفسك حتى تعرف الاسم الذي سيُحفظ.',
  renameNonAscii:
    'التطبيق يقبل ASCII فقط في اسم الملف. هذه سياسة هذا التطبيق، وليست حدًّا من '
    + 'متحكم الطيران.',
  copyTitle: 'نسخ ملف إلى آخر',
  copyHint: 'يُستبدل محتوى الملف الوجهة بالكامل. لا يمكن التراجع.',
  copyActiveRefused:
    'لن ينسخ التطبيق فوق الملف النشط. المتحكم يسمح بذلك، لكنه لا يعيد تهيئة ما '
    + 'يعمل الآن بعده، فتبقى القيم المخزّنة والسلوك الطائر مختلفين حتى إعادة '
    + 'التشغيل. هذه قاعدة هذا التطبيق.',
  copySameRefused: 'الملف المصدر والوجهة واحد؛ لا شيء لينسخ.',
  resetTitle: 'إعادة الملف إلى قيم المصنع',
  resetHint:
    'يعيد المتحكم كامل ملف PID إلى قيمه الافتراضية في الذاكرة العاملة فقط؛ '
    + 'الأمر نفسه لا يحفظها حفظًا دائمًا، فلن تبقى بعد فصل البطارية. يشمل ذلك '
    + 'الاسم وشرائح الضبط المبسّط، لا المعاملات وحدها.',
  resetConfirmTitle: 'إعادة الملف إلى قيم المصنع؟',
  resetConfirmBody:
    'ستفقد ضبط هذا الملف بالكامل. لن نتمكن من التحقق من كل حقل: سنعرض بالضبط ما '
    + 'قرأناه وما لم نقرأه.',
});

export interface ProfileManagementCardProps {
  readonly profileCount?: number;
  readonly activeIndex?: number;
  readonly currentName?: string;
  readonly busy: boolean;
  readonly canRename: boolean;
  readonly canCopy: boolean;
  readonly canReset: boolean;
  readonly onRename: (name: string) => void;
  readonly onCopy: (sourceIndex: number, destinationIndex: number) => void;
  readonly onReset: () => void;
  readonly testID?: string;
}

/** True only for the characters `encodeSetProfileName` will accept. */
function isAscii(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return false;
  }
  return true;
}

export default function ProfileManagementCard({
  profileCount, activeIndex, currentName, busy,
  canRename, canCopy, canReset, onRename, onCopy, onReset, testID = 'pid-profile-management',
}: ProfileManagementCardProps): React.JSX.Element {
  const [name, setName] = useState<string | undefined>(undefined);
  /**
   * THE TYPED DRAFT IS DROPPED WHEN THE PROFILE'S OWN NAME MOVES.
   *
   * A reset rewrites the name on the board, and so does switching profile.
   * Holding on to what the operator typed before that would leave the field
   * showing a name that is no longer stored anywhere - and the byte counter
   * counting it. The React-documented derive-state-during-render pattern,
   * because an effect here would render the stale name once first.
   */
  const [seenName, setSeenName] = useState(currentName);
  if (seenName !== currentName) {
    setSeenName(currentName);
    setName(undefined);
  }
  const [source, setSource] = useState<number | undefined>(undefined);
  const [destination, setDestination] = useState<number | undefined>(undefined);
  const [confirmingReset, setConfirmingReset] = useState(false);
  /* FOLDED BY DEFAULT, exactly like the expert groups above it. Measured
     at 390: expanded this card is 764px, which is most of a phone screen
     given to three operations an operator performs rarely. Its header
     costs 82px and says what is inside. */
  const [open, setOpen] = useState(false);

  const draftName = name ?? currentName ?? '';
  const nameBytes = profileNameByteLength(draftName);
  const nameTooLong = nameBytes > MAX_PROFILE_NAME_BYTES;
  const nameNotAscii = !isAscii(draftName);
  const nameChanged = currentName !== undefined && draftName !== currentName;

  const indexes = Array.from({length: profileCount ?? 0}, (_unused, index) => index);
  const copyOntoActive = destination !== undefined && destination === activeIndex;
  const copySameIndex = source !== undefined && destination !== undefined && source === destination;
  const copyReady = source !== undefined && destination !== undefined && !copyOntoActive && !copySameIndex;

  return <View style={styles.card} testID={testID}>
    <Pressable
      onPress={() => setOpen(value => !value)}
      accessibilityRole="button"
      accessibilityState={{expanded: open}}
      accessibilityLabel={PROFILE_MANAGEMENT_COPY.title}
      style={styles.header}
      testID={`${testID}-toggle`}>
      <View style={styles.heading}>
        <Text style={styles.title}>{PROFILE_MANAGEMENT_COPY.title}</Text>
        <Text style={styles.hint}>{PROFILE_MANAGEMENT_COPY.hint}</Text>
      </View>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accentStrong} />
    </Pressable>
    {!open ? null : <View style={styles.body} testID={`${testID}-body`}>

      {/* ---- rename ---------------------------------------------------- */}
      {canRename ? <View style={styles.block} testID={`${testID}-rename`}>
        <Text style={styles.blockTitle}>{PROFILE_MANAGEMENT_COPY.renameTitle}</Text>
        <Text style={styles.hint}>{PROFILE_MANAGEMENT_COPY.renameHint}</Text>
        <TextInput
          value={draftName}
          onChangeText={setName}
          editable={!busy}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={PROFILE_MANAGEMENT_COPY.renameTitle}
          style={[styles.input, busy && styles.inputDisabled]}
          testID={`${testID}-name-input`}
        />
        {/* BYTES, counted as typed - the unit the firmware's buffer is in. */}
        <Text style={styles.counter} testID={`${testID}-name-bytes`}>
          {`${nameBytes} / ${MAX_PROFILE_NAME_BYTES} بايت`}
        </Text>
        {nameTooLong ? <NoticeBox variant="warning" testID={`${testID}-name-too-long`}>
          <Text style={styles.noticeText}>{PROFILE_MANAGEMENT_COPY.renameTooLong(nameBytes)}</Text>
        </NoticeBox> : null}
        {nameNotAscii ? <NoticeBox variant="warning" testID={`${testID}-name-non-ascii`}>
          <Text style={styles.noticeText}>{PROFILE_MANAGEMENT_COPY.renameNonAscii}</Text>
        </NoticeBox> : null}
        <Button
          label="حفظ الاسم والتحقق"
          variant="secondary"
          icon="check"
          disabled={busy || !nameChanged || nameTooLong || nameNotAscii}
          onPress={() => onRename(draftName)}
          testID={`${testID}-name-save`}
        />
      </View> : null}

      {/* ---- copy ------------------------------------------------------ */}
      {canCopy && indexes.length > 1 ? <View style={styles.block} testID={`${testID}-copy`}>
        <Text style={styles.blockTitle}>{PROFILE_MANAGEMENT_COPY.copyTitle}</Text>
        <Text style={styles.hint}>{PROFILE_MANAGEMENT_COPY.copyHint}</Text>
        <Text style={styles.fieldLabel}>من</Text>
        <ChoiceChips
          options={indexes.map(index => ({key: String(index), label: `ملف ${index + 1}`}))}
          selectedKey={source === undefined ? null : String(source)}
          onSelect={key => setSource(Number.parseInt(key, 10))}
          disabled={busy}
          accessibilityLabel="الملف المصدر"
          testID={`${testID}-copy-source`}
        />
        <Text style={styles.fieldLabel}>إلى</Text>
        <ChoiceChips
          options={indexes.map(index => ({
            key: String(index),
            label: `ملف ${index + 1}`,
            note: index === activeIndex ? 'نشط' : undefined,
          }))}
          selectedKey={destination === undefined ? null : String(destination)}
          onSelect={key => setDestination(Number.parseInt(key, 10))}
          disabled={busy}
          accessibilityLabel="الملف الوجهة"
          testID={`${testID}-copy-destination`}
        />
        {copyOntoActive ? <NoticeBox variant="warning" testID={`${testID}-copy-active-refused`}>
          <Text style={styles.noticeText}>{PROFILE_MANAGEMENT_COPY.copyActiveRefused}</Text>
        </NoticeBox> : null}
        {copySameIndex && !copyOntoActive
          ? <NoticeBox variant="warning" testID={`${testID}-copy-same-refused`}>
            <Text style={styles.noticeText}>{PROFILE_MANAGEMENT_COPY.copySameRefused}</Text>
          </NoticeBox>
          : null}
        <Button
          label="نسخ والتحقق"
          variant="secondary"
          icon="copy"
          disabled={busy || !copyReady}
          onPress={() => {
            if (source !== undefined && destination !== undefined) onCopy(source, destination);
          }}
          testID={`${testID}-copy-run`}
        />
      </View> : null}

      {/* ---- reset ----------------------------------------------------- */}
      {canReset ? <View style={styles.block} testID={`${testID}-reset`}>
        <Text style={styles.blockTitle}>{PROFILE_MANAGEMENT_COPY.resetTitle}</Text>
        <Text style={styles.hint}>{PROFILE_MANAGEMENT_COPY.resetHint}</Text>
        {confirmingReset
          ? <View style={styles.confirm} testID={`${testID}-reset-confirm`}>
            <Text style={styles.blockTitle}>{PROFILE_MANAGEMENT_COPY.resetConfirmTitle}</Text>
            <Text style={styles.noticeText}>{PROFILE_MANAGEMENT_COPY.resetConfirmBody}</Text>
            <View style={styles.confirmActions}>
              <Button
                label="تراجع"
                variant="secondary"
                onPress={() => setConfirmingReset(false)}
                testID={`${testID}-reset-cancel`}
              />
              <Button
                label="نفّذ الإعادة"
                variant="danger"
                icon="rotate-ccw"
                disabled={busy}
                onPress={() => { setConfirmingReset(false); onReset(); }}
                testID={`${testID}-reset-run`}
              />
            </View>
          </View>
          : <Button
            label="إعادة إلى قيم المصنع"
            variant="secondary"
            icon="rotate-ccw"
            disabled={busy}
            onPress={() => setConfirmingReset(true)}
            testID={`${testID}-reset-open`}
          />}
      </View> : null}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    minHeight: 48,
  },
  heading: {flex: 1, gap: 2},
  body: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  title: {...typography.sectionTitle, color: colors.textPrimary, textAlign: 'right'},
  blockTitle: {...typography.label, color: colors.textPrimary, textAlign: 'right'},
  hint: {...typography.caption, color: colors.textMuted, textAlign: 'right'},
  fieldLabel: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  block: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  input: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    minHeight: 44,
    textAlign: 'left',
    backgroundColor: colors.background,
  },
  inputDisabled: {color: colors.disabled, backgroundColor: colors.surfaceAlt},
  counter: {...typography.caption, color: colors.textMuted, textAlign: 'left'},
  noticeText: {...typography.caption, color: colors.textPrimary, textAlign: 'right'},
  confirm: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.warningSoft,
  },
  confirmActions: {flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end'},
});

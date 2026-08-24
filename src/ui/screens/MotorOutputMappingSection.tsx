/**
 * FC OUTPUT MAPPING - READ FIRST, THEN EDIT IT DIRECTLY.
 *
 * WHAT CHANGED IN M-F3 (P0-3, §9-§13). Pressing «ترتيب المخارج» used to
 * open a card whose ONLY write path was the guided Quad-X derivation -
 * which demands four completed observations - behind a capability gate
 * that refused every non-quad airframe. On a hex, the primary button
 * changed colour and nothing useful could ever happen. Now:
 *
 *   READ   runs by itself when the tool opens (the button remains for
 *          re-reading). Nothing else is needed to LOOK.
 *   EDIT   is a DIRECT editor over the read vector, for ANY motor count:
 *          tap two motors to swap which output feeds which - a swap can
 *          only ever produce a permutation of what the flight controller
 *          reported. Save goes through the same controller transaction
 *          as always (fresh re-read + stale-base guard, disarmed proof,
 *          the full-length reorder write, EEPROM, readback - the wire
 *          command is named ONLY in the controller, by the PART Z
 *          guard), and the outcome prints the READBACK.
 *   GUIDED the M-C observation-derived flow is kept for the airframe it
 *          was built for - it needs the Quad X position template, so THAT
 *          tool (and only that tool) stays behind the template gate.
 *
 * WHAT IS DISPLAYED. `values[i]` is the resource driven by LOGICAL MOTOR
 * i+1, exactly as the flight controller reported it. A failed read shows
 * a failure - never identity, never a template. M NUMBERS ARE NEVER
 * RENAMED (§12): reordering changes which OUTPUT feeds M3; M3 stays M3.
 *
 * A saved order is applied by the firmware only at motor-device init
 * (pwm_output_hw.c:213 at the pinned revision) - the reboot note states
 * it on every save.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorVerificationState } from '../../core/state/motorVerificationModel';
import type { MotorIdentificationCapability } from '../../core/state/motorIdentificationCapability';
import {
  motorConfigurationController,
  type MotorOutputOrderLoadOutcome,
  type MotorOutputOrderSaveOutcome,
} from '../../platforms/react-native/protocol';
import {
  MotorOutputReorderPanel,
  type MotorOutputOrderControllerPort,
} from './MotorOutputReorderPanel';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

export interface MotorOutputMappingSectionProps {
  readonly sessionId: string | undefined;
  /** Logical motors this aircraft has. Rows are drawn for these only. */
  readonly motorCount: number | undefined;
  readonly verification: MotorVerificationState;
  readonly capability: MotorIdentificationCapability;
  readonly onEndMotorTestSession: () => Promise<void>;
  readonly onDirtyChange?: (dirty: boolean) => void;
  /**
   * Set when a motor command may currently be live. A configuration read
   * shares the link with the test lease, so it waits rather than competing.
   */
  readonly blockedReason?: string;
  /** Lifts the read vector so the identity section can name one output. */
  readonly onValuesChange?: (values: readonly number[] | undefined) => void;
  readonly controller?: MotorOutputOrderControllerPort & {
    loadOutputOrder(sessionId: string): Promise<MotorOutputOrderLoadOutcome>;
  };
}

type Phase = 'IDLE' | 'LOADING' | 'LOADED' | 'ERROR';
type EditorMode = 'NONE' | 'DIRECT' | 'GUIDED';

function saveMessage(
  t: (key: string) => string,
  outcome: MotorOutputOrderSaveOutcome,
): { text: string; danger: boolean } {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return { text: t('motorOutputReorder.noChanges'), danger: false };
    case 'SAVED_VERIFIED':
      return { text: t('motorOutputReorder.saved'), danger: false };
    case 'SAVED_UNVERIFIED':
      return { text: t('motorOutputReorder.savedUnverified'), danger: true };
    case 'UNCONFIRMED':
      return { text: t('motorOutputReorder.unconfirmed'), danger: true };
    case 'REJECTED':
      return { text: t('motorOutputReorder.rejected'), danger: true };
    case 'SESSION_ENDED':
      return { text: t('motorOutputReorder.sessionEnded'), danger: true };
    case 'FAILED':
      return { text: t('motorOutputReorder.failed'), danger: true };
  }
}

export function MotorOutputMappingSection({
  sessionId,
  motorCount,
  verification,
  capability,
  onEndMotorTestSession,
  onDirtyChange,
  blockedReason,
  onValuesChange,
  controller = motorConfigurationController,
}: MotorOutputMappingSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [values, setValues] = useState<readonly number[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [mode, setMode] = useState<EditorMode>('NONE');
  /** The direct editor's working copy - full-length, so the tail the
   * firmware demands is carried verbatim. */
  const [draftOrder, setDraftOrder] = useState<readonly number[]>();
  /** The first motor of a pending swap. */
  const [swapAnchor, setSwapAnchor] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<
    { text: string; danger: boolean } | undefined
  >();

  // A vector read from one session says nothing about the next one.
  useEffect(() => {
    setPhase('IDLE');
    setValues(undefined);
    setError(undefined);
    setMode('NONE');
    setDraftOrder(undefined);
    setSwapAnchor(undefined);
    setSaveResult(undefined);
    onValuesChange?.(undefined);
    // onValuesChange is intentionally omitted: it is a fresh closure on
    // every parent render, and including it would re-run this reset and
    // wipe a good read on any unrelated parent update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const load = useCallback(async () => {
    if (sessionId === undefined || phase === 'LOADING' || blockedReason) {
      return;
    }
    setPhase('LOADING');
    setError(undefined);
    try {
      const outcome = await controller.loadOutputOrder(sessionId);
      if (outcome.kind === 'LOADED') {
        setValues(outcome.values);
        onValuesChange?.(outcome.values);
        setPhase('LOADED');
        return;
      }
      // NO SILENT FALLBACK. An unread mapping stays unread.
      setValues(undefined);
      onValuesChange?.(undefined);
      setError(
        outcome.kind === 'REJECTED'
          ? t('motorOutputReorder.rejected')
          : outcome.kind === 'SESSION_ENDED'
          ? t('motorOutputReorder.sessionEnded')
          : t('motorOutputReorder.failed'),
      );
      setPhase('ERROR');
    } catch {
      setValues(undefined);
      onValuesChange?.(undefined);
      setError(t('motorOutputReorder.failed'));
      setPhase('ERROR');
    }
  }, [blockedReason, controller, onValuesChange, phase, sessionId, t]);

  /* M-F3 §13 - OPENING THE TOOL IS THE READ. The primary button opened a
     card whose first control was "اقرأ" - a second press to begin doing
     anything. The read is safe (read-only, waits for a quiet link), so
     it now runs when the tool mounts; the button remains for re-reads
     and for the retry after a failure. */
  const autoReadWanted =
    sessionId !== undefined && phase === 'IDLE' && !blockedReason;
  useEffect(() => {
    if (autoReadWanted) {
      load().catch(() => undefined);
    }
  }, [autoReadWanted, load]);

  /** Rows are drawn for LOGICAL motors, not for the whole vector. */
  const rowCount =
    values === undefined
      ? 0
      : Math.min(
          values.length,
          motorCount !== undefined && motorCount > 0 ? motorCount : values.length,
        );
  const tailPreserved = values !== undefined && values.length > rowCount;

  const editorDirty =
    draftOrder !== undefined &&
    values !== undefined &&
    draftOrder.some((value, index) => value !== values[index]);

  useEffect(() => {
    onDirtyChange?.(editorDirty);
    return () => onDirtyChange?.(false);
    // Guided panel reports its own dirtiness through the same callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorDirty]);

  const openDirectEditor = useCallback(() => {
    if (values === undefined) {
      return;
    }
    setMode('DIRECT');
    setDraftOrder([...values]);
    setSwapAnchor(undefined);
    setSaveResult(undefined);
  }, [values]);

  const closeDirectEditor = useCallback(() => {
    setMode('NONE');
    setDraftOrder(undefined);
    setSwapAnchor(undefined);
  }, []);

  /** Tap one motor, then another: their OUTPUTS swap. Two taps can only
   * ever exchange two members of the read vector, so the draft is a
   * permutation by construction - the §6 property the controller's own
   * encoder re-checks before anything reaches the wire. */
  const tapEditorRow = useCallback(
    (index: number) => {
      if (draftOrder === undefined || saving) {
        return;
      }
      if (swapAnchor === undefined) {
        setSwapAnchor(index);
        return;
      }
      if (swapAnchor === index) {
        setSwapAnchor(undefined);
        return;
      }
      const next = [...draftOrder];
      const held = next[swapAnchor];
      next[swapAnchor] = next[index];
      next[index] = held;
      setDraftOrder(next);
      setSwapAnchor(undefined);
      setSaveResult(undefined);
    },
    [draftOrder, saving, swapAnchor],
  );

  const saveDirect = useCallback(async () => {
    if (
      sessionId === undefined ||
      values === undefined ||
      draftOrder === undefined ||
      !editorDirty ||
      saving
    ) {
      return;
    }
    setSaving(true);
    setSaveResult(undefined);
    let outcome: MotorOutputOrderSaveOutcome;
    try {
      // The full transaction lives in the controller: fresh re-read with
      // stale-base guard, disarmed proof, full-length write, EEPROM,
      // readback. `values` is the base this editor showed the operator.
      outcome = await controller.saveOutputOrder(sessionId, values, draftOrder);
    } catch (saveError) {
      outcome = { kind: 'FAILED', error: saveError };
    }
    setSaveResult(saveMessage(t, outcome));
    if (outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES') {
      // §13: what the rows now show is the READBACK, not the wish.
      setValues(outcome.values);
      onValuesChange?.(outcome.values);
      setDraftOrder(undefined);
      setSwapAnchor(undefined);
      setMode('NONE');
    }
    setSaving(false);
  }, [
    controller,
    draftOrder,
    editorDirty,
    onValuesChange,
    saving,
    sessionId,
    t,
    values,
  ]);

  /** Usable, or explained - never a silent grey control. */
  const disabledReason: string | undefined =
    blockedReason ??
    (sessionId === undefined
      ? t('motorsScreen.mappingBlockedNoSession')
      : phase === 'LOADING'
        ? t('motorsScreen.mappingReading')
        : undefined);

  const mappingRow = (
    index: number,
    vector: readonly number[],
    interactive: boolean,
  ): React.JSX.Element => {
    const anchored = interactive && swapAnchor === index;
    const body = (
      <>
        <Text style={styles.rowMotor}>{`M${index + 1}`}</Text>
        <Text style={styles.rowRelation}>
          {t('motorsScreen.mappingRelation')}
        </Text>
        <Text
          style={styles.rowResource}
          testID={`motor-output-${interactive ? 'editor-' : ''}row-M${
            index + 1
          }-value`}
        >
          {t('motorOutputReorder.resource', { value: vector[index] + 1 })}
        </Text>
      </>
    );
    return interactive ? (
      <Pressable
        key={index}
        onPress={() => tapEditorRow(index)}
        accessibilityRole="button"
        accessibilityState={{ selected: anchored }}
        style={[styles.row, styles.rowInteractive, anchored && styles.rowAnchored]}
        testID={`motor-output-editor-row-M${index + 1}`}
      >
        {body}
      </Pressable>
    ) : (
      <View key={index} style={styles.row} testID={`motor-output-row-M${index + 1}`}>
        {body}
      </View>
    );
  };

  return (
    <View style={styles.card} testID="motor-output-mapping-section">
      <Text style={styles.eyebrow}>{t('motorsScreen.mappingEyebrow')}</Text>
      <Text style={styles.title}>{t('motorsScreen.mappingTitle')}</Text>
      <Text style={styles.caption}>{t('motorsScreen.mappingSubtitle')}</Text>

      {sessionId === undefined ? (
        <Text style={styles.caption} testID="motor-output-mapping-no-session">
          {t('motorsScreen.mappingNeedsSession')}
        </Text>
      ) : null}

      {/* MEASURED DEFECT (browser probe, no motor session): this control
          rendered aria-disabled with pointer-events:none and NO reason
          anywhere - the operator saw a grey button that could not be
          pressed and said nothing. Reading the firmware's output order
          needs only a real configuration session and a quiet link, so the
          one state that genuinely blocks it now says so on the control
          itself. No new capability, no fallback mapping, no write. */}
      {disabledReason !== undefined ? (
        <Text style={styles.caption} testID="motor-output-mapping-blocked">
          {disabledReason}
        </Text>
      ) : null}

      {phase === 'LOADED' && values !== undefined && mode !== 'DIRECT' ? (
        <View style={styles.rows} testID="motor-output-mapping-rows">
          {Array.from({ length: rowCount }, (_, index) =>
            mappingRow(index, values, false),
          )}
          {tailPreserved ? (
            <Text style={styles.caption} testID="motor-output-mapping-tail">
              {t('motorsScreen.mappingTailNote', {
                total: values.length,
                shown: rowCount,
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {phase === 'ERROR' && error !== undefined ? (
        <Text style={styles.error} testID="motor-output-mapping-error">
          {error}
        </Text>
      ) : null}

      {phase === 'LOADING' ? (
        <Text style={styles.progress} testID="motor-output-mapping-loading">
          {t('motorsScreen.mappingLoading')}
        </Text>
      ) : null}

      <Pressable
        onPress={load}
        disabled={sessionId === undefined || phase === 'LOADING' || !!blockedReason}
        accessibilityRole="button"
        accessibilityState={{
          disabled: sessionId === undefined || phase === 'LOADING' || !!blockedReason,
        }}
        style={[
          styles.primaryButton,
          (sessionId === undefined || phase === 'LOADING' || !!blockedReason) &&
            styles.buttonDisabled,
        ]}
        testID="motor-output-mapping-read"
      >
        <Text style={styles.primaryButtonText}>
          {phase === 'LOADED'
            ? t('motorsScreen.mappingReread')
            : t('motorsScreen.mappingRead')}
        </Text>
      </Pressable>

      {/* ---- THE DIRECT EDITOR - §11, for any motor count ------------- */}
      {mode === 'DIRECT' && draftOrder !== undefined ? (
        <View style={styles.editor} testID="motor-output-editor">
          <Text style={styles.noticeTitle}>
            {t('motorsScreen.mappingEditorTitle')}
          </Text>
          <Text style={styles.caption}>
            {t('motorsScreen.mappingEditorHint')}
          </Text>
          <View style={styles.rows}>
            {Array.from({ length: rowCount }, (_, index) =>
              mappingRow(index, draftOrder, true),
            )}
          </View>
          {editorDirty ? (
            <Text style={styles.pending} testID="motor-output-editor-dirty">
              {t('motorsScreen.mappingEditorDirty')}
            </Text>
          ) : null}
          {/* Firmware fact, not preference: the array is read at motor
              device init only, so nothing changes until a reboot. */}
          <Text style={styles.caption} testID="motor-output-editor-reboot">
            {t('motorOutputReorder.rebootRequired')}
          </Text>
          <View style={styles.editorButtons}>
            <Pressable
              onPress={closeDirectEditor}
              disabled={saving}
              accessibilityRole="button"
              style={styles.secondaryButton}
              testID="motor-output-editor-cancel"
            >
              <Text style={styles.secondaryButtonText}>
                {t('motorsScreen.mappingEditorCancel')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                saveDirect().catch(() => undefined);
              }}
              disabled={!editorDirty || saving}
              accessibilityRole="button"
              accessibilityState={{ disabled: !editorDirty || saving }}
              style={[
                styles.primaryButton,
                (!editorDirty || saving) && styles.buttonDisabled,
              ]}
              testID="motor-output-editor-save"
            >
              <Text style={styles.primaryButtonText}>
                {t('motorsScreen.mappingEditorSave')}
              </Text>
            </Pressable>
          </View>
          {saving ? (
            <Text style={styles.progress} testID="motor-output-editor-saving">
              {t('motorOutputReorder.saving')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {saveResult !== undefined ? (
        <Text
          style={saveResult.danger ? styles.error : styles.resultGood}
          testID="motor-output-editor-result"
        >
          {saveResult.text}
        </Text>
      ) : null}

      {/* THE EDIT ENTRY - count-based, never behind an airframe template
          (§10: the template gate belongs to the GUIDED tool only). It
          needs a read base to edit, and says so until one exists. */}
      {mode !== 'DIRECT' ? (
        phase === 'LOADED' && values !== undefined && sessionId !== undefined ? (
          <Pressable
            onPress={openDirectEditor}
            accessibilityRole="button"
            style={styles.secondaryButton}
            testID="motor-output-edit"
          >
            <Text style={styles.secondaryButtonText}>
              {t('motorsScreen.mappingEdit')}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.caption} testID="motor-output-edit-needs-read">
            {t('motorsScreen.mappingEditNeedsRead')}
          </Text>
        )
      ) : null}

      {/* THE GUIDED, OBSERVATION-DERIVED FLOW - kept for the airframe its
          position template describes (§10: UX GOOD + SOURCE VALID), and
          honestly absent elsewhere. */}
      {capability.kind === 'SUPPORTED' && sessionId !== undefined ? (
        <Pressable
          onPress={() => setMode(current => (current === 'GUIDED' ? 'NONE' : 'GUIDED'))}
          accessibilityRole="button"
          accessibilityState={{ expanded: mode === 'GUIDED' }}
          style={styles.secondaryButton}
          testID="motor-output-guided"
        >
          <Text style={styles.secondaryButtonText}>
            {t('motorsScreen.mappingGuided')}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.caption} testID="motor-output-edit-unavailable">
          {t('motorsScreen.mappingEditUnavailable')}
        </Text>
      )}

      {mode === 'GUIDED' && capability.kind === 'SUPPORTED' && sessionId !== undefined ? (
        <MotorOutputReorderPanel
          sessionId={sessionId}
          verification={verification}
          onEndMotorTestSession={onEndMotorTestSession}
          onDirtyChange={onDirtyChange}
          controller={controller}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'rtl'},
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  rows: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  rowInteractive: {
    minHeight: 48,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  rowAnchored: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  rowMotor: {
    ...typography.mono,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  rowRelation: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  rowResource: {
    ...typography.body,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    flexShrink: 1, maxWidth: PROSE_MEASURE},
  editor: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.backgroundRaised,
  },
  editorButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  noticeTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl'},
  pending: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  error: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  resultGood: {
    ...typography.body,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  progress: {
    ...typography.body,
    color: colors.accentStrong,
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  primaryButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  primaryButtonText: {
    ...typography.label,
    color: colors.accentText,
    writingDirection: 'rtl'},
  buttonDisabled: { backgroundColor: colors.surfaceAlt },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    ...typography.label,
    color: colors.textPrimary,
    writingDirection: 'rtl'},
});

/**
 * BOARD ALIGNMENT - the surface that tells an operator how their flight
 * controller is mounted, and lets them correct it.
 *
 * WHY IT SITS HERE, beside the 3D model. The model answers "which way is
 * the aircraft pointing right now"; this answers "does the board agree
 * with the airframe at all". They are the same question one step apart,
 * and separating them across screens is how an operator ends up staring
 * at a leaning horizon with no idea which knob owns it.
 *
 * ===================================================================
 * THE 3D MODEL IS NOT THE SOURCE OF TRUTH, AND IS NOT A SECOND ONE
 * ===================================================================
 *
 * Nothing here reads the model, and the model is not re-rotated by what
 * is edited here. That is a correctness requirement, not a stylistic
 * one:
 *
 *   The firmware applies board alignment to the RAW SENSOR VECTORS,
 *   inside alignSensorViaMatrix() (sensors/boardalignment.c), BEFORE
 *   attitude estimation. MSP_ATTITUDE - the feed the 3D model renders -
 *   therefore already carries the corrected attitude. Rotating the model
 *   again in the app by the same angles would count the correction
 *   twice and draw an aircraft that does not exist.
 *
 * So the model already reflects real board alignment, by construction.
 * What it CANNOT do is say whether alignment is configured at all: a
 * level-looking model is equally consistent with "mounted flat" and
 * "we have never read the setting". That gap is what the status row
 * below closes, in words, next to the model:
 *
 *   UNKNOWN     the angles have not been read from this board. The
 *               model is live telemetry, but nothing on this screen is
 *               evidence that orientation is set up.
 *   NEUTRAL     0 / 0 / 0 - read from the board, and standard.
 *   CONFIGURED  read from the board, and non-zero. The values are shown.
 *
 * ===================================================================
 * WHY SAVING RESTARTS THE BOARD
 * ===================================================================
 *
 * MSP 39 stores the angles; only initBoardAlignment() at boot builds the
 * rotation matrix that uses them (fc/init.c:713). Betaflight's own CLI
 * `save` reboots for exactly this reason. The controller sends the
 * restart after the readback, and this card says so plainly rather than
 * reporting a save that the aircraft is not yet flying on.
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {Button, ChoiceChips, Stepper} from '../controls';
import {Icon} from '../../icons';
import {
  BOARD_ALIGNMENT_MAX_DEGREES,
  BOARD_ALIGNMENT_MIN_DEGREES,
  isBoardAlignmentNeutral,
  validateBoardAlignmentDraft,
  type BoardAlignmentAxis,
  type MspBoardAlignmentSnapshot,
} from '../../../core';
import {boardAlignmentController} from '../../../platforms/react-native/protocol';
import type {
  BoardAlignmentController,
  BoardAlignmentSaveOutcome,
  SetupUiSessionKey,
} from '../../../platforms/react-native/protocol';
import {colors, radii, spacing, typography} from '../../theme';

/** The mountings a board is physically fitted in. Anything between them
 *  is trim, and the steppers cover that. */
const YAW_PRESETS = ['0', '90', '180', '270'] as const;
type YawPreset = (typeof YAW_PRESETS)[number];

const AXES: readonly BoardAlignmentAxis[] = ['roll', 'pitch', 'yaw'];

type AxisText = Record<BoardAlignmentAxis, string>;

/** What the card is showing about the board, in one word. */
type AlignmentStatus = 'UNKNOWN' | 'NEUTRAL' | 'CONFIGURED';

type Phase =
  | {kind: 'IDLE'}
  | {kind: 'LOADING'}
  | {kind: 'SAVING'}
  | {kind: 'MESSAGE'; tone: 'ok' | 'warn' | 'bad'; text: string};

function axisOf(
  snapshot: MspBoardAlignmentSnapshot,
  axis: BoardAlignmentAxis,
): number {
  return axis === 'roll'
    ? snapshot.rollDegrees
    : axis === 'pitch'
      ? snapshot.pitchDegrees
      : snapshot.yawDegrees;
}

function toText(snapshot: MspBoardAlignmentSnapshot): AxisText {
  return {
    roll: String(snapshot.rollDegrees),
    pitch: String(snapshot.pitchDegrees),
    yaw: String(snapshot.yawDegrees),
  };
}

/**
 * Text to a whole number, or undefined.
 *
 * Deliberately strict: '', '-', '9-9' and '4.5' are all NOT numbers an
 * operator half-typed into a legal value. Returning undefined keeps the
 * save disabled instead of guessing what they meant.
 */
function parseAngle(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : undefined;
}

function clampStep(current: number, delta: number): number {
  return Math.min(
    BOARD_ALIGNMENT_MAX_DEGREES,
    Math.max(BOARD_ALIGNMENT_MIN_DEGREES, current + delta),
  );
}

export interface BoardAlignmentCardProps {
  sessionKey: SetupUiSessionKey;
  /** False while the screen is not the visible, owning surface. */
  active: boolean;
  /** Injectable for tests; defaults to the app-wide singleton. */
  controller?: BoardAlignmentController;
}

export default function BoardAlignmentCard({
  sessionKey,
  active,
  controller,
}: BoardAlignmentCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const engine = controller ?? boardAlignmentController;
  const [snapshot, setSnapshot] = useState<MspBoardAlignmentSnapshot>();
  const [text, setText] = useState<AxisText>({
    roll: '0',
    pitch: '0',
    yaw: '0',
  });
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<Phase>({kind: 'IDLE'});

  /** Guards every async completion: a reply that arrives after this card
   *  is gone, or after the session moved on, must not write state. */
  const liveKey = useRef(sessionKey);
  liveKey.current = sessionKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applySnapshot = useCallback((next: MspBoardAlignmentSnapshot) => {
    setSnapshot(next);
    setText(toText(next));
  }, []);

  const load = useCallback(
    async (key: SetupUiSessionKey) => {
      setPhase({kind: 'LOADING'});
      const outcome = await engine.load(key);
      if (
        !mounted.current ||
        liveKey.current.sessionId !== key.sessionId ||
        liveKey.current.generation !== key.generation
      ) {
        return;
      }
      if (outcome.kind === 'LOADED') {
        applySnapshot(outcome.snapshot);
        setPhase({kind: 'IDLE'});
        return;
      }
      // A failed read must clear any previous board's values: showing
      // stale angles beside a live model is the exact "orientation looks
      // configured" illusion this card exists to prevent.
      setSnapshot(undefined);
      setEditing(false);
      setPhase({
        kind: 'MESSAGE',
        tone: 'warn',
        text:
          outcome.kind === 'REJECTED'
            ? t(`boardAlignment.blockReasons.${outcome.reason}`)
            : t('boardAlignment.readFailed'),
      });
    },
    [applySnapshot, engine, t],
  );

  // Read on open, and re-read whenever the session identity changes -
  // a reconnect is a different board until proven otherwise.
  useEffect(() => {
    if (!active) {
      return;
    }
    load(sessionKey).catch(() => undefined);
  }, [active, load, sessionKey]);

  const draft = useMemo(() => {
    const roll = parseAngle(text.roll);
    const pitch = parseAngle(text.pitch);
    const yaw = parseAngle(text.yaw);
    if (roll === undefined || pitch === undefined || yaw === undefined) {
      return undefined;
    }
    return {rollDegrees: roll, pitchDegrees: pitch, yawDegrees: yaw};
  }, [text]);

  const issues = useMemo(
    () => (draft === undefined ? undefined : validateBoardAlignmentDraft(draft)),
    [draft],
  );
  const invalid = draft === undefined || (issues !== undefined && issues.length > 0);
  const changed =
    snapshot !== undefined &&
    draft !== undefined &&
    (draft.rollDegrees !== snapshot.rollDegrees ||
      draft.pitchDegrees !== snapshot.pitchDegrees ||
      draft.yawDegrees !== snapshot.yawDegrees);

  const status: AlignmentStatus =
    snapshot === undefined
      ? 'UNKNOWN'
      : isBoardAlignmentNeutral(snapshot)
        ? 'NEUTRAL'
        : 'CONFIGURED';

  const describeSave = useCallback(
    (outcome: BoardAlignmentSaveOutcome): Phase => {
      switch (outcome.kind) {
        case 'NO_CHANGES':
          return {kind: 'MESSAGE', tone: 'ok', text: t('boardAlignment.noChanges')};
        case 'SAVED_VERIFIED':
          return {
            kind: 'MESSAGE',
            tone: 'ok',
            text: outcome.rebootAcknowledged
              ? t('boardAlignment.savedRebooting')
              : t('boardAlignment.savedRebootUnconfirmed'),
          };
        case 'SAVED_UNVERIFIED':
          return {
            kind: 'MESSAGE',
            tone: 'warn',
            text: t('boardAlignment.savedUnverified'),
          };
        case 'UNCONFIRMED':
          return {
            kind: 'MESSAGE',
            tone: 'warn',
            text: t(`boardAlignment.unconfirmed.${outcome.stage}`),
          };
        case 'REJECTED':
          return {
            kind: 'MESSAGE',
            tone: 'bad',
            text: t(`boardAlignment.blockReasons.${outcome.reason}`),
          };
        case 'SESSION_ENDED':
          return {
            kind: 'MESSAGE',
            tone: 'warn',
            text: t('boardAlignment.sessionEnded'),
          };
        default:
          return {kind: 'MESSAGE', tone: 'bad', text: t('boardAlignment.saveFailed')};
      }
    },
    [t],
  );

  const onSave = useCallback(async () => {
    if (snapshot === undefined || draft === undefined || invalid) {
      return;
    }
    const key = sessionKey;
    setPhase({kind: 'SAVING'});
    const outcome = await engine.save(key, snapshot, draft);
    if (
      !mounted.current ||
      liveKey.current.sessionId !== key.sessionId ||
      liveKey.current.generation !== key.generation
    ) {
      return;
    }
    if (outcome.kind === 'SAVED_VERIFIED') {
      applySnapshot(outcome.snapshot);
      setEditing(false);
    } else if (outcome.kind === 'NO_CHANGES') {
      setEditing(false);
    } else if (outcome.kind === 'SAVED_UNVERIFIED' || outcome.kind === 'UNCONFIRMED') {
      // We do not know what the board holds now, so we stop claiming to.
      setSnapshot(undefined);
      setEditing(false);
    }
    setPhase(describeSave(outcome));
  }, [applySnapshot, describeSave, draft, engine, invalid, sessionKey, snapshot]);

  const onCancel = useCallback(() => {
    if (snapshot !== undefined) {
      setText(toText(snapshot));
    }
    setEditing(false);
    setPhase({kind: 'IDLE'});
  }, [snapshot]);

  const busy = phase.kind === 'LOADING' || phase.kind === 'SAVING';
  const yawSelection = YAW_PRESETS.includes(text.yaw as YawPreset)
    ? (text.yaw as YawPreset)
    : null;

  return (
    <View style={styles.root} testID="board-alignment-card">
      <View style={styles.headingRow}>
        <Icon name="move-3d" size={18} color={colors.accentStrong} />
        <View style={styles.headingCopy}>
          <Text style={styles.title}>{t('boardAlignment.title')}</Text>
          <Text style={styles.hint}>{t('boardAlignment.hint')}</Text>
        </View>
        <View
          style={[
            styles.statusPill,
            status === 'UNKNOWN'
              ? styles.statusPillUnknown
              : status === 'NEUTRAL'
                ? styles.statusPillNeutral
                : styles.statusPillConfigured,
          ]}
          testID="board-alignment-status">
          <Text
            style={[
              styles.statusText,
              status === 'UNKNOWN'
                ? styles.statusTextUnknown
                : status === 'NEUTRAL'
                  ? styles.statusTextNeutral
                  : styles.statusTextConfigured,
            ]}>
            {t(`boardAlignment.status.${status}`)}
          </Text>
        </View>
      </View>

      {/* THE SENTENCE THAT KEEPS THE 3D HONEST. It sits with the model,
          in words, because a rendering cannot say "I do not know". */}
      <Text style={styles.statusNote} testID="board-alignment-status-note">
        {t(`boardAlignment.statusNotes.${status}`)}
      </Text>

      {snapshot !== undefined && !editing && (
        <View style={styles.valueRow} testID="board-alignment-values">
          {AXES.map(axis => (
            <View key={axis} style={styles.valueChip}>
              <Text style={styles.valueLabel}>
                {t(`boardAlignment.axes.${axis}`)}
              </Text>
              <Text style={styles.valueNumber} testID={`board-alignment-${axis}-current`}>
                {`${axisOf(snapshot, axis)}°`}
              </Text>
            </View>
          ))}
        </View>
      )}

      {snapshot !== undefined && !editing && (
        <Button
          label={t('boardAlignment.edit')}
          onPress={() => {
            setText(toText(snapshot));
            setPhase({kind: 'IDLE'});
            setEditing(true);
          }}
          variant="secondary"
          icon="pencil"
          disabled={busy}
          testID="board-alignment-edit"
        />
      )}

      {snapshot === undefined && (
        <Button
          label={t('boardAlignment.read')}
          onPress={() => {
            load(sessionKey).catch(() => undefined);
          }}
          variant="secondary"
          icon="refresh-cw"
          disabled={busy || !active}
          testID="board-alignment-read"
        />
      )}

      {editing && snapshot !== undefined && (
        <View style={styles.editor} testID="board-alignment-editor">
          <View style={styles.axisGrid}>
            {AXES.map(axis => {
            const parsed = parseAngle(text[axis]);
            const current = parsed ?? axisOf(snapshot, axis);
            return (
              <View key={axis} style={styles.axisCell}>
                <View style={styles.axisCopy}>
                  <Text style={styles.axisTitle}>
                    {t(`boardAlignment.axes.${axis}`)}
                  </Text>
                  <Text style={styles.axisDetail}>
                    {t(`boardAlignment.axisDetails.${axis}`)}
                  </Text>
                </View>
                <Stepper
                  value={text[axis]}
                  onChangeText={next =>
                    setText(previous => ({...previous, [axis]: next}))
                  }
                  keyboardType="numeric"
                  onDecrement={() =>
                    setText(previous => ({
                      ...previous,
                      [axis]: String(clampStep(current, -1)),
                    }))
                  }
                  onIncrement={() =>
                    setText(previous => ({
                      ...previous,
                      [axis]: String(clampStep(current, 1)),
                    }))
                  }
                  decrementDisabled={
                    parsed !== undefined && parsed <= BOARD_ALIGNMENT_MIN_DEGREES
                  }
                  incrementDisabled={
                    parsed !== undefined && parsed >= BOARD_ALIGNMENT_MAX_DEGREES
                  }
                  disabled={busy}
                  accessibilityLabel={t(`boardAlignment.axes.${axis}`)}
                  testID={`board-alignment-${axis}`}
                />
              </View>
            );
            })}
          </View>

          {/* Boards are fitted in quarter turns; the steppers above are
              for the trim between them, not for travelling 270 degrees
              one tap at a time. */}
          <Text style={styles.presetLabel}>{t('boardAlignment.yawPresets')}</Text>
          <ChoiceChips
            options={YAW_PRESETS.map(preset => ({
              key: preset,
              label: `${preset}°`,
            }))}
            selectedKey={yawSelection}
            onSelect={next => setText(previous => ({...previous, yaw: next}))}
            disabled={busy}
            accessibilityLabel={t('boardAlignment.yawPresets')}
            testID="board-alignment-yaw-presets"
          />

          {invalid && (
            <Text style={styles.invalid} testID="board-alignment-invalid">
              {t('boardAlignment.invalid', {
                min: BOARD_ALIGNMENT_MIN_DEGREES,
                max: BOARD_ALIGNMENT_MAX_DEGREES,
              })}
            </Text>
          )}

          <Text style={styles.rebootNote} testID="board-alignment-reboot-note">
            {t('boardAlignment.rebootNote')}
          </Text>

          <View style={styles.actions}>
            <Button
              label={t('boardAlignment.save')}
              onPress={() => {
                onSave().catch(() => undefined);
              }}
              variant="primary"
              icon="save"
              disabled={busy || invalid || !changed}
              testID="board-alignment-save"
            />
            <Button
              label={t('boardAlignment.cancel')}
              onPress={onCancel}
              variant="secondary"
              icon="x"
              disabled={busy}
              testID="board-alignment-cancel"
            />
          </View>
        </View>
      )}

      {busy && (
        <Text style={styles.busy} testID="board-alignment-busy">
          {t(phase.kind === 'SAVING' ? 'boardAlignment.saving' : 'boardAlignment.reading')}
        </Text>
      )}

      {phase.kind === 'MESSAGE' && (
        <Text
          accessibilityRole="alert"
          style={[
            styles.message,
            phase.tone === 'ok'
              ? styles.messageOk
              : phase.tone === 'warn'
                ? styles.messageWarn
                : styles.messageBad,
          ]}
          testID="board-alignment-message">
          {phase.text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  /* Its own surface, directly beneath the orientation hero and sharing
   * the hero's horizontal inset so the two read as one block. Lighter
   * chrome than the hero deliberately: this is a setting that is checked
   * once, not an instrument that is watched. */
  root: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  headingCopy: {flex: 1, minWidth: 0},
  title: {...typography.sectionTitle, color: colors.textPrimary},
  hint: {...typography.caption, color: colors.textSecondary, marginTop: 2},
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  statusPillUnknown: {backgroundColor: colors.warningSoft},
  statusPillNeutral: {backgroundColor: colors.infoSoft},
  statusPillConfigured: {backgroundColor: colors.successSoft},
  statusText: {...typography.caption, fontWeight: '700'},
  statusTextUnknown: {color: colors.warning},
  statusTextNeutral: {color: colors.info},
  statusTextConfigured: {color: colors.success},
  statusNote: {...typography.caption, color: colors.textSecondary},
  valueRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  valueChip: {
    flexGrow: 1,
    flexBasis: 88,
    minWidth: 0,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
  },
  valueLabel: {...typography.caption, color: colors.textSecondary},
  valueNumber: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  editor: {gap: spacing.sm},
  /**
   * THE THREE AXES AS A WRAPPING GRID, not as three full-width rows.
   *
   * The first version put each label and its stepper in one row with
   * `justifyContent: 'space-between'`. On a phone that reads correctly,
   * because the row wraps. On a 1180px desktop column it stranded every
   * stepper roughly 700px from the label that names it - the same defect
   * the Home redesign had to remove, and worse here, because pressing
   * the wrong axis's '+' changes how an aircraft flies.
   *
   * A 260px basis gives one column below ~560px (phone: label above its
   * stepper, unchanged) and three columns on desktop, matching the
   * three value chips the collapsed state already shows.
   */
  axisGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  axisCell: {flexGrow: 1, flexShrink: 1, flexBasis: 260, minWidth: 0},
  axisCopy: {minWidth: 0, marginBottom: spacing.xs},
  axisTitle: {...typography.body, color: colors.textPrimary, fontWeight: '600'},
  axisDetail: {...typography.caption, color: colors.textSecondary},
  presetLabel: {...typography.caption, color: colors.textSecondary},
  invalid: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '700',
  },
  rebootNote: {...typography.caption, color: colors.textSecondary},
  actions: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  busy: {...typography.caption, color: colors.textSecondary},
  message: {...typography.caption, fontWeight: '600'},
  messageOk: {color: colors.success},
  messageWarn: {color: colors.warning},
  messageBad: {color: colors.error},
});

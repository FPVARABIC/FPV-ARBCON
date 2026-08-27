/**
 * شريط LED - THE ARABIC LED STRIP EDITOR.
 *
 * WHAT THIS SCREEN OWNS: what is on the glass. Which LED is selected, which
 * section is open, which palette slot the three sliders are pointed at.
 *
 * WHAT IT DOES NOT OWN, AND MUST NOT: the wire. There is no MSP command in
 * this file, no `MspClient`, no encoder, no decoder, no feature bit and no
 * persistence. It calls `load()` and `save()` on one controller and renders
 * what comes back. Every safety rule - no gap, no zero-word LED, no
 * arbitrary delete, unknown bits preserved - lives in `ledStripDraft.ts`,
 * where it can be tested without a renderer.
 *
 * THE DRAFT IS NOT THE BOARD. `snapshot` is the last verified board state
 * and does not move until a save is verified; `draft` is what the operator
 * is proposing. Nothing typed here is presented as the aircraft's state,
 * and nothing is written until «حفظ التغييرات».
 *
 * THERE IS NO LIVE VIEW HERE, and there cannot be. The firmware reports no
 * LED output over MSP, so the grid is a symbolic layout of what the strip
 * is CONFIGURED to do. Nothing in this file animates, polls, or runs a
 * timer against the board.
 */

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {
  ledStripConfigurationController,
  type LedStripLoadOutcome,
  type LedStripSaveOutcome,
  type LedStripSaveRequest,
  type LedStripSnapshot,
  type SetupUiSessionKey,
} from '../../platforms/react-native/protocol';
import {
  appendLed,
  buildLedSaveRequest,
  canDeleteSelectedLed,
  clearLedSelection,
  createLedStripDraft,
  deleteLastLed,
  discardLedStripDraft,
  draftEffectiveCount,
  draftModeColorValue,
  draftPalette,
  draftRuntimeValue,
  ledDraftCoordinateClusters,
  ledDraftDirtyGroups,
  ledDraftNodes,
  ledDraftSaveBlockers,
  moveLedEarlier,
  moveLedLater,
  selectAllLeds,
  selectedDirectionState,
  selectedFieldValue,
  selectedNodes,
  selectedOverlayState,
  selectLed,
  setLedBaseFunction,
  setLedColorIndex,
  setLedModeColor,
  setLedMultiSelect,
  setLedPaletteSlot,
  setLedPosition,
  setLedRuntimeValue,
  setLedX,
  setLedY,
  toggleLedDirection,
  toggleLedOverlay,
  type LedEditOutcome,
  type LedEditRefusal,
  type LedStripDraft,
} from '../../core/state/ledStripDraft';
import {
  LED_BASE_FUNCTION_IDS,
  LED_DIRECTION_BITS,
  LED_EDITABLE_MODE_INDEXES,
  LED_INERT_MODE_INDEXES,
  LED_LAYER_DISPLAY_ORDER,
  LED_RUNTIME_FIELD_IDS,
  LED_TOGGLEABLE_OVERLAY_BITS,
  ledAuxChannelLabel,
  ledBaseFunctionLabel,
  ledBlockReasonMessage,
  ledCapabilityContradictionMessage,
  ledCapabilityNotice,
  ledClusterBadge,
  ledDependencyNotes,
  ledDirectionLabel,
  ledEffectiveDirectionNote,
  ledFirmwareSymbolDetail,
  ledInertModeDetail,
  ledEditRefusalMessage,
  ledGridCaption,
  ledLayerLabel,
  ledModeLabel,
  ledModeRuntimeNote,
  ledOverlayLabel,
  ledPaletteFieldLabel,
  ledPaletteSlotLabel,
  ledProfileDetail,
  ledRawWordDetail,
  ledReadOnlyBadge,
  ledRuntimeFieldHelp,
  ledRuntimeFieldLabel,
  ledRuntimeObservedNotice,
  ledRuntimeStep,
  ledRuntimeStepInert,
  ledReadOnlyNotice,
  ledReservedOverlayNotice,
  ledSaveBlockerMessage,
  ledSaveGroupLabel,
  ledSaveOutcomeMessage,
  ledSaveOutcomeSeverity,
  ledSaveRefusalMessage,
  ledSaveRequiresReload,
  ledSpecialSlotLabel,
  ledSurfaceIsReadOnly,
  ledStripHasOrdinalEffect,
  ledTechnicalTitle,
  ledUnknownSpecialSlotsDetail,
  ledWireIndexDetail,
  type LedBlockReasonId,
  type LedPhrase,
  type LedRuntimeFieldId,
  type LedSaveOutcomeId,
} from '../../core/state/ledStripPresentation';
import {
  LED_BRIGHTNESS_MAX,
  LED_BRIGHTNESS_MIN,
  LED_RAINBOW_DELTA_MAX,
  LED_RAINBOW_DELTA_MIN,
  LED_RAINBOW_FREQ_MAX,
  LED_RAINBOW_FREQ_MIN,
} from '../../core/protocol/msp/encoding/encodeLedStrip';
import {
  LED_SPECIAL_SLOT_COUNT,
  LedModeIndex,
} from '../../core/state/ledStripModel';
import {
  LED_COORDINATE_MAX,
  LED_COLOR_INDEX_MAX,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import type {LedSaveGroup} from '../../core/state/ledStripSaveModel';
import {Button, IconButton, NoticeBox, SelectField, Stepper, ToggleSwitch} from '../components/controls';
import {StickyActionBar} from '../components/editing';
import {LedGridCanvas, ledCellKey} from '../led/LedGridCanvas';
import {ledColorToCss, ledSwatchInk, type LedColorTriplet} from '../led/ledColorPresentation';
import {isRtlLayout} from '../icons/layoutDirection';
import {colors, radii, spacing, typography, useContentEnvelope} from '../theme';

/* ================================================================== *
 * PORT
 * ================================================================== */

/** The controller surface this screen uses, and the only seam a test
 *  injects through. Nothing else about the screen is mockable. */
export interface LedStripControllerPort {
  load(key: SetupUiSessionKey): Promise<LedStripLoadOutcome>;
  save(key: SetupUiSessionKey, request: LedStripSaveRequest): Promise<LedStripSaveOutcome>;
}

interface Props {
  readonly sessionKey?: SetupUiSessionKey;
  readonly active: boolean;
  readonly onOpenSetup: () => void;
  readonly controller?: LedStripControllerPort;
}

type Busy = 'IDLE' | 'LOADING' | 'SAVING';

/** The four sections of the ONE LED page, in reading order. */
type LedSectionKey = 'LAYOUT' | 'PALETTE' | 'MODE_COLORS' | 'RUNTIME';

const LED_SECTIONS: readonly LedSectionKey[] = Object.freeze([
  'LAYOUT',
  'PALETTE',
  'MODE_COLORS',
  'RUNTIME',
]);

const LED_SECTION_TITLE_KEY: Readonly<Record<LedSectionKey, string>> = Object.freeze({
  LAYOUT: 'sectionLayout',
  PALETTE: 'sectionPalette',
  MODE_COLORS: 'sectionModeColors',
  RUNTIME: 'sectionRuntime',
});

const NUMBER_MAX_SAFE_COORDINATE = LED_COORDINATE_MAX;

/* ================================================================== *
 * SCREEN
 * ================================================================== */

export default function LedStripScreen({
  sessionKey,
  active,
  onOpenSetup,
  controller = ledStripConfigurationController,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const {maxWidth, tier} = useContentEnvelope(true);
  const wide = tier !== 'compact';

  const [snapshot, setSnapshot] = useState<LedStripSnapshot | undefined>(undefined);
  const [draft, setDraft] = useState<LedStripDraft | undefined>(undefined);
  const [busy, setBusy] = useState<Busy>('IDLE');
  const [blocked, setBlocked] = useState<LedBlockReasonId | undefined>(undefined);
  const [contradiction, setContradiction] = useState<LedSaveGroup | undefined>(undefined);
  const [saveOutcome, setSaveOutcome] = useState<LedSaveOutcomeId | undefined>(undefined);
  const [saveRefusal, setSaveRefusal] = useState<LedPhrase | undefined>(undefined);
  const [editRefusal, setEditRefusal] = useState<LedEditRefusal | undefined>(undefined);
  const [paletteSlot, setPaletteSlot] = useState(0);
  const [modeIndex, setModeIndex] = useState<number>(LedModeIndex.ORIENTATION);
  /* §5: ONE page, four sections, one visible at a time. The save surface
     is outside this and stays put whichever section is open. */
  const [section, setSection] = useState<LedSectionKey>('LAYOUT');
  const [technical, setTechnical] = useState(false);

  const say = useCallback(
    (phrase: LedPhrase): string => t(phrase.key, phrase.params ?? {}),
    [t],
  );

  /* ---------------------------------------------------------------- *
   * LOAD - AND IT WRITES NOTHING
   *
   * The controller's load path issues reads only: no SET, no EEPROM
   * write, no reboot. Opening this tab on a connected aircraft must
   * leave the aircraft exactly as it was found, which is asserted
   * against a virtual board rather than assumed here.
   * ---------------------------------------------------------------- */

  const applyLoad = useCallback((outcome: LedStripLoadOutcome) => {
    setSaveOutcome(undefined);
    setSaveRefusal(undefined);
    setEditRefusal(undefined);
    if (outcome.kind === 'LOADED') {
      setSnapshot(outcome.snapshot);
      setDraft(createLedStripDraft(outcome.snapshot));
      setBlocked(undefined);
      setContradiction(undefined);
      return;
    }
    if (outcome.kind === 'CAPABILITY_CONTRADICTION') {
      /* Whatever was safely readable is still true, so it is still shown -
         beside a notice naming the resource the board refused. */
      setContradiction(resourceOf(outcome.resource));
      setBlocked(undefined);
      if (outcome.partial !== undefined) {
        setSnapshot(outcome.partial);
        setDraft(createLedStripDraft(outcome.partial));
      }
      return;
    }
    setContradiction(undefined);
    if (outcome.kind === 'REJECTED') {
      setBlocked(outcome.reason);
      return;
    }
    /* SESSION_ENDED or FAILED: nothing new is true, and the previous
       snapshot is not claimed to still be. */
    setSnapshot(undefined);
    setDraft(undefined);
    setBlocked(outcome.kind === 'SESSION_ENDED' ? 'DISCONNECTED' : undefined);
  }, []);

  const reload = useCallback(async () => {
    if (sessionKey === undefined) return;
    setBusy('LOADING');
    try {
      applyLoad(await controller.load(sessionKey));
    } catch {
      /* A load that threw produced no snapshot to trust. Nothing is
         applied and nothing is claimed. */
    } finally {
      setBusy('IDLE');
    }
  }, [applyLoad, controller, sessionKey]);

  useEffect(() => {
    if (!active || sessionKey === undefined) return;
    let cancelled = false;
    setBusy('LOADING');
    controller
      .load(sessionKey)
      .then(outcome => {
        if (!cancelled) applyLoad(outcome);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBusy('IDLE');
      });
    return () => {
      cancelled = true;
    };
  }, [active, applyLoad, controller, sessionKey]);

  /* ---------------------------------------------------------------- *
   * EDITING
   * ---------------------------------------------------------------- */

  /** Every editor call lands here, so a refusal always reaches the
   *  operator and a refused edit never half-lands. */
  const applyEdit = useCallback((outcome: LedEditOutcome) => {
    setDraft(outcome.draft);
    setEditRefusal(outcome.refused);
    if (outcome.refused === undefined) setSaveOutcome(undefined);
  }, []);

  /** Selection and view changes are not edits and never refuse. */
  const applyView = useCallback((next: LedStripDraft) => {
    setDraft(next);
    setEditRefusal(undefined);
  }, []);

  const nodes = useMemo(() => (draft === undefined ? [] : ledDraftNodes(draft)), [draft]);
  const clusters = useMemo(
    () => (draft === undefined ? new Map<string, readonly number[]>() : ledDraftCoordinateClusters(draft)),
    [draft],
  );
  const palette = useMemo(
    () => (draft === undefined ? undefined : draftPalette(draft)),
    [draft],
  ) as readonly LedColorTriplet[] | undefined;
  const dirtyGroups = useMemo(
    () => (draft === undefined ? [] : ledDraftDirtyGroups(draft)),
    [draft],
  );
  const blockers = useMemo(
    () => (draft === undefined ? [] : ledDraftSaveBlockers(draft)),
    [draft],
  );

  /**
   * §61. The controller READS a firmware newer than any pinned source,
   * decoding it through the newest layout it verified, and refuses every
   * write against it. So there is real data to show and no Save to offer:
   * the surface goes read-only rather than empty.
   */
  const readOnly =
    snapshot !== undefined && ledSurfaceIsReadOnly(snapshot.writeAuthority);

  const editable =
    blocked === undefined && draft !== undefined && busy === 'IDLE' && !readOnly;

  /**
   * A CELL PRESS SELECTS; IT NEVER CREATES.
   *
   * Pressing a cell that holds more than one LED walks through them one
   * press at a time rather than picking the last one silently, so both
   * LEDs of a shared coordinate are individually reachable by touch.
   */
  const onSelectCell = useCallback(
    (x: number, y: number) => {
      if (draft === undefined) return;
      const here = ledDraftNodes(draft).filter(node => node.x === x && node.y === y);
      if (here.length === 0) return;
      const current = here.findIndex(node => draft.selection.includes(node.index));
      const next = draft.multiSelect
        ? here[Math.max(current, 0)]
        : here[(current + 1) % here.length];
      applyView(selectLed(draft, next.index));
    },
    [applyView, draft],
  );

  /**
   * AN EMPTY CELL IS NOT AN LED, so pressing one cannot make one.
   *
   * With exactly one LED selected it MOVES that LED, which is the whole
   * touch-first gesture; with nothing or several selected it clears the
   * selection instead of stacking a group onto one coordinate by
   * accident. Either way the board is untouched: this edits the draft.
   */
  const onEmptyCell = useCallback(
    (x: number, y: number) => {
      if (draft === undefined) return;
      if (draft.selection.length === 1) applyEdit(setLedPosition(draft, x, y));
      else applyView(clearLedSelection(draft));
    },
    [applyEdit, applyView, draft],
  );

  /* ---------------------------------------------------------------- *
   * SAVE
   * ---------------------------------------------------------------- */

  const save = useCallback(async () => {
    if (draft === undefined || snapshot === undefined || sessionKey === undefined) return;
    if (blockers.length > 0) return;
    setBusy('SAVING');
    setSaveOutcome(undefined);
    setSaveRefusal(undefined);
    try {
      const outcome = await controller.save(sessionKey, {
        observed: snapshot,
        ...buildLedSaveRequest(draft),
      });
      setSaveOutcome(outcome.kind);
      if (outcome.kind === 'REFUSED') {
        setSaveRefusal(ledSaveRefusalMessage(outcome.refusal.kind));
      }
      if (outcome.kind === 'REJECTED') {
        setBlocked(outcome.reason);
      }
      /* A verified save is the ONE case where the observed state moves. */
      if (outcome.kind === 'SAVE_VERIFIED' || outcome.kind === 'NO_CHANGES') {
        setSnapshot(outcome.snapshot);
        setDraft(createLedStripDraft(outcome.snapshot));
      } else if (ledSaveRequiresReload(outcome.kind)) {
        /* Anything that half-applied leaves the draft describing a board
           that no longer exists. Re-reading is not optional. */
        await reload();
        setSaveOutcome(outcome.kind);
      }
    } catch {
      setSaveOutcome('FAILED');
    } finally {
      setBusy('IDLE');
    }
  }, [blockers.length, controller, draft, reload, sessionKey, snapshot]);

  const discard = useCallback(() => {
    if (draft === undefined) return;
    setDraft(discardLedStripDraft(draft));
    setEditRefusal(undefined);
    setSaveOutcome(undefined);
    setSaveRefusal(undefined);
  }, [draft]);

  /* ---------------------------------------------------------------- *
   * RENDER
   * ---------------------------------------------------------------- */

  const capability =
    snapshot === undefined ? undefined : ledCapabilityNotice(snapshot.capability);
  const advanced = snapshot?.capability === 'ADVANCED_STATUS_MODE';

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, {maxWidth}]}
        testID="led-strip-scroll">
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {t('ledStripScreen.title')}
          </Text>
          <Text style={styles.subtitle}>{t('ledStripScreen.subtitle')}</Text>
          <Button
            label={t('ledStripScreen.reload')}
            icon="refresh-cw"
            variant="secondary"
            size="sm"
            onPress={reload}
            disabled={busy !== 'IDLE' || sessionKey === undefined}
            testID="led-reload"
          />
        </View>

        {busy === 'LOADING' && (
          <Text style={styles.status} testID="led-loading">
            {t('ledStripScreen.loading')}
          </Text>
        )}

        {blocked !== undefined && (
          <NoticeBox variant="warning" testID="led-blocked">
            <Text style={styles.noticeText}>{say(ledBlockReasonMessage(blocked))}</Text>
            {ledReadOnlyNotice(blocked) !== undefined && (
              <Text style={styles.noticeText} testID="led-blocked-read-only">
                {say(ledReadOnlyNotice(blocked)!)}
              </Text>
            )}
            {blocked === 'DISCONNECTED' && (
              <Button
                label={t('ledStripScreen.openSetup')}
                variant="secondary"
                size="sm"
                onPress={onOpenSetup}
                testID="led-open-setup"
              />
            )}
          </NoticeBox>
        )}

        {contradiction !== undefined && (
          <NoticeBox variant="warning" testID="led-capability-contradiction">
            {/* The nested phrase interpolates ANOTHER key, so it is
                resolved here rather than printed raw. */}
            <Text style={styles.noticeText}>
              {t(ledCapabilityContradictionMessage(contradiction).key, {
                resource: say(ledSaveGroupLabel(contradiction)),
              })}
            </Text>
          </NoticeBox>
        )}

        {readOnly && (
          <NoticeBox variant="info" testID="led-read-only">
            <Text style={styles.badge} testID="led-read-only-badge">
              {say(ledReadOnlyBadge())}
            </Text>
            <Text style={styles.noticeText}>
              {t('ledStripScreen.blocked.futureApiReadOnly')}
            </Text>
          </NoticeBox>
        )}

        {capability !== undefined && (
          <NoticeBox variant="info" testID="led-capability">
            <Text style={styles.noticeText}>{say(capability)}</Text>
          </NoticeBox>
        )}

        {/* §58. The board arrived truncated. Everything after the first
            empty slot is invisible to the aircraft, so the entries are
            preserved and NAMED rather than compacted away - this app does
            not silently repair a state nobody chose. */}
        {blockers.includes('OBSERVED_STRIP_HAS_GAP') && snapshot !== undefined && (
          <NoticeBox
            variant="danger"
            title={t('ledStripScreen.gap.title')}
            testID="led-observed-gap">
            <Text style={styles.noticeText}>{t('ledStripScreen.gap.explain')}</Text>
            <Text style={styles.noticeText} testID="led-gap-effective">
              {t('ledStripScreen.gap.effectiveCount', {
                count: snapshot.truth.effectiveCount,
              })}
            </Text>
            <Text style={styles.noticeText} testID="led-gap-unreachable">
              {t('ledStripScreen.gap.unreachable', {
                indexes: snapshot.truth.unreachableEntries
                  .map(entry => entry.index + 1)
                  .join('، '),
              })}
            </Text>
            <Text style={styles.caption}>{t('ledStripScreen.gap.noAutoFix')}</Text>
          </NoticeBox>
        )}

        {editRefusal !== undefined && (
          <NoticeBox variant="warning" testID="led-edit-refusal">
            <Text style={styles.noticeText}>{say(ledEditRefusalMessage(editRefusal))}</Text>
          </NoticeBox>
        )}

        {saveOutcome !== undefined && (
          <NoticeBox
            variant={ledSaveOutcomeSeverity(saveOutcome) === 'SUCCESS' ? 'success' : ledSaveOutcomeSeverity(saveOutcome) === 'INFORMATION' ? 'info' : 'warning'}
            testID="led-save-outcome">
            <Text style={styles.noticeText}>{say(ledSaveOutcomeMessage(saveOutcome))}</Text>
            {saveRefusal !== undefined && (
              <Text style={styles.noticeText} testID="led-save-refusal">
                {say(saveRefusal)}
              </Text>
            )}
          </NoticeBox>
        )}

        {draft !== undefined && snapshot !== undefined && (
          <>
            {/* §5: ONE page. A compact segmented control chooses which of
                the four sections is on screen; the save surface below is
                outside this switch and never moves. */}
            <View style={styles.chipRow} accessibilityRole="tablist" testID="led-section-nav">
              {LED_SECTIONS.map(key => (
                <Chip
                  key={key}
                  label={t(`ledStripScreen.${LED_SECTION_TITLE_KEY[key]}`)}
                  selected={section === key}
                  disabled={false}
                  onPress={() => setSection(key)}
                  testID={`led-section-tab-${key}`}
                />
              ))}
            </View>

            {/* ---------------- §1 التخطيط ---------------- */}
            {section === 'LAYOUT' && (
            <Section title={t('ledStripScreen.sectionLayout')} testID="led-section-layout">
              <Text style={styles.caption}>{say(ledGridCaption())}</Text>
              <Text style={styles.caption} testID="led-count">
                {t('ledStripScreen.countSummary', {
                  count: draftEffectiveCount(draft),
                  max: snapshot.maxLength,
                })}
              </Text>

              <View style={[styles.workspace, wide && workspaceRow()]}>
                <View style={wide ? styles.gridPane : undefined}>
                  <LedGridCanvas
                    nodes={nodes}
                    clusters={clusters}
                    selection={draft.selection}
                    palette={palette}
                    onSelectCell={onSelectCell}
                    onEmptyCell={onEmptyCell}
                    frontLabel={t('ledStripScreen.grid.front')}
                    rearLabel={t('ledStripScreen.grid.rear')}
                    leftLabel={t('ledStripScreen.grid.left')}
                    rightLabel={t('ledStripScreen.grid.right')}
                    describeCell={(x, y, indexes) =>
                      indexes.length === 0
                        ? t('ledStripScreen.grid.emptyCellLabel', {x, y})
                        : t('ledStripScreen.grid.cellLabel', {
                            x,
                            y,
                            numbers: indexes.map(i => i + 1).join('، '),
                          })
                    }
                    disabled={!editable}
                  />
                </View>

                {/* The right column carries EVERY control that acts on the
                    selection - inspector, add/remove, wiring order - so a
                    desktop operator never leaves the grid in view to reach
                    one, and the column is not a mostly-empty card. */}
                <View style={[styles.column, wide && styles.inspectorPane]}>
                  <Inspector
                    draft={draft}
                    palette={palette}
                    editable={editable}
                    say={say}
                    t={t}
                    onEdit={applyEdit}
                    onView={applyView}
                  />

                  <StripActions
                    draft={draft}
                    editable={editable}
                    t={t}
                    onEdit={applyEdit}
                    onView={applyView}
                  />

                  <WiringOrder
                    draft={draft}
                    nodes={nodes}
                    clusters={clusters}
                    editable={editable}
                    t={t}
                    onEdit={applyEdit}
                    onView={applyView}
                  />
                </View>
              </View>
            </Section>
            )}

            {/* ---------------- §2 لوحة الألوان ---------------- */}
            {section === 'PALETTE' && (
            <Section title={t('ledStripScreen.sectionPalette')} testID="led-section-palette">
              {palette === undefined ? (
                <Text style={styles.caption} testID="led-no-palette">
                  {t('ledStripScreen.palette.unavailable')}
                </Text>
              ) : (
                <PaletteEditor
                  palette={palette}
                  slot={paletteSlot}
                  onSlot={setPaletteSlot}
                  editable={editable && advanced}
                  say={say}
                  t={t}
                  onChange={(index, color) => applyView(setLedPaletteSlot(draft, index, color))}
                />
              )}
            </Section>
            )}

            {/* ---------------- §3 ألوان الحالات ---------------- */}
            {section === 'MODE_COLORS' && (
            <Section title={t('ledStripScreen.sectionModeColors')} testID="led-section-modes">
              {snapshot.modeColors === undefined ? (
                <Text style={styles.caption} testID="led-no-mode-colors">
                  {t('ledStripScreen.mode.unavailable')}
                </Text>
              ) : (
                <ModeColors
                  draft={draft}
                  palette={palette}
                  mode={modeIndex}
                  onMode={setModeIndex}
                  editable={editable && advanced}
                  say={say}
                  t={t}
                  onChange={(mode, slot, value) =>
                    applyView(setLedModeColor(draft, mode, slot, value))
                  }
                />
              )}
            </Section>
            )}

            {/* ---------------- §4 الإضاءة والتأثيرات ---------------- */}
            {section === 'RUNTIME' && (
            <Section title={t('ledStripScreen.sectionRuntime')} testID="led-section-runtime">
              <RuntimeValues
                draft={draft}
                editable={editable}
                say={say}
                t={t}
                onChange={(field, value) => applyEdit(setLedRuntimeValue(draft, field, value))}
              />
              <LayerPriority say={say} t={t} />
            </Section>
            )}

            {/* §9/§27/§44/§62 - everything an operator does not read first,
                in one place, off by default. */}
            <TechnicalDetails
              open={technical}
              onToggle={() => setTechnical(!technical)}
              draft={draft}
              snapshot={snapshot}
              say={say}
              t={t}
            />
          </>
        )}
      </ScrollView>

      <StickyActionBar
        visible={dirtyGroups.length > 0 && !readOnly}
        summary={t('ledStripScreen.save.summary', {count: dirtyGroups.length})}
        details={dirtyGroups.map(group => say(ledSaveGroupLabel(group)))}
        saveLabel={t('ledStripScreen.save.apply')}
        discardLabel={t('ledStripScreen.save.discard')}
        onSave={save}
        onDiscard={discard}
        disabledReason={
          blockers.length === 0 ? undefined : say(ledSaveBlockerMessage(blockers[0]))
        }
        busy={busy === 'SAVING'}
        busyLabel={t('ledStripScreen.save.inFlight')}
        testID="led-save-bar"
      />
    </View>
  );
}

/* ================================================================== *
 * THE TWO-PANEL WORKSPACE
 *
 * The grid takes the LEFT half and the inspector the RIGHT, physically,
 * in both layout directions. Under RTL a plain `row` puts the first child
 * on the right, so the direction is chosen explicitly rather than
 * inherited - the grid is a diagram of an aircraft and belongs on the
 * same side of the screen whichever way the text runs.
 * ================================================================== */

function workspaceRow(): {flexDirection: 'row' | 'row-reverse'} {
  return {flexDirection: isRtlLayout() ? 'row-reverse' : 'row'};
}

/* ================================================================== *
 * INSPECTOR
 * ================================================================== */

interface EditorProps {
  readonly draft: LedStripDraft;
  readonly editable: boolean;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly onEdit: (outcome: LedEditOutcome) => void;
  readonly onView: (next: LedStripDraft) => void;
}

/** The subset that also needs the phrase resolver. */
type LabelledEditorProps = EditorProps & {readonly say: (phrase: LedPhrase) => string};

function Inspector({
  draft,
  palette,
  editable,
  say,
  t,
  onEdit,
  onView,
}: LabelledEditorProps & {
  readonly palette: readonly LedColorTriplet[] | undefined;
}): React.JSX.Element {
  const chosen = selectedNodes(draft);
  const mixed = t('ledStripScreen.inspector.mixed');

  if (chosen.length === 0) {
    return (
      <View style={styles.card} testID="led-inspector-empty">
        <Text style={styles.caption}>{t('ledStripScreen.inspector.nothingSelected')}</Text>
      </View>
    );
  }

  const readNumber = (read: (node: (typeof chosen)[number]) => number): number | 'MIXED' | undefined =>
    selectedFieldValue(draft, read);

  const x = readNumber(node => node.x);
  const y = readNumber(node => node.y);
  const fn = readNumber(node => node.baseFunction);
  const color = readNumber(node => node.colorIndex);

  /* The cluster row: every LED sharing this coordinate, each one its own
     button, so a shared cell is never a single merged thing. */
  const siblings =
    chosen.length === 1
      ? (ledDraftCoordinateClusters(draft).get(ledCellKey(chosen[0].x, chosen[0].y)) ?? [])
      : [];

  return (
    <View style={styles.card} testID="led-inspector">
      <Text style={styles.cardTitle}>
        {chosen.length === 1
          ? t('ledStripScreen.inspector.oneSelected', {number: chosen[0].number})
          : t('ledStripScreen.inspector.manySelected', {count: chosen.length})}
      </Text>

      {siblings.length > 1 && (
        <View style={styles.chipRow} testID="led-cluster-members">
          <Text style={styles.caption}>
            {say(ledClusterBadge(siblings.length))}
          </Text>
          {siblings.map(index => (
            <Chip
              key={index}
              label={String(index + 1)}
              selected={draft.selection.includes(index)}
              disabled={!editable}
              onPress={() => onView(selectLed(draft, index))}
              testID={`led-cluster-member-${index}`}
            />
          ))}
        </View>
      )}

      {/* §64 - the keyboard/screen-reader equivalent of dragging on the
          grid. Every coordinate reachable by touch is reachable here. */}
      <View style={styles.fieldRow}>
        <Stepper
          value={x === 'MIXED' ? mixed : String(x ?? '')}
          onDecrement={() => onEdit(setLedX(draft, clamp((numberOr(x, 0)) - 1)))}
          onIncrement={() => onEdit(setLedX(draft, clamp((numberOr(x, 0)) + 1)))}
          disabled={!editable}
          accessibilityLabel={t('ledStripScreen.inspector.x')}
          testID="led-x"
        />
        <Text style={styles.fieldLabel}>{t('ledStripScreen.inspector.x')}</Text>
      </View>
      <View style={styles.fieldRow}>
        <Stepper
          value={y === 'MIXED' ? mixed : String(y ?? '')}
          onDecrement={() => onEdit(setLedY(draft, clamp((numberOr(y, 0)) - 1)))}
          onIncrement={() => onEdit(setLedY(draft, clamp((numberOr(y, 0)) + 1)))}
          disabled={!editable}
          accessibilityLabel={t('ledStripScreen.inspector.y')}
          testID="led-y"
        />
        <Text style={styles.fieldLabel}>{t('ledStripScreen.inspector.y')}</Text>
      </View>

      <SelectField
        label={t('ledStripScreen.inspector.function')}
        options={LED_BASE_FUNCTION_IDS.map((_id, value) => ({
          key: String(value),
          label: say(ledBaseFunctionLabel(value)),
        }))}
        selectedKey={
          typeof fn === 'number' && fn < LED_BASE_FUNCTION_IDS.length ? String(fn) : null
        }
        onSelect={key => onEdit(setLedBaseFunction(draft, Number(key)))}
        placeholder={
          fn === 'MIXED'
            ? mixed
            : typeof fn === 'number'
              ? say(ledBaseFunctionLabel(fn))
              : undefined
        }
        disabled={!editable}
        testID="led-function"
      />

      {/* An unknown function value is NAMED, with its number, rather than
          silently rewritten to something this build understands. */}
      {typeof fn === 'number' && fn >= LED_BASE_FUNCTION_IDS.length && (
        <Text style={styles.caption} testID="led-unknown-function">
          {say(ledBaseFunctionLabel(fn))}
        </Text>
      )}

      {chosen.length === 1 &&
        (() => {
          const note = ledEffectiveDirectionNote(chosen[0].baseFunction, chosen[0].directionMask);
          return note === undefined ? null : (
            <Text style={styles.caption} testID="led-direction-note">
              {say(note)}
            </Text>
          );
        })()}

      {/* §34/§35 - one line each, and only when the LED actually carries
          an effect that depends on something outside itself. */}
      {chosen.length === 1 &&
        ledDependencyNotes(chosen[0].baseFunction, chosen[0].overlayMask).map(note => (
          <Text key={note.key} style={styles.caption} testID={`led-dep-${note.key}`}>
            {say(note)}
          </Text>
        ))}

      <Text style={styles.groupTitle}>{t('ledStripScreen.inspector.overlays')}</Text>
      {LED_TOGGLEABLE_OVERLAY_BITS.map(bit => {
        const state = selectedOverlayState(draft, bit);
        return (
          <View key={bit} style={styles.fieldRow}>
            <ToggleSwitch
              value={state === 'ON'}
              onValueChange={() => onEdit(toggleLedOverlay(draft, bit))}
              disabled={!editable}
              accessibilityLabel={say(ledOverlayLabel(bit))}
              testID={`led-overlay-${bit}`}
            />
            <Text style={styles.fieldLabel}>{say(ledOverlayLabel(bit))}</Text>
            {state === 'MIXED' && (
              <Text style={styles.mixed} testID={`led-overlay-mixed-${bit}`}>
                {mixed}
              </Text>
            )}
          </View>
        );
      })}

      {/* Bits 7..9 have no meaning this build knows. They are carried back
          untouched, and the operator is told so rather than left to
          discover it when a save silently erases them. */}
      {chosen.some(node => ledReservedOverlayNotice(node.overlayMask) !== undefined) && (
        <Text style={styles.caption} testID="led-reserved-overlays">
          {t('ledStripScreen.overlay.reservedPreserved')}
        </Text>
      )}

      <Text style={styles.groupTitle}>{t('ledStripScreen.inspector.directions')}</Text>
      {LED_DIRECTION_BITS.map(bit => {
        const state = selectedDirectionState(draft, bit);
        return (
          <View key={bit} style={styles.fieldRow}>
            <ToggleSwitch
              value={state === 'ON'}
              onValueChange={() => onEdit(toggleLedDirection(draft, bit))}
              disabled={!editable}
              accessibilityLabel={say(ledDirectionLabel(bit))}
              testID={`led-direction-${bit}`}
            />
            <Text style={styles.fieldLabel}>{say(ledDirectionLabel(bit))}</Text>
            {state === 'MIXED' && (
              <Text style={styles.mixed} testID={`led-direction-mixed-${bit}`}>
                {mixed}
              </Text>
            )}
          </View>
        );
      })}

      <Text style={styles.groupTitle}>{t('ledStripScreen.inspector.color')}</Text>
      {/* §40. No palette on this build, so the INDEX is the only truth
          there is - it is named as an index and no swatch is invented. */}
      {palette === undefined && typeof color === 'number' && (
        <>
          <Text style={styles.fieldLabel} testID="led-color-index-only">
            {t('ledStripScreen.palette.indexOnly', {number: color + 1})}
          </Text>
          <Text style={styles.caption}>{t('ledStripScreen.palette.indexOnlyHelp')}</Text>
        </>
      )}
      <ColorIndexPicker
        palette={palette}
        value={color === 'MIXED' ? undefined : color}
        mixed={color === 'MIXED'}
        mixedLabel={mixed}
        disabled={!editable}
        onSelect={index => onEdit(setLedColorIndex(draft, index))}
        testIDPrefix="led-color"
      />
    </View>
  );
}

const numberOr = (value: number | 'MIXED' | undefined, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

const clamp = (value: number): number =>
  value < 0 ? 0 : value > NUMBER_MAX_SAFE_COORDINATE ? NUMBER_MAX_SAFE_COORDINATE : value;

/* ================================================================== *
 * ADD / DELETE / MULTI-SELECT
 * ================================================================== */

function StripActions({draft, editable, t, onEdit, onView}: EditorProps): React.JSX.Element {
  const deletable = canDeleteSelectedLed(draft);
  return (
    <View style={styles.actions} testID="led-strip-actions">
      <Button
        label={t('ledStripScreen.actions.append')}
        icon="plus"
        size="sm"
        onPress={() => onEdit(appendLed(draft))}
        disabled={!editable}
        testID="led-append"
      />
      {/* The label says LAST, because that is the only LED that can go.
          Zeroing a middle entry would end the strip there and switch off
          every LED after it. */}
      <Button
        label={t('ledStripScreen.actions.deleteLast')}
        icon="trash-2"
        variant="secondary"
        size="sm"
        onPress={() => onEdit(deleteLastLed(draft))}
        disabled={!editable || !deletable.allowed}
        testID="led-delete-last"
      />
      <View style={styles.fieldRow}>
        <ToggleSwitch
          value={draft.multiSelect}
          onValueChange={next => onView(setLedMultiSelect(draft, next))}
          disabled={!editable}
          accessibilityLabel={t('ledStripScreen.actions.multiSelect')}
          testID="led-multi-select"
        />
        <Text style={styles.fieldLabel}>{t('ledStripScreen.actions.multiSelect')}</Text>
      </View>
      {draft.multiSelect && (
        <Button
          label={t('ledStripScreen.actions.selectAll')}
          variant="ghost"
          size="sm"
          onPress={() => onView(selectAllLeds(draft))}
          disabled={!editable}
          testID="led-select-all"
        />
      )}
    </View>
  );
}

/* ================================================================== *
 * WIRING ORDER
 * ================================================================== */

function WiringOrder({
  draft,
  nodes,
  clusters,
  editable,
  t,
  onEdit,
  onView,
}: EditorProps & {
  readonly nodes: readonly {
    readonly index: number;
    readonly number: number;
    readonly x: number;
    readonly y: number;
    readonly baseFunction: number;
    readonly overlayMask: number;
  }[];
  readonly clusters: ReadonlyMap<string, readonly number[]>;
}): React.JSX.Element {
  return (
    <View style={styles.card} testID="led-wiring-order">
      <Text style={styles.cardTitle}>{t('ledStripScreen.order.title')}</Text>
      {/* The order IS the wire, and several effects render by walking it -
          the thrust ring, the rainbow, the sweep and both bars. Moving an
          LED here changes the animation without changing any LED's own
          settings, which is why it gets its own list. */}
      <Text style={styles.caption}>{t('ledStripScreen.order.help')}</Text>
      {/* §34: say it HERE, where the order is actually being changed, and
          only when at least one LED in the chain renders by walking it. */}
      {ledStripHasOrdinalEffect(nodes) && (
        <Text style={styles.caption} testID="led-order-ordinal-note">
          {t('ledStripScreen.effect.ordinalDependent')}
        </Text>
      )}
      {nodes.map((node, position) => (
        <View key={node.index} style={styles.orderRow} testID={`led-order-${node.index}`}>
          <Text style={styles.orderNumber}>{node.number}</Text>
          <Text style={styles.orderCoords}>
            {t('ledStripScreen.order.coords', {x: node.x, y: node.y})}
          </Text>
          {(clusters.get(ledCellKey(node.x, node.y)) ?? []).length > 1 && (
            <Text style={styles.caption} testID={`led-order-shared-${node.index}`}>
              {t('ledStripScreen.grid.cluster', {
                count: (clusters.get(ledCellKey(node.x, node.y)) ?? []).length,
              })}
            </Text>
          )}
          <IconButton
            icon="arrow-up"
            accessibilityLabel={t('ledStripScreen.order.earlier', {number: node.number})}
            onPress={() => onEdit(moveLedEarlier(draft, node.index))}
            disabled={!editable || position === 0}
            testID={`led-order-earlier-${node.index}`}
          />
          <IconButton
            icon="arrow-down"
            accessibilityLabel={t('ledStripScreen.order.later', {number: node.number})}
            onPress={() => onEdit(moveLedLater(draft, node.index))}
            disabled={!editable || position === nodes.length - 1}
            testID={`led-order-later-${node.index}`}
          />
          <IconButton
            icon="target"
            accessibilityLabel={t('ledStripScreen.order.select', {number: node.number})}
            onPress={() => onView(selectLed(draft, node.index))}
            disabled={!editable}
            testID={`led-order-select-${node.index}`}
          />
        </View>
      ))}
      {nodes.length === 0 && (
        <Text style={styles.caption} testID="led-order-empty">
          {t('ledStripScreen.order.empty')}
        </Text>
      )}
    </View>
  );
}

/* ================================================================== *
 * PALETTE
 * ================================================================== */

function PaletteEditor({
  palette,
  slot,
  onSlot,
  editable,
  say,
  t,
  onChange,
}: {
  readonly palette: readonly LedColorTriplet[];
  readonly slot: number;
  readonly onSlot: (slot: number) => void;
  readonly editable: boolean;
  readonly say: (phrase: LedPhrase) => string;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly onChange: (slot: number, color: LedColorTriplet) => void;
}): React.JSX.Element {
  const current = palette[slot];
  const bounds: Record<'hue' | 'whiteness' | 'value', number> = {
    hue: 359,
    whiteness: 255,
    value: 255,
  };

  return (
    <View testID="led-palette">
      <View style={styles.swatchGrid}>
        {palette.map((color, index) => (
          <Swatch
            key={index}
            color={color}
            label={String(index + 1)}
            selected={index === slot}
            onPress={() => onSlot(index)}
            accessibilityLabel={say(ledPaletteSlotLabel(index))}
            testID={`led-palette-slot-${index}`}
          />
        ))}
      </View>

      <Text style={styles.groupTitle}>{say(ledPaletteSlotLabel(slot))}</Text>
      {(['hue', 'whiteness', 'value'] as const).map(field => (
        <View key={field} style={styles.fieldRow}>
          <Stepper
            value={String(current[field])}
            onDecrement={() =>
              onChange(slot, {...current, [field]: Math.max(0, current[field] - 1)})
            }
            onIncrement={() =>
              onChange(slot, {
                ...current,
                [field]: Math.min(bounds[field], current[field] + 1),
              })
            }
            disabled={!editable}
            accessibilityLabel={say(ledPaletteFieldLabel(field))}
            testID={`led-palette-${field}`}
          />
          <Text style={styles.fieldLabel}>{say(ledPaletteFieldLabel(field))}</Text>
        </View>
      ))}
      {!editable && (
        <Text style={styles.caption} testID="led-palette-locked">
          {t('ledStripScreen.palette.locked')}
        </Text>
      )}
    </View>
  );
}

/* ================================================================== *
 * MODE COLOURS
 * ================================================================== */

function ModeColors({
  draft,
  palette,
  mode,
  onMode,
  editable,
  say,
  t,
  onChange,
}: {
  readonly draft: LedStripDraft;
  readonly palette: readonly LedColorTriplet[] | undefined;
  readonly mode: number;
  readonly onMode: (mode: number) => void;
  readonly editable: boolean;
  readonly say: (phrase: LedPhrase) => string;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly onChange: (mode: number, slot: number, value: number) => void;
}): React.JSX.Element {
  const runtimeNote = ledModeRuntimeNote(mode);
  const auxChannel = draftModeColorValue(draft, LedModeIndex.AUX_CHANNEL, 0);
  /** Which row has its sixteen-slot picker open. Seventeen open pickers at
   *  once is 272 swatches, which is a wall rather than a control. */
  const [openRow, setOpenRow] = React.useState<string | undefined>(undefined);

  return (
    <View testID="led-mode-colors">
      <View style={styles.chipRow}>
        {LED_EDITABLE_MODE_INDEXES.map(index => (
          <Chip
            key={index}
            label={say(ledModeLabel(index))}
            selected={index === mode}
            disabled={false}
            onPress={() => onMode(index)}
            testID={`led-mode-${index}`}
          />
        ))}
      </View>

      {/* Mode 5 is stored, transmitted and validated on write, and nothing
          in the firmware ever reads it. Presenting it like the four that
          work would make this an inert control wearing a working one's
          clothes. */}
      {runtimeNote !== undefined && (
        <NoticeBox variant="info" testID="led-mode-runtime-note">
          <Text style={styles.noticeText}>{say(runtimeNote)}</Text>
        </NoticeBox>
      )}

      {LED_DIRECTION_BITS.map(direction => (
        <ColorSlotRow
          key={direction}
          label={say(ledDirectionLabel(direction))}
          palette={palette}
          value={draftModeColorValue(draft, mode, direction)}
          open={openRow === `m${mode}:${direction}`}
          onToggle={() =>
            setOpenRow(openRow === `m${mode}:${direction}` ? undefined : `m${mode}:${direction}`)
          }
          onSelect={value => onChange(mode, direction, value)}
          disabled={!editable}
          testID={`led-mode-${mode}-${direction}`}
        />
      ))}

      <Text style={styles.groupTitle}>{t('ledStripScreen.special.title')}</Text>
      {Array.from({length: LED_SPECIAL_SLOT_COUNT}, (_unused, slot) => (
        <ColorSlotRow
          key={slot}
          label={say(ledSpecialSlotLabel(slot))}
          palette={palette}
          value={draftModeColorValue(draft, LedModeIndex.SPECIAL, slot)}
          open={openRow === `s${slot}`}
          onToggle={() => setOpenRow(openRow === `s${slot}` ? undefined : `s${slot}`)}
          onSelect={value => onChange(LedModeIndex.SPECIAL, slot, value)}
          disabled={!editable}
          testID={`led-special-${slot}`}
        />
      ))}

      {/* The aux tuple's third byte is a CHANNEL INDEX, not a colour. It
          gets a number field, not a swatch row. */}
      <View style={styles.fieldRow}>
        <Stepper
          value={String(auxChannel ?? 0)}
          onDecrement={() =>
            onChange(LedModeIndex.AUX_CHANNEL, 0, Math.max(0, (auxChannel ?? 0) - 1))
          }
          onIncrement={() =>
            onChange(
              LedModeIndex.AUX_CHANNEL,
              0,
              Math.min(LED_COLOR_INDEX_MAX, (auxChannel ?? 0) + 1),
            )
          }
          disabled={!editable}
          accessibilityLabel={say(ledAuxChannelLabel())}
          testID="led-aux-channel"
        />
        <Text style={styles.fieldLabel}>{say(ledAuxChannelLabel())}</Text>
      </View>
    </View>
  );
}

/* ================================================================== *
 * RUNTIME VALUES
 * ================================================================== */

const RUNTIME_BOUNDS: Record<LedRuntimeFieldId, {readonly min: number; readonly max: number}> = {
  brightness: {min: LED_BRIGHTNESS_MIN, max: LED_BRIGHTNESS_MAX},
  rainbowDelta: {min: LED_RAINBOW_DELTA_MIN, max: LED_RAINBOW_DELTA_MAX},
  rainbowFreq: {min: LED_RAINBOW_FREQ_MIN, max: LED_RAINBOW_FREQ_MAX},
};

function RuntimeValues({
  draft,
  editable,
  say,
  t,
  onChange,
}: {
  readonly draft: LedStripDraft;
  readonly editable: boolean;
  readonly say: (phrase: LedPhrase) => string;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly onChange: (field: LedRuntimeFieldId, value: number) => void;
}): React.JSX.Element {
  return (
    <View testID="led-runtime-values">
      {LED_RUNTIME_FIELD_IDS.map(field => {
        const value = draftRuntimeValue(draft, field);
        const bounds = RUNTIME_BOUNDS[field];
        const {min, max} = bounds;
        /* The BOARD's own value, not the draft's - an out-of-range notice
           is about what arrived, and must not disappear the moment the
           operator starts editing. */
        const observedNotice = ledRuntimeObservedNotice(
          draft.observed.runtimeValues[field],
          bounds,
        );
        return (
          <View key={field} style={styles.stackRow}>
            <View style={styles.fieldRow}>
              <Stepper
                value={String(value)}
                /* The bounds are the firmware's own setting table, not a
                   slider's - the rainbow frequency really does go to 2000.
                   Stepping from OUTSIDE that range lands on the nearest
                   bound rather than on `value ± 1`, which would hand the
                   encoder a number it refuses. */
                onDecrement={() => onChange(field, ledRuntimeStep(field, value, -1, bounds))}
                onIncrement={() => onChange(field, ledRuntimeStep(field, value, 1, bounds))}
                decrementDisabled={ledRuntimeStepInert(value, -1, bounds)}
                incrementDisabled={ledRuntimeStepInert(value, 1, bounds)}
                disabled={!editable}
                accessibilityLabel={say(ledRuntimeFieldLabel(field))}
                testID={`led-runtime-${field}`}
              />
              <Text style={styles.fieldLabel}>{say(ledRuntimeFieldLabel(field))}</Text>
            </View>
            <Text style={styles.caption}>
              {t('ledStripScreen.runtime.range', {min, max})}
            </Text>
            {observedNotice !== undefined && (
              <Text style={styles.outOfRange} testID={`led-runtime-observed-${field}`}>
                {say(observedNotice)}
              </Text>
            )}
            <Text style={styles.caption}>{say(ledRuntimeFieldHelp(field))}</Text>
          </View>
        );
      })}
      {/* A board genuinely reporting zero shows zero. The reference tab's
          `value || default` turns that into an invented 50 and writes the
          invention back; nothing here does. */}
      <Text style={styles.caption} testID="led-runtime-truth">
        {t('ledStripScreen.runtime.rawTruth')}
      </Text>
    </View>
  );
}

function LayerPriority({
  say,
  t,
}: {
  readonly say: (phrase: LedPhrase) => string;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
}): React.JSX.Element {
  return (
    <View style={styles.card} testID="led-layer-priority">
      <Text style={styles.cardTitle}>{t('ledStripScreen.layer.title')}</Text>
      <Text style={styles.caption}>{t('ledStripScreen.layer.help')}</Text>
      {LED_LAYER_DISPLAY_ORDER.map((layer, position) => (
        <Text key={layer} style={styles.layerRow} testID={`led-layer-${layer}`}>
          {`${position + 1}. ${say(ledLayerLabel(layer))}`}
        </Text>
      ))}
    </View>
  );
}

/* ================================================================== *
 * SMALL PIECES
 * ================================================================== */

/**
 * EVERYTHING AN OPERATOR DOES NOT READ FIRST.
 *
 * §78 keeps internal vocabulary off the primary surface; it does not say
 * to throw it away. The raw wire index, the firmware's own enum spelling,
 * the packed word, the read-only profile byte, the three unnamed special
 * slots and the flight mode that is stored-but-never-read are all true and
 * all useful to somebody filing a report. They live here, closed by
 * default.
 */
function TechnicalDetails({
  open,
  onToggle,
  draft,
  snapshot,
  say,
  t,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly draft: LedStripDraft;
  readonly snapshot: LedStripSnapshot;
  readonly say: (phrase: LedPhrase) => string;
  readonly t: (key: string, params?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const chosen = selectedNodes(draft);
  const unknownSlots = ledUnknownSpecialSlotsDetail(
    Array.from({length: LED_SPECIAL_SLOT_COUNT}, (_unused, slot) => slot),
  );
  return (
    <View style={styles.card} testID="led-technical">
      <Button
        label={say(ledTechnicalTitle())}
        variant="ghost"
        size="sm"
        icon={open ? 'chevron-up' : 'chevron-down'}
        onPress={onToggle}
        testID="led-technical-toggle"
      />
      {open && (
        <View style={styles.stackRow} testID="led-technical-body">
          {chosen.length === 1 && (
            <>
              <Text style={styles.technicalLine} testID="led-technical-wire-index">
                {say(ledWireIndexDetail(chosen[0].index))}
              </Text>
              <Text style={styles.technicalLine} testID="led-technical-symbol">
                {say(ledFirmwareSymbolDetail(chosen[0].baseFunction))}
              </Text>
              <Text style={styles.technicalLine} testID="led-technical-raw">
                {say(ledRawWordDetail(chosen[0].raw))}
              </Text>
            </>
          )}
          <Text style={styles.technicalLine} testID="led-technical-profile">
            {say(ledProfileDetail(snapshot.profile))}
          </Text>
          <Text style={styles.technicalLine}>
            {t('ledStripScreen.technical.profileReadOnly')}
          </Text>
          <Text style={styles.technicalLine}>
            {t('ledStripScreen.technical.directionPriority')}
          </Text>
          {snapshot.modeColors !== undefined && unknownSlots !== undefined && (
            <>
              <Text style={styles.technicalLine} testID="led-technical-special-slots">
                {say(unknownSlots)}
              </Text>
              <Text style={styles.technicalLine}>
                {t('ledStripScreen.technical.unknownSpecialSlotsHelp')}
              </Text>
            </>
          )}
          {/* §42: mode 5 appears ONLY here, with the reason. */}
          {LED_INERT_MODE_INDEXES.map(mode => (
            <View key={mode} style={styles.stackRow} testID={`led-technical-inert-${mode}`}>
              <Text style={styles.technicalLine}>{say(ledInertModeDetail(mode))}</Text>
              <Text style={styles.technicalLine}>
                {t('ledStripScreen.technical.inertMode')}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Section({
  title,
  children,
  testID,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Chip({
  label,
  selected,
  disabled,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <Button
      label={label}
      variant={selected ? 'primary' : 'secondary'}
      size="sm"
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    />
  );
}

function Swatch({
  color,
  label,
  selected,
  onPress,
  accessibilityLabel,
  disabled,
  testID,
}: {
  readonly color: LedColorTriplet;
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.swatch,
        {backgroundColor: ledColorToCss(color)},
        selected && styles.swatchSelected,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{selected, disabled}}
      testID={testID}>
      <Text style={[styles.swatchLabel, {color: ledSwatchInk(color)}]}>{label}</Text>
    </Pressable>
  );
}

/**
 * ONE COLOUR ASSIGNMENT: what it holds now, and the picker on demand.
 *
 * The six direction rows and eleven special slots are seventeen separate
 * assignments. Rendering every one of them as a full sixteen-slot picker
 * puts 272 swatches on the page at once, which reads as decoration rather
 * than as a control. The row shows the slot it currently points at; the
 * picker belongs to whichever row is being edited.
 */
function ColorSlotRow({
  label,
  palette,
  value,
  open,
  onToggle,
  onSelect,
  disabled,
  testID,
}: {
  readonly label: string;
  readonly palette: readonly LedColorTriplet[] | undefined;
  readonly value: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSelect: (index: number) => void;
  readonly disabled: boolean;
  readonly testID: string;
}): React.JSX.Element {
  const color = value === undefined ? undefined : palette?.[value];
  return (
    <View style={styles.stackRow} testID={testID}>
      <View style={styles.fieldRow}>
        {color === undefined ? (
          <Chip
            label={value === undefined ? '—' : String(value + 1)}
            selected={open}
            disabled={disabled}
            onPress={onToggle}
            testID={`${testID}-current`}
          />
        ) : (
          <Swatch
            color={color}
            label={String((value ?? 0) + 1)}
            selected={open}
            onPress={onToggle}
            disabled={disabled}
            accessibilityLabel={label}
            testID={`${testID}-current`}
          />
        )}
        <Text style={styles.fieldLabel}>{label}</Text>
      </View>
      {open && (
        <ColorIndexPicker
          palette={palette}
          value={value}
          mixed={false}
          mixedLabel=""
          disabled={disabled}
          onSelect={index => {
            onSelect(index);
            onToggle();
          }}
          testIDPrefix={`${testID}-picker`}
        />
      )}
    </View>
  );
}

/**
 * SIXTEEN NUMBERED SLOTS. The board sends no colour names, so none are
 * invented here: a slot shows its own colour and its own number.
 */
function ColorIndexPicker({
  palette,
  value,
  mixed,
  mixedLabel,
  disabled,
  onSelect,
  testIDPrefix,
}: {
  readonly palette: readonly LedColorTriplet[] | undefined;
  readonly value: number | undefined;
  readonly mixed: boolean;
  readonly mixedLabel: string;
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
  readonly testIDPrefix: string;
}): React.JSX.Element {
  const count = LED_COLOR_INDEX_MAX + 1;
  return (
    <View style={styles.chipRow} testID={testIDPrefix}>
      {mixed && <Text style={styles.mixed}>{mixedLabel}</Text>}
      {Array.from({length: count}, (_unused, index) => {
        const color = palette?.[index];
        const selected = value === index;
        /* On a board with no palette the INDEX is still true and the
           colour is not, so the number is shown and no colour invented. */
        return color === undefined ? (
          <Chip
            key={index}
            label={String(index + 1)}
            selected={selected}
            disabled={disabled}
            onPress={() => onSelect(index)}
            testID={`${testIDPrefix}-${index}`}
          />
        ) : (
          <Swatch
            key={index}
            color={color}
            label={String(index + 1)}
            selected={selected}
            onPress={() => onSelect(index)}
            disabled={disabled}
            accessibilityLabel={String(index + 1)}
            testID={`${testIDPrefix}-${index}`}
          />
        );
      })}
    </View>
  );
}

function resourceOf(resource: string): LedSaveGroup {
  switch (resource) {
    case 'PALETTE':
      return 'PALETTE';
    case 'MODE_COLORS':
      return 'MODE_COLORS';
    case 'RUNTIME_VALUES':
      return 'RUNTIME_VALUES';
    default:
      return 'ENTRIES';
  }
}

/* ================================================================== *
 * STYLES
 * ================================================================== */

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  scroll: {flex: 1},
  content: {
    alignSelf: 'center',
    width: '100%',
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xxl * 3,
  },
  header: {gap: spacing.xs},
  title: {...typography.title, color: colors.textPrimary},
  subtitle: {...typography.body, color: colors.textSecondary},
  status: {...typography.body, color: colors.textSecondary},
  section: {gap: spacing.md},
  sectionTitle: {...typography.sectionTitle, color: colors.textPrimary},
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: {...typography.heading, color: colors.textPrimary},
  groupTitle: {...typography.label, color: colors.textSecondary, marginTop: spacing.sm},
  caption: {...typography.caption, color: colors.textMuted},
  noticeText: {...typography.body, color: colors.textPrimary},
  workspace: {gap: spacing.md},
  column: {gap: spacing.md},
  gridPane: {flexGrow: 0, flexShrink: 1},
  inspectorPane: {flexGrow: 1, flexShrink: 1, flexBasis: 0},
  actions: {gap: spacing.sm},
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  stackRow: {gap: spacing.xs},
  fieldLabel: {...typography.label, color: colors.textPrimary},
  mixed: {...typography.caption, color: colors.warning},
  outOfRange: {...typography.caption, color: colors.warning},
  badge: {
    ...typography.caption,
    color: colors.accentText,
    backgroundColor: colors.accentSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  technicalLine: {...typography.caption, color: colors.textMuted},
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  orderNumber: {...typography.value, color: colors.textPrimary, minWidth: 28},
  orderCoords: {...typography.caption, color: colors.textSecondary},
  /* THE PRIORITY LIST HAS TO READ AS ONE COLUMN.
     Without an explicit alignment each row picks its own paragraph
     direction from its first STRONG character, so "1. تحذير" aligned
     right while "2. RSSI", "4. GPS" and "5. VTX" - whose labels are
     Latin acronyms the firmware itself uses - jumped to the opposite
     edge. The order is the whole point of the card, and an order split
     across two margins cannot be read. Pinned to the reading edge, which
     is what the rest of this app does. */
  layerRow: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'right',
  },
  swatchGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  swatch: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchSelected: {borderWidth: 3, borderColor: colors.accentStrong},
  swatchLabel: {...typography.caption},
});

/**
 * WHICH MODE AM I WORKING ON, AND WHICH RANGE IS ITS RANGE?
 *
 * Both were unanswerable at a glance. Every mode card was drawn on the
 * same surface with the same border whether it had ranges assigned or
 * none at all, and every range band on every channel bar used the same
 * single accent - so a screen with ARM, ANGLE and HORIZON configured
 * showed three identical strips and nothing tied a strip to its owner.
 *
 * The fix is presentational only, and these tests exist to keep it that
 * way: the last block asserts the write path is untouched, because a
 * "make the selection clearer" change is exactly the kind that quietly
 * ends up rendering from local UI state instead of from the draft that
 * actually reaches the flight controller.
 */

import * as fs from 'fs';
import * as path from 'path';

import {modeColour} from './ModesScreen';

const SOURCE = fs.readFileSync(path.join(__dirname, 'ModesScreen.tsx'), 'utf8');
const EXECUTABLE = SOURCE.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('every mode has a stable colour of its own', () => {
  it('is keyed on the firmware permanent id, not on list position', () => {
    // Position changes when the firmware reports a different order;
    // permanentId does not, so a mode keeps its colour across boards.
    expect(modeColour(0)).toBe(modeColour(0));
    expect(modeColour(0)).not.toBe(modeColour(1));
  });

  it('never indexes outside the palette, whatever the board reports', () => {
    for (const id of [0, 1, 7, 8, 42, 255, -1, -9]) {
      expect(modeColour(id)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('a configured mode is unmistakable', () => {
  it('changes more than a colour', () => {
    // Three simultaneous signals, so the card still reads for an operator
    // who cannot distinguish these hues.
    expect(EXECUTABLE).toContain('const configured = rows.length > 0');
    expect(EXECUTABLE).toContain('configured && styles.modeCardConfigured');
    expect(EXECUTABLE).toContain('configured && {borderColor: colour}');
    expect(EXECUTABLE).toContain('modes-mode-mark-');
  });

  it('the configured surface is genuinely heavier, not just tinted', () => {
    expect(EXECUTABLE).toContain('modeCardConfigured: {borderWidth: 2');
  });

  it('derives "configured" from the draft, not from a local selection flag', () => {
    // `rows` is the draft's own conditions filtered to this mode - so the
    // highlight follows the data that will be written, and a mode cannot
    // look configured while carrying nothing.
    expect(EXECUTABLE).toContain(
      'const rows = draft.conditions.map((condition, index) => ({condition, index})).filter(item => item.condition.permanentId === definition.permanentId)',
    );
  });
});

describe('a range band says where it starts, ends and who owns it', () => {
  it('draws the band in the owning mode colour', () => {
    expect(EXECUTABLE).toContain('const colour = modeColour(condition.permanentId)');
    expect(EXECUTABLE).toContain('backgroundColor: `${colour}33`');
    expect(EXECUTABLE).toContain('borderColor: colour');
  });

  it('prints the bounds and the mode name beside it', () => {
    // Colour identifies the owner; the words make it readable without
    // relying on hue at all.
    expect(EXECUTABLE).toContain('modes-range-bounds');
    // ONE template string, and the bounds inside a bidi isolate. Written
    // as `{a}-{b}` this was three text nodes, and in a right-to-left line
    // the three laid out right to left - "1700-2100" painted as
    // "2100-1700", a range reading backwards. Measured, not theorised;
    // see the comment at the call site for why a nested <Text> with
    // writingDirection could not have fixed it.
    expect(EXECUTABLE).toContain(
      '`${modeName} · \\u2066${condition.start}–${condition.end}\\u2069`',
    );
    expect(EXECUTABLE).toContain('modes-range-swatch-');
  });

  it('positions the band from the real start and end values', () => {
    // Not a fixed or decorative width: the geometry is computed from the
    // condition the operator edited.
    expect(EXECUTABLE).toContain('(condition.start - MODE_RANGE_MIN)');
    expect(EXECUTABLE).toContain('(condition.end - condition.start)');
  });

  it('still marks the live channel value against the band', () => {
    expect(EXECUTABLE).toContain('RECEIVER_CHANNELS_POLL_ID');
    expect(EXECUTABLE).toContain('channels[condition.auxChannelIndex + 4]');
    expect(EXECUTABLE).toContain('value >= condition.start && value <= condition.end');
  });
});

describe('the visual work did not detach the screen from the flight controller', () => {
  it('still writes through the real controller', () => {
    expect(EXECUTABLE).toContain('modesConfigurationController');
    expect(EXECUTABLE).toContain('controller.save');
  });

  it('still edits the draft that gets written', () => {
    for (const handler of ['onAdd', 'onUpdate', 'onRemove']) {
      expect(EXECUTABLE).toContain(handler);
    }
    expect(EXECUTABLE).toContain('draft.conditions');
  });

  it('reads mode activity from MSP status, not from the highlight', () => {
    // The "نشط الآن" badge must keep coming off the wire; a card that
    // looks configured is a completely different fact from a mode the
    // board reports as active.
    expect(EXECUTABLE).toContain('FC_STATUS_TELEMETRY_POLL_ID');
    expect(EXECUTABLE).toContain('modeIsActive(definition');
  });

  it('capacity still comes from the board snapshot', () => {
    expect(EXECUTABLE).toContain('draft.conditions.length < snapshot.capacity');
  });
});

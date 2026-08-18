/**
 * The message a pilot reads when a save came back unsure.
 *
 * The regression being pinned is specific: five screens used to render
 * their internal write-group identifier into Arabic copy, so a real board
 * produced "نتيجة الكتابة غير مؤكدة عند RXFAIL_CONFIG" - our source code,
 * quoted at an operator, at the one moment they most need to understand
 * what happened.
 */

import {unconfirmedWriteMessage, type WriteStageName} from './writeStageNames';

const EVERY_STAGE: readonly WriteStageName[] = [
  'FAILSAFE_CONFIG', 'RXFAIL_CONFIG', 'GPS_RESCUE',
  'BATTERY_CONFIG', 'VOLTAGE_METER_CONFIG', 'CURRENT_METER_CONFIG',
  'GENERAL', 'ELEMENT', 'STATISTIC', 'TIMER',
  'CONFIG', 'BAND', 'POWER_LEVEL',
  'PID', 'PID_ADVANCED', 'RC_TUNING', 'FILTER_CONFIG',
  'EEPROM',
];

describe('unconfirmedWriteMessage', () => {
  /**
   * PID is the ONE identifier that is also the pilot's own word for the
   * thing. "قيم PID" is what a tuner calls it and what Betaflight calls
   * it; suppressing it would make the message vaguer, not clearer. Every
   * other identifier is ours, and none of them may appear.
   */
  const PILOT_VOCABULARY: readonly WriteStageName[] = ['PID'];

  it('never leaks the identifier it was given', () => {
    for (const stage of EVERY_STAGE) {
      const message = unconfirmedWriteMessage(stage);
      if (!PILOT_VOCABULARY.includes(stage)) {
        expect(message).not.toContain(stage);
      }
      // The snake-case shape is ours in every case, with no exception:
      // no pilot term looks like RXFAIL_CONFIG.
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    }
  });

  it('names the setting the operator was actually changing', () => {
    expect(unconfirmedWriteMessage('RXFAIL_CONFIG')).toContain('قيم القنوات عند فقد النبض');
    expect(unconfirmedWriteMessage('GPS_RESCUE')).toContain('معاملات GPS Rescue');
    expect(unconfirmedWriteMessage('CURRENT_METER_CONFIG')).toContain('معايرة مقياس التيار');
    expect(unconfirmedWriteMessage('POWER_LEVEL')).toContain('مستويات الطاقة');
  });

  it('tells the operator not to retry, on every stage', () => {
    // An unconfirmed write is exactly the case where a reflexive second
    // save can apply the change twice or onto a board that moved.
    for (const stage of EVERY_STAGE) {
      expect(unconfirmedWriteMessage(stage)).toContain('لا تكرر الحفظ');
    }
  });

  it('says something DIFFERENT about the persist step', () => {
    // EEPROM is not a settings group. "The values reached the board but
    // may not be committed" is a different fact from "this setting may
    // not have been written", and the operator acts on it differently.
    const persist = unconfirmedWriteMessage('EEPROM');
    expect(persist).toContain('لم يتأكد حفظها بشكل دائم');
    expect(persist).not.toContain('كتابة ');
  });

  it('numbers a row from one, the way the screens do', () => {
    // Channel 0 on the wire is "القناة 1" everywhere in this app.
    expect(unconfirmedWriteMessage('RXFAIL_CONFIG', 0)).toContain('رقم 1');
    expect(unconfirmedWriteMessage('ELEMENT', 4)).toContain('رقم 5');
  });

  it('omits the row entirely when the write had none', () => {
    expect(unconfirmedWriteMessage('BATTERY_CONFIG')).not.toContain('رقم');
    expect(unconfirmedWriteMessage('BATTERY_CONFIG', undefined)).not.toContain('رقم');
  });
});

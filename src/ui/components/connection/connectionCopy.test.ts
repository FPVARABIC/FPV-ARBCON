import { connectionCopyKeys } from './connectionCopy';

describe('connectionCopyKeys', () => {
  it('uses browser chooser guidance on web', () => {
    expect(connectionCopyKeys('web')).toEqual({
      instructionPrimary: 'connection.instructionPrimaryWeb',
      emptySecondary: 'devices.emptySecondaryWeb',
    });
  });

  it('preserves the existing USB OTG guidance on Android', () => {
    expect(connectionCopyKeys('android')).toEqual({
      instructionPrimary: 'connection.instructionPrimary',
      emptySecondary: 'devices.emptySecondary',
    });
  });
});

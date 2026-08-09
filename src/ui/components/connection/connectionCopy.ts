export type ConnectionCopyKeys = {
  readonly instructionPrimary: string;
  readonly emptySecondary: string;
};

/**
 * Selects copy only; it never infers a transport capability. Web Serial has
 * an explicit browser device chooser, while Android genuinely needs USB OTG.
 * Keeping those instructions separate prevents either platform from telling
 * the operator to look for a control or cable mode that does not exist there.
 */
export function connectionCopyKeys(platform: string): ConnectionCopyKeys {
  return platform === 'web'
    ? {
        instructionPrimary: 'connection.instructionPrimaryWeb',
        emptySecondary: 'devices.emptySecondaryWeb',
      }
    : {
        instructionPrimary: 'connection.instructionPrimary',
        emptySecondary: 'devices.emptySecondary',
      };
}

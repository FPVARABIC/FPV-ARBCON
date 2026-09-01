/** The fixture has no flight controller. Ownership is reported ACTIVE so
 *  the screens render their content; nothing about layout is stubbed. */
export function useMspOwnershipState(): 'ACTIVE' {
  return 'ACTIVE';
}

export function useMspIdentificationState(): {status: 'IDLE'} {
  return {status: 'IDLE'};
}

export function useMspRecoveryState(): 'READY' {
  return 'READY';
}

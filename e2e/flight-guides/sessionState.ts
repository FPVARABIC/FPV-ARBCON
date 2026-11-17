/** Identified virtual session used only by the screenshot harness. */
const identity = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
} as const;
export function useMspOwnershipState(): 'ACTIVE' {return 'ACTIVE';}
export function useMspIdentificationState(): typeof identity {return identity;}
export function useMspRecoveryState(): 'READY' {return 'READY';}

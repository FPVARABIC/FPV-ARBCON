import type {FlightControllerIdentity} from '../msp/identification/mspIdentificationTypes';

/** A complete, inert Betaflight API-1.47 identity for unit-test ports. */
export function betaflightApi147Identity(): FlightControllerIdentity {
  return {
    apiVersion: {
      mspProtocolVersion: 0,
      apiVersionMajor: 1,
      apiVersionMinor: 47,
    },
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    board: {
      boardIdentifier: 'TEST',
      hardwareRevision: 0,
      boardType: 0,
      targetCapabilities: 0,
      targetName: 'TEST_TARGET',
      boardName: 'Test Board',
      manufacturerId: 'TEST',
      signature: new Uint8Array(32),
      mcuTypeId: 0,
      trailingBytes: new Uint8Array(0),
      truncated: false,
    },
  };
}

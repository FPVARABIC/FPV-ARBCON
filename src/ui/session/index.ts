/**
 * THE HARD CONNECTION WALL, and the connection that gets you past it.
 *
 * One question - is there a verified flight controller right now? - and
 * the application's whole shape hangs off the answer. See
 * verifiedConnection.ts for what "verified" means and App.tsx for what
 * it decides.
 *
 * There is deliberately NO connection screen in this barrel, because
 * there is no connection screen. Connecting is a service the Home screen
 * drives (useDirectConnect), not a place the application sends people.
 */
export {
  configurationWorkspaceUnlocked,
  resolveVerifiedConnection,
} from './verifiedConnection';
export type {
  CandidateSession,
  VerifiedConnection,
} from './verifiedConnection';
export {useVerifiedFcConnection} from './useVerifiedFcConnection';
export {useDirectConnect} from './useDirectConnect';
export type {DirectConnect} from './useDirectConnect';
export {
  connectOptionId,
  connectOptions,
  describeConnectOption,
  resolveConnectTarget,
} from './connectFlow';
export type {ConnectOption, ConnectPhase, ConnectTarget} from './connectFlow';
export {connectionNotice, useConnectionNotice} from './connectionNotice';
export type {ConnectionNotice} from './connectionNotice';
export {RebootOverlay} from './RebootOverlay';
export {useRebootReconnect} from './useRebootReconnect';
export {openBoard} from './openBoard';

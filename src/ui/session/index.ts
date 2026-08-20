/**
 * THE HARD CONNECTION WALL.
 *
 * One question - is there a verified flight controller right now? - and
 * the application's whole shape hangs off the answer. See
 * verifiedConnection.ts for what "verified" means and App.tsx for what
 * it decides.
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

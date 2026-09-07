/**
 * THE FIXTURE PREVIEW SERVER, AND HOW IT IS ACTUALLY STOPPED.
 *
 * Every browser gate serves the built fixture through `npx vite preview`.
 * That single command is a CHAIN of processes - `npx` execs a shell, which
 * runs `npm exec`, which runs another shell, which finally runs the `vite`
 * node process that owns the port. `child.kill()` signals only the first
 * link, so the node process at the end of the chain survives the gate that
 * started it, keeps its port, and accumulates: a later run then finds
 * several abandoned servers competing for the same box, which is a real
 * source of unrelated flake rather than a tidiness complaint.
 *
 * So the child is started as its own PROCESS-GROUP LEADER (`detached`), and
 * stopping it signals the NEGATED pid - the whole group, every link of the
 * chain - and then waits for the port to actually be released. No pattern
 * matching is involved anywhere: a `pkill -f "vite preview"` would match
 * any shell whose own command line contains that text, including the one
 * invoking it.
 */
import {spawn} from 'node:child_process';
import {connect} from 'node:net';

/** Starts the fixture preview server as its own process-group leader. */
export function startPreviewServer({port, strictPort = true, host}) {
  const args = [
    'vite',
    'preview',
    '--config',
    'e2e/touch-targets/vite.config.mts',
    '--port',
    String(port),
  ];
  if (strictPort) args.push('--strictPort');
  if (host !== undefined) args.push('--host', host);
  const child = spawn('npx', args, {stdio: 'ignore', detached: true});
  child.on('error', () => undefined);
  /* Remembered on the handle so the stopper needs no second argument and
     cannot be pointed at the wrong pid. */
  child.__previewPort = port;
  return child;
}

/** Resolves true while something still answers on the port. */
function portHeld(port) {
  return new Promise(resolve => {
    const socket = connect({host: '127.0.0.1', port}, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Terminates the server's whole process group and waits for the port to be
 * released. Returns the outcome so a caller can report it rather than
 * assume it: 'stopped', 'killed' (SIGTERM was not enough) or 'leaked'.
 */
export async function stopPreviewServer(child) {
  if (child === undefined || child.pid === undefined) return 'stopped';
  const port = child.__previewPort;
  const signalGroup = signal => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      /* The group is already gone, or was never created. */
      try {
        child.kill(signal);
      } catch {
        /* nothing left to signal */
      }
      return false;
    }
  };

  signalGroup('SIGTERM');
  for (let i = 0; i < 20; i += 1) {
    if (port === undefined || !(await portHeld(port))) return 'stopped';
    await wait(150);
  }
  signalGroup('SIGKILL');
  for (let i = 0; i < 20; i += 1) {
    if (port === undefined || !(await portHeld(port))) return 'killed';
    await wait(150);
  }
  return 'leaked';
}

/**
 * DIAGNOSTIC-ONLY JEST REPORTER. Not part of any normal run.
 *
 * WHY IT EXISTS. Run 30504226584 finished 96 suites / 2574 tests green in
 * 41.8 seconds, printed "Jest did not exit one second after the test run has
 * completed", and then sat on the runner until the Jest step's 10-minute
 * bound killed it. Locally the same tree exits cleanly in ~17 seconds with
 * the default 3 workers, and reproduces the message only intermittently
 * (roughly 1 run in 4) when forced to CI's topology - one worker, which
 * makes Jest run in-band. The one flag that can name a handle,
 * --detectOpenHandles, implies --runInBand AND adds enough async-hooks
 * overhead to hide the race: it has now returned a clean pass both in CI
 * (run 30496148622) and locally.
 *
 * WHAT THIS DOES INSTEAD. Nothing is injected into any test file - no
 * global hook, no wrapped timer, no afterEach. An earlier attempt used a
 * setupFilesAfterEnv hook and perturbed MspSessionCoordinator.test.ts into
 * failing on jest.getTimerCount(), which is exactly the kind of
 * measurement that changes what it measures. A reporter runs in the main
 * process, and with one worker that is the SAME process the tests ran in,
 * so async_hooks - which is process-wide and sees timers created inside the
 * test environment's vm context - can attribute every still-live timer to
 * the suite that created it.
 *
 * WHAT TO READ IN THE OUTPUT. `loopKeeping` comes from
 * process.getActiveResourcesInfo(), which lists ONLY resources currently
 * keeping the event loop alive - that is the set that can actually prevent
 * exit. `REF=` distinguishes the same thing per handle. Locally, the six
 * 50ms repeating intervals leaked by MspSessionCoordinator.test.ts all
 * report REF=false, because MspSessionCoordinator.ts:893 already calls
 * unrefIfSupported() on them - they are a real hygiene leak but cannot
 * block exit, and a report that only counted handles would have accused
 * them wrongly.
 *
 * Kept deliberately cheap: no stack capture, because that overhead is what
 * makes the race disappear.
 */

const async_hooks = require('async_hooks');
const fs = require('fs');

/** asyncId -> what it is and which suite created it. */
const live = new Map();
let currentPath = '<before-first-suite>';

const hook = async_hooks.createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    if (type !== 'Timeout' && type !== 'Immediate') {
      return;
    }
    let delay;
    let repeat;
    try {
      delay = resource && resource._idleTimeout;
      repeat = resource && resource._repeat;
    } catch {
      // A non-conforming resource must not break the run being measured.
    }
    live.set(asyncId, {type, delay, repeat, path: currentPath, resource});
  },
  destroy(asyncId) {
    live.delete(asyncId);
  },
});

function render(label) {
  const loopKeeping =
    typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo()
      : [];
  const counts = {};
  for (const resource of loopKeeping) {
    counts[resource] = (counts[resource] || 0) + 1;
  }
  const lines = [
    `[JEST-LEAK] ${label} live=${live.size} loopKeeping=${JSON.stringify(counts)}`,
  ];
  for (const [asyncId, entry] of live) {
    let ref = '?';
    try {
      ref =
        entry.resource && typeof entry.resource.hasRef === 'function'
          ? entry.resource.hasRef()
          : 'n/a';
    } catch {
      ref = 'threw';
    }
    lines.push(
      `[JEST-LEAK]   id=${asyncId} ${entry.type} delay=${entry.delay} ` +
        `repeat=${entry.repeat} REF=${ref} suite=${entry.path}`,
    );
  }
  return lines.join('\n');
}

function emit(text) {
  // Written to BOTH the log and a file. The log is what survives if the
  // artifact upload never runs, which is the likely case: the step is
  // expected to be killed by its own timeout while the process hangs.
  console.log(text);
  const out = process.env.JEST_LEAK_OUT;
  if (out) {
    try {
      fs.appendFileSync(out, `${text}\n`);
    } catch {
      // Never fail the run over diagnostics.
    }
  }
}

const wait = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

class JestLeakReporter {
  constructor() {
    hook.enable();
  }

  onTestFileStart(test) {
    currentPath = String(test.path).replace(`${process.cwd()}/`, '');
  }

  async onRunComplete() {
    // Sampled over time on purpose: a 2000ms request timer expires between
    // the first and second sample, while a repeating interval never does.
    // The shape of the decay is what separates the two.
    emit(render('AT_RUN_COMPLETE'));
    await wait(2500);
    emit(render('AT_PLUS_2500MS'));
    await wait(5000);
    emit(render('AT_PLUS_7500MS'));
    emit('[JEST-LEAK] sampling complete - anything listed above as REF=true is what is holding the process open');
  }
}

module.exports = JestLeakReporter;

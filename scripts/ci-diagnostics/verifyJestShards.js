#!/usr/bin/env node
/**
 * SHARD COMPLETENESS GATE.
 *
 * Android Validation no longer runs the tracked Jest suite in one process:
 * it runs it as N disjoint shards on N runners, because the monolithic step
 * stopped fitting its wall-clock budget on the hosted runners (measured -
 * the same step took 415s in the morning and could not finish in 1212s the
 * same afternoon, on the repaired commit AND on its parent alike).
 *
 * Sharding is only safe if it is LOSSLESS. The danger is not that a test
 * fails - a failing test still fails its shard - it is that a test quietly
 * stops being RUN AT ALL, and a green matrix then means nothing. That can
 * happen if the matrix indices and the `--shard=i/N` divisor drift apart,
 * or if a future Jest changes how `--shard` partitions.
 *
 * So this asks Jest itself, on the runner, for the file list of the whole
 * universe and of every shard, and fails the build unless:
 *
 *   union(shard 1..N) == universe   (nothing missing, nothing invented)
 *   every file appears exactly once (no shard runs another shard's file)
 *
 * It asserts on Jest's own answers rather than on a hard-coded file count,
 * so adding or deleting a test is not a false alarm - only losing one is.
 *
 * Dependency-free: node builtins and the repository's own Jest.
 * Usage: node scripts/ci-diagnostics/verifyJestShards.js <shardCount>
 */
'use strict';

const { execFileSync } = require('child_process');

const shardCount = Number.parseInt(process.argv[2], 10);
if (!Number.isInteger(shardCount) || shardCount < 1) {
  console.error(`verifyJestShards: expected a positive shard count, got "${process.argv[2]}"`);
  process.exit(1);
}

/** Jest's own answer for a path universe, one absolute file per line. */
function listTests(extraArgs) {
  const out = execFileSync(
    process.execPath,
    [require.resolve('jest-cli/bin/jest'), '--ci', '--listTests', ...extraArgs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .sort();
}

const universe = listTests([]);
const universeSet = new Set(universe);
if (universe.length !== universeSet.size) {
  console.error('verifyJestShards: the unsharded list itself contains duplicates');
  process.exit(1);
}

/* How many shards claim each file. Exactly one is the only correct answer. */
const claims = new Map();
const perShard = [];
for (let index = 1; index <= shardCount; index += 1) {
  const files = listTests([`--shard=${index}/${shardCount}`]);
  perShard.push(files.length);
  for (const file of files) {
    claims.set(file, (claims.get(file) ?? 0) + 1);
  }
}

const missing = universe.filter(file => !claims.has(file));
const duplicated = [...claims.entries()].filter(([, n]) => n > 1).map(([file]) => file);
const unexpected = [...claims.keys()].filter(file => !universeSet.has(file));

console.log(`shard completeness: ${shardCount} shards over ${universe.length} test files`);
perShard.forEach((count, i) => console.log(`  shard ${i + 1}/${shardCount}: ${count} files`));
console.log(`  sum of shard file counts : ${perShard.reduce((a, b) => a + b, 0)}`);
console.log(`  distinct files claimed   : ${claims.size}`);
console.log(`  missing                  : ${missing.length}`);
console.log(`  duplicated               : ${duplicated.length}`);
console.log(`  unexpected               : ${unexpected.length}`);

const show = (label, files) => {
  if (files.length === 0) return;
  console.error(`\n${label}:`);
  for (const file of files.slice(0, 50)) console.error(`  ${file}`);
  if (files.length > 50) console.error(`  ... and ${files.length - 50} more`);
};

if (missing.length > 0 || duplicated.length > 0 || unexpected.length > 0) {
  console.error('\nSHARDING IS NOT LOSSLESS - refusing to let the matrix stand in for the suite.');
  show('NEVER RUN BY ANY SHARD', missing);
  show('RUN BY MORE THAN ONE SHARD', duplicated);
  show('NOT IN THE UNSHARDED UNIVERSE', unexpected);
  process.exit(1);
}

console.log('\nOK - every test file is claimed by exactly one shard, and by all shards together.');

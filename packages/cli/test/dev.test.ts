import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devChildArgs } from '../src/cli.ts';

/**
 * T3 — `conti dev` runs `conti start` under Node's built-in `--watch`. This asserts the wiring decision
 * (watch flags + the start subcommand + this CLI as the watched entry) deterministically, without spawning
 * a long-running watched server. The spawn/signal/exit plumbing in runDev() is thin standard Node.
 */
test('conti dev runs the start command under node --watch', () => {
  const args = devChildArgs();
  assert.ok(args.includes('--watch'), 'uses node --watch (built-in; no custom watcher)');
  assert.equal(args.at(-1), 'start', 'the watched child runs the start subcommand');
  assert.ok(
    args.some((a) => a.endsWith('cli.ts')),
    'the watched entry is this CLI (its import graph is what --watch tracks)',
  );
});

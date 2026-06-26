import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Publish @conti/* to the LOCAL registry for `conti init` consumption — and crucially serve uWebSockets.js
 * as a TARBALL so a scaffolded project doesn't git-clone its 125 MB github repo on every `npm install`
 * (uWS isn't on npm; npm doesn't cache git deps). We pack the uWS already installed in the monorepo, publish
 * it locally, and publish @conti/core with its uWS dep rewritten github→exact-version (the monorepo source
 * keeps the github spec — restored in `finally`). The scaffold's .npmrc points its DEFAULT registry at
 * Verdaccio, so uWS + @conti/* come from the local registry and everything else proxies+caches npmjs.
 */

const REGISTRY = process.env.CONTI_REGISTRY ?? 'http://localhost:4873/';
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// 1) uWebSockets.js — pack the installed copy and publish it as a registry tarball.
const uwsDir = path.resolve('node_modules/uWebSockets.js');
const uwsVersion = JSON.parse(readFileSync(path.join(uwsDir, 'package.json'), 'utf8')).version;
console.log(`\n› uWebSockets.js@${uwsVersion}: pack + publish to ${REGISTRY}`);
const dest = mkdtempSync(path.join(tmpdir(), 'uws-pack-'));
const tgz = out(`npm pack "${uwsDir}" --pack-destination "${dest}"`).split('\n').pop();
try {
  execSync(`npm publish "${path.join(dest, tgz)}" --registry ${REGISTRY}`, { stdio: 'pipe' });
  console.log('  published');
} catch (e) {
  const msg = `${e.stderr ?? ''}${e.stdout ?? ''}`;
  // A re-run hitting the SAME version is fine (idempotent); anything else (e.g. 413 too-large) is fatal —
  // a missing uWS tarball would break every scaffold install, so fail loudly instead of swallowing it.
  if (/EPUBLISHCONFLICT|cannot publish over|already present|forbidden cannot modify pre-existing|\b409\b/i.test(msg)) {
    console.log(`  (uWebSockets.js@${uwsVersion} already in the registry — ok)`);
  } else {
    throw new Error(`uWebSockets.js publish FAILED (scaffold installs would break):\n${msg}`);
  }
}

// 2) Build + publish @conti/core and @conti/cli. Node won't type-strip TS under node_modules, so the
// PUBLISHED packages ship BUILT JS (dist via tsup) — the monorepo source keeps running TS directly (no-build
// dev). Each package.json is rewritten for npm consumers (exports/bin → dist; core's uWS dep → the tarball
// version above), published, then restored to its source form (github uWS, src exports/bin).
console.log('\n› building @conti/core + @conti/cli (tsup → dist)…');
sh('npm run build --workspace @conti/core --workspace @conti/cli');

const targets = [
  {
    pkg: '@conti/core',
    file: 'packages/api/package.json',
    rewrite: (p) => {
      p.dependencies['uWebSockets.js'] = uwsVersion;
      p.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
      p.types = './dist/index.d.ts';
      p.files = ['dist', 'admin'];
    },
  },
  {
    pkg: '@conti/cli',
    file: 'packages/cli/package.json',
    rewrite: (p) => {
      p.bin = { conti: './dist/cli.js' };
      p.files = ['dist'];
    },
  },
];

const backups = targets.map((t) => ({ ...t, orig: readFileSync(t.file, 'utf8') }));
try {
  for (const t of backups) {
    const p = JSON.parse(t.orig);
    t.rewrite(p);
    writeFileSync(t.file, `${JSON.stringify(p, null, 2)}\n`);
  }
  for (const t of backups) {
    const version = JSON.parse(t.orig).version;
    console.log(`\n› ${t.pkg}@${version}: (re)publish to ${REGISTRY}`);
    // Best-effort unpublish so a re-run REPLACES the same version (the registry grants unpublish for @conti/*).
    try {
      execSync(`npm unpublish ${t.pkg}@${version} --registry ${REGISTRY} --force`, { stdio: 'ignore' });
    } catch {
      /* not published yet — fine */
    }
    sh(`npm publish --workspace ${t.pkg}`); // publishConfig pins the registry
  }
} finally {
  for (const t of backups) writeFileSync(t.file, t.orig); // restore source for the monorepo
  console.log('\n✓ publish:local done — @conti/* (built JS) + uWebSockets.js are in the local registry.');
}

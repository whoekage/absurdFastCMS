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

// 2) @conti/core + @conti/cli — publish with the core's uWS dep rewritten to the exact version, so the
// PUBLISHED package resolves uWS from the tarball above (not github). Restore the source afterwards.
const corePath = 'packages/api/package.json';
const originalCore = readFileSync(corePath, 'utf8');
const core = JSON.parse(originalCore);
core.dependencies['uWebSockets.js'] = uwsVersion;
writeFileSync(corePath, `${JSON.stringify(core, null, 2)}\n`);

try {
  for (const [pkg, dir] of [['@conti/core', 'packages/api'], ['@conti/cli', 'packages/cli']]) {
    const version = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;
    console.log(`\n› ${pkg}@${version}: (re)publish to ${REGISTRY}`);
    // Best-effort unpublish so a re-run REPLACES the same version (the registry grants unpublish for @conti/*).
    try {
      execSync(`npm unpublish ${pkg}@${version} --registry ${REGISTRY} --force`, { stdio: 'ignore' });
    } catch {
      /* not published yet — fine */
    }
    sh(`npm publish --workspace ${pkg}`); // publishConfig pins the registry
  }
} finally {
  writeFileSync(corePath, originalCore); // restore the github uWS spec for the monorepo
  console.log('\n✓ publish:local done — @conti/* + uWebSockets.js are in the local registry.');
}

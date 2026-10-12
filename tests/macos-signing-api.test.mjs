// Dependency-contract unit test ONLY: subprocesses are intercepted, never signing real code.
// Real codesign/native/UI/Gatekeeper tests run separately in scripts/build.py on Macs.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {signingOptions} from '../scripts/sign-macos.mjs';

const source = process.env.DESKTOP_SIGNING_TEST_SOURCE;
assert(source, 'Point DESKTOP_SIGNING_TEST_SOURCE at the pinned npm-ci source tree');
const require = createRequire(path.join(source, 'apps/desktop/package.json'));
// osx-sign 2.x is ESM and exports sign(), not signAsync. Its execFileAsync
// binding is read-only; the call still goes through child_process.execFile.
const {sign} = require('@electron/osx-sign');

test('actual pinned signing API honors the exclusion callback before invoking codesign', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-sign-api-test-'));
  const desktop = path.join(base, 'apps/desktop');
  const app = path.join(base, 'Hermes.app');
  const resources = path.join(app, 'Contents/Resources');
  const unpacked = path.join(resources, 'app.asar.unpacked');
  fs.mkdirSync(desktop, {recursive: true});
  fs.mkdirSync(unpacked, {recursive: true});
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({build: {
    electronVersion: '40.10.2', mac: {entitlements: 'main.plist', entitlementsInherit: 'child.plist'},
  }}));
  const native = path.join(app, 'Contents/native');
  fs.writeFileSync(native, Buffer.from('cffaedfe00000000', 'hex'));
  const excluded = [path.join(resources, 'app.asar'), path.join(resources, 'icon.png'), path.join(unpacked, 'pty.node')];
  for (const file of excluded) fs.writeFileSync(file, Buffer.from('cffaedfe00000000', 'hex'));
  // app.asar/icon.png are arbitrary binary DATA rather than Mach-O in real builds.
  for (const file of excluded.slice(0, 2)) fs.writeFileSync(file, Buffer.from([0, 255, 128, 0]));
  const calls = [];
  const original = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    if (typeof options === 'function') callback = options;
    assert.equal(command, 'codesign', 'Unit test must never invoke external identity/security tools');
    calls.push(args);
    callback(null, '', '');
  };
  try {
    await sign(signingOptions(base, app));
    const signed = calls.filter(args => args.includes('--sign')).map(args => args.at(-1));
    assert.deepEqual(signed.sort(), [native, app].sort(), 'Only unhashed Mach-O and the final bundle may be signed');
    for (const file of excluded) assert(!signed.includes(file), 'Must not sign ' + file);
  } finally {
    childProcess.execFile = original;
    fs.rmSync(base, {recursive: true, force: true});
  }
});

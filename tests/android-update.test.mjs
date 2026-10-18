import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { npxScript, publishAndroidUpdate, updateOptions } from '../scripts/android-update.mjs';

async function fixture(t, contents = 'EXPO_TOKEN=private-expo\nCLOUDFLARE_API_TOKEN=private-cloudflare\nGOOGLE_CLIENT_SECRET=private-google\nEXPO_PUBLIC_TEST=must-not-export\n') {
  const root = await mkdtemp(resolve(tmpdir(), 'morse-update-'));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('morse-update-'));
    return rm(root, { recursive: true, force: true });
  });
  await writeFile(resolve(root, '.env'), contents);
  await mkdir(resolve(root, 'mobile/.credentials'), { recursive: true });
  await writeFile(resolve(root, 'mobile/.credentials/google-services.json'), JSON.stringify({
    client: [{ client_info: { android_client_info: { package_name: 'com.morsenepal' } } }],
  }));
  return root;
}

test('publishing prepares the bundled trainer first and keeps quoted messages in one shell-free argument', async t => {
  const root = await fixture(t);
  const calls = [];
  const message = 'Fix rapid taps & keep "every" mark $(do-not-run)';
  await publishAndroidUpdate(['production', message], {
    rootDirectory: root,
    inheritedEnvironment: { PATH: 'system-tools', EXPO_TOKEN: 'old-token', CLOUDFLARE_API_TOKEN: 'inherited-cloudflare',
      GOOGLE_CLIENT_SECRET: 'inherited-google', EXPO_PUBLIC_TEST: 'inherited-export', SYSTEMROOT: 'Windows' },
    findNpx: () => resolve(root, 'Node With Spaces/npx-cli.js'),
    run: async (...call) => { calls.push(call); },
  });
  assert.equal(calls.length, 2);
  const [prepare, publish] = calls;
  assert.equal(prepare[0], process.execPath);
  assert.deepEqual(prepare[1], [resolve(root, 'mobile/scripts/prepare-trainer.mjs')]);
  assert.equal(prepare[2].env.EXPO_TOKEN, undefined);
  assert.equal(publish[0], process.execPath);
  assert.deepEqual(publish[1], [resolve(root, 'Node With Spaces/npx-cli.js'), '--yes', 'eas-cli@24.12.1', 'update',
    '--platform', 'android', '--channel', 'production', '--environment', 'production', '--message', message, '--non-interactive']);
  assert.equal(publish[2].cwd, resolve(root, 'mobile'));
  assert.equal(publish[2].env.EXPO_TOKEN, 'private-expo');
  for (const call of calls) {
    assert.equal(call[2].env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(call[2].env.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(call[2].env.EXPO_PUBLIC_TEST, undefined);
    assert.equal(call[2].env.EXPO_NO_DOTENV, '1');
    assert.equal(call[2].env.PATH, 'system-tools');
  }
});

test('failed preparation prevents publishing an old trainer', async t => {
  const root = await fixture(t);
  let calls = 0;
  await assert.rejects(publishAndroidUpdate(['preview', 'Check audio'], {
    rootDirectory: root, inheritedEnvironment: {}, findNpx: () => 'npx-cli.js',
    run: async () => { calls += 1; throw new Error('Preparation failed'); },
  }), /Preparation failed/);
  assert.equal(calls, 1);
});

test('missing credentials and invalid destinations fail before any export or publication', async t => {
  const root = await fixture(t, 'CLOUDFLARE_API_TOKEN=not-an-expo-token\n');
  let calls = 0;
  await assert.rejects(publishAndroidUpdate(['preview', 'Check audio'], {
    rootDirectory: root, inheritedEnvironment: {}, run: async () => { calls += 1; },
  }), /Add EXPO_TOKEN/);
  assert.equal(calls, 0);
  for (const args of [[], ['production'], ['development', 'Fix'], ['preview', ' '], ['production', 'Unquoted', 'message']]) {
    assert.throws(() => updateOptions(args), /Usage:/);
  }
});

test('Windows-compatible npm lookup returns the JS entrypoint even when Node lives in a path with spaces', async t => {
  const root = await fixture(t);
  const node = resolve(root, 'Program Files/Node/node.exe');
  const runner = resolve(dirname(node), 'node_modules/npm/bin/npx-cli.js');
  await mkdir(dirname(runner), { recursive: true });
  await writeFile(runner, '// npm entrypoint');
  assert.equal(npxScript({}, node), runner);
});

test('missing, unreadable, malformed and wrong-app Firebase configurations prevent export and publication', async t => {
  const root = await fixture(t);
  const file = resolve(root, 'mobile/.credentials/google-services.json');
  await rm(file);
  let calls = 0;
  const options = { rootDirectory: root, inheritedEnvironment: {}, findNpx: () => 'npx-cli.js',
    run: async () => { calls += 1; } };
  await assert.rejects(publishAndroidUpdate(['preview', 'Check audio'], options), /Restore the Firebase Android configuration/);
  for (const contents of ['{invalid json', JSON.stringify({ client: [{ client_info: { android_client_info: { package_name: 'another.app' } } }] })]) {
    await writeFile(file, contents);
    await assert.rejects(publishAndroidUpdate(['preview', 'Check audio'], options), /Restore the Firebase Android configuration/);
  }
  await assert.rejects(publishAndroidUpdate(['preview', 'Check audio'], { ...options,
    inheritedEnvironment: { GOOGLE_SERVICES_JSON: resolve(root, 'mobile/.credentials') },
  }), /Restore the Firebase Android configuration/);
  assert.equal(calls, 0);
});

test('a readable Firebase file supplied by the terminal can replace the ignored local configuration', async t => {
  const root = await fixture(t);
  const local = resolve(root, 'mobile/.credentials/google-services.json');
  const external = resolve(root, 'firebase-config.json');
  await writeFile(external, await readFile(local));
  await rm(local);
  const calls = [];
  await publishAndroidUpdate(['preview', 'Check provisioned config'], {
    rootDirectory: root, inheritedEnvironment: { GOOGLE_SERVICES_JSON: external }, findNpx: () => 'npx-cli.js',
    run: async (...call) => { calls.push(call); },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2].env.GOOGLE_SERVICES_JSON, external);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  'index.html', 'app.js', 'audio.js', 'audio-settings.js', 'trainer.js', 'learn-session.js', 'learning-progress.js',
  'replay.js', 'styles.css', 'chat.js', 'chat-codec.js', 'chat.css',
  'mobile-shell.js', 'mobile-practice-session.js', 'timed-morse.js', 'press-controls.js',
  'practice.css', 'practice-round-session.js', 'qwerty-keyboard.js', 'real-word-bank.js',
  'privacy.html', 'terms.html', 'delete-account.html', 'delete-account.js', 'google-signin-light.png', 'google-signin-dark.png',
];

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'morse-release-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await Promise.all([
    cp(join(root, 'scripts'), join(folder, 'scripts'), { recursive: true }),
    ...sources.map((name) => cp(join(root, name), join(folder, name))),
  ]);
  return folder;
}

async function build(folder) {
  await run(process.execPath, ['scripts/build.mjs'], { cwd: folder });
  return JSON.parse(await readFile(join(folder, 'public', 'asset-manifest.json'), 'utf8'));
}

const dependencies = (body) => [...body.matchAll(
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.\/[^'"]+)\1/g,
)].map((match) => match[2].slice(2));

const entryAssets = (html) => [...html.matchAll(/\b(?:src|href)\s*=\s*['"]([^'"]+\.(?:js|css))['"]/g)]
  .map((match) => match[1]);

async function loadGraph(folder, cache = new Map()) {
  const html = await readFile(join(folder, 'public', 'index.html'), 'utf8');
  const requested = new Set();
  async function load(name) {
    if (requested.has(name)) return;
    requested.add(name);
    if (!cache.has(name)) cache.set(name, await readFile(join(folder, 'public', name), 'utf8'));
    if (name.endsWith('.js')) await Promise.all(dependencies(cache.get(name)).map(load));
  }
  await Promise.all(entryAssets(html).map(load));
  return { requested, cache, html };
}

test('built pages use one complete versioned module graph and correct final HTML CSP', async (t) => {
  const folder = await fixture(t);
  // Exercise a dynamic import as well as the application's static imports.
  await writeFile(join(folder, 'audio.js'), `${await readFile(join(folder, 'audio.js'), 'utf8')}\nexport const loadTrainer = () => import('./trainer.js');\n`);
  const manifest = await build(folder);
  const { requested } = await loadGraph(folder);
  assert.match(manifest.release, /^[a-f0-9]{20}$/);
  assert.ok(requested.size > 10, 'the application graph was traversed');
  for (const [canonical, versioned] of Object.entries(manifest.assets)) {
    assert.ok(versioned.includes(`.${manifest.release}.`));
    const canonicalBody = await readFile(join(folder, 'public', canonical));
    const versionedBody = await readFile(join(folder, 'public', versioned));
    assert.deepEqual(canonicalBody, versionedBody);
    if (canonical.endsWith('.js')) {
      for (const dependency of dependencies(versionedBody.toString())) {
        assert.ok(Object.values(manifest.assets).includes(dependency), `${canonical} imports a versioned public dependency`);
      }
    }
  }
  for (const name of requested) assert.ok(Object.values(manifest.assets).includes(name));
  const headers = await readFile(join(folder, 'public', '_headers'), 'utf8');
  for (const page of ['index.html', 'privacy.html', 'terms.html']) {
    const html = await readFile(join(folder, 'public', page), 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (!/\bsrc\s*=/i.test(match[1])) {
        const digest = createHash('sha256').update(match[2]).digest('base64');
        assert.ok(headers.includes(`'sha256-${digest}'`), `${page} inline script is covered by final HTML CSP`);
      }
    }
  }
  assert.ok(headers.includes('/app.js\n  Cache-Control: no-cache, max-age=0, must-revalidate'));
  assert.ok(headers.includes(`/${manifest.assets['app.js']}\n  Cache-Control: public, max-age=31536000, immutable`));
  const names = await readdir(join(folder, 'public'));
  assert.ok(!names.includes('package.json') && !names.includes('.env'));
});

test('a warm browser cache receives fresh code after any public source changes', async (t) => {
  const folder = await fixture(t);
  const first = await build(folder);
  const warm = await loadGraph(folder);
  const oldUrls = new Set(warm.requested);
  // A CSS-only deployment must also invalidate cached application imports.
  await writeFile(join(folder, 'practice.css'), `${await readFile(join(folder, 'practice.css'), 'utf8')}\n/* next release */\n`);
  const next = await build(folder);
  assert.notEqual(next.release, first.release);
  const current = await loadGraph(folder, warm.cache);
  for (const name of current.requested) {
    assert.ok(!oldUrls.has(name), `new HTML and module imports avoid old cached URL ${name}`);
    assert.equal(current.cache.get(name), await readFile(join(folder, 'public', name), 'utf8'));
  }
});

test('release identity is stable across repeat builds and Windows line endings', async (t) => {
  const folder = await fixture(t);
  const first = await build(folder);
  const repeated = await build(folder);
  assert.deepEqual(repeated, first);
  for (const name of sources.filter((name) => /\.(?:js|html|css)$/.test(name))) {
    const text = (await readFile(join(folder, name), 'utf8')).replace(/\r\n?/g, '\n');
    await writeFile(join(folder, name), text.replace(/\n/g, '\r\n'));
  }
  assert.deepEqual(await build(folder), first);
});

test('an incomplete or invalid source graph preserves the previous successful build', async (t) => {
  const folder = await fixture(t);
  const previous = await build(folder);
  const before = await readFile(join(folder, 'public', 'index.html'));
  await writeFile(join(folder, 'app.js'), "import './private-settings.js';\n");
  await assert.rejects(build(folder), /Module import is not a public JavaScript asset/);
  assert.deepEqual(await readFile(join(folder, 'public', 'index.html')), before);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'public', 'asset-manifest.json'), 'utf8')), previous);
  await rm(join(folder, 'audio.js'));
  await assert.rejects(build(folder), /ENOENT/);
  assert.deepEqual(await readFile(join(folder, 'public', 'index.html')), before);
});

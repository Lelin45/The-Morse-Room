import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public');
const publicFiles = [
  'index.html', 'app.js', 'audio.js', 'trainer.js', 'learn-session.js',
  'replay.js', 'styles.css', 'chat.js', 'chat-codec.js', 'chat.css',
  'mobile-shell.js', 'mobile-practice-session.js', 'timed-morse.js',
  'privacy.html', 'terms.html',
  'google-signin-light.png', 'google-signin-dark.png',
];

// Read the entire allowlist before replacing an existing successful build.
const files = await Promise.all(publicFiles.map(async (name) => {
  const path = resolve(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular public source file: ${name}`);
  }
  return { name, body: await readFile(path) };
}));

// Refuse a redirected output directory before removing stale public assets.
if (relative(root, output) !== 'public') throw new Error('Unexpected public output path.');
let existing;
try { existing = await lstat(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error('The public output must be a normal directory inside this project.');
  }
  const actual = await realpath(output);
  const actualRoot = await realpath(root);
  if (relative(actualRoot, actual) !== 'public' || !actual.startsWith(actualRoot + sep)) {
    throw new Error('Refusing to replace public output outside this project.');
  }
  await rm(output, { recursive: true });
}
await mkdir(output);
await Promise.all(files.map(({ name, body }) => writeFile(resolve(output, name), body)));

const inlineScripts = [...new Set(files.filter(({ name }) => name.endsWith('.html'))
  .flatMap(({ body }) => [...body.toString('utf8')
    .matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)])
  .filter((match) => !/\bsrc\s*=/i.test(match[1]))
  .map((match) => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`))];
const policy = [
  "default-src 'self'",
  `script-src 'self' ${inlineScripts.join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

await writeFile(resolve(output, '_routes.json'), JSON.stringify({
  version: 1,
  include: ['/api/*'],
  exclude: [],
}, null, 2) + '\n');
await writeFile(resolve(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${policy}
`);

console.log(`Built ${publicFiles.length} public assets and Pages routing/security headers in public/.`);

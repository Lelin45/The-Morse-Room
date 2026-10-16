import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public');
const publicFiles = [
  'index.html', 'app.js', 'audio.js', 'audio-settings.js', 'trainer.js', 'learn-session.js', 'learning-progress.js',
  'replay.js', 'styles.css', 'chat.js', 'chat-codec.js', 'chat.css',
  'mobile-shell.js', 'mobile-practice-session.js', 'timed-morse.js',
  'practice.css', 'practice-round-session.js', 'qwerty-keyboard.js', 'real-word-bank.js',
  'privacy.html', 'terms.html', 'delete-account.html', 'delete-account.js',
  'google-signin-light.png', 'google-signin-dark.png',
];
const textFile = (name) => /\.(?:html|js|css)$/.test(name);

// Read the entire allowlist before replacing an existing successful build.
const files = await Promise.all(publicFiles.map(async (name) => {
  const path = resolve(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Expected a regular public source file: ${name}`);
  }
  const source = await readFile(path);
  const body = textFile(name)
    ? Buffer.from(source.toString('utf8').replace(/\r\n?/g, '\n'))
    : source;
  return { name, body };
}));

// A release gets new entry URLs and a new complete module graph. An older
// browser cache therefore cannot combine newly deployed HTML with old code.
const releaseHash = createHash('sha256');
releaseHash.update('morse-public-release-v1\0');
for (const { name, body } of files) {
  releaseHash.update(name).update('\0').update(String(body.length)).update('\0').update(body);
}
const release = releaseHash.digest('hex').slice(0, 20);
const versioned = Object.fromEntries(files
  .filter(({ name }) => /\.(?:js|css)$/.test(name))
  .map(({ name }) => [name, name.replace(/\.(js|css)$/, `.${release}.$1`)]));
const publicNames = new Set(publicFiles);

function rewriteModule(body) {
  return body.toString('utf8').replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.\/[^'"]+)\2/g,
    (match, prefix, quote, specifier) => {
      const name = specifier.slice(2);
      if (!publicNames.has(name) || !name.endsWith('.js') || !versioned[name]) {
        throw new Error(`Module import is not a public JavaScript asset: ${specifier}`);
      }
      return `${prefix}${quote}./${versioned[name]}${quote}`;
    },
  );
}

function rewriteHtml(body) {
  return body.toString('utf8').replace(
    /(\b(?:src|href)\s*=\s*)(['"])([^'"]+)\2/g,
    (match, prefix, quote, url) => {
      const name = url.replace(/^\.\//, '');
      return versioned[name] ? `${prefix}${quote}${versioned[name]}${quote}` : match;
    },
  );
}

// Finish all transformations before replacing an existing successful build.
const builtFiles = files.flatMap(({ name, body }) => {
  const transformed = name.endsWith('.js') ? rewriteModule(body)
    : name.endsWith('.html') ? rewriteHtml(body) : body;
  return versioned[name]
    ? [{ name, body: transformed }, { name: versioned[name], body: transformed }]
    : [{ name, body: transformed }];
});

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
await Promise.all(builtFiles.map(({ name, body }) => writeFile(resolve(output, name), body)));

const inlineScripts = [...new Set(builtFiles.filter(({ name }) => name.endsWith('.html'))
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
${['/', '/index.html', '/privacy.html', '/privacy', '/terms.html', '/terms', '/delete-account.html', '/delete-account', '/asset-manifest.json', ...Object.keys(versioned).map((name) => `/${name}`)]
  .map((url) => `${url}\n  Cache-Control: no-cache, max-age=0, must-revalidate`).join('\n')}
${Object.values(versioned).map((name) => `/${name}\n  Cache-Control: public, max-age=31536000, immutable`).join('\n')}
`);
await writeFile(resolve(output, 'asset-manifest.json'), JSON.stringify({ release, assets: versioned }, null, 2) + '\n');

console.log(`Built ${publicFiles.length} public sources with release ${release} and Pages routing/security headers in public/.`);

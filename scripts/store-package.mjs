import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from '../mobile/node_modules/sharp/lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = join(root, 'store-listing');
const entries = [];
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const labels = {
  phone: 'Phone screenshots',
  'tablet-7': '7-inch tablet screenshots',
  'tablet-10': '10-inch tablet screenshots',
};

for (const [name, maxCharacters] of Object.entries({
  'app-name': 30, 'short-description': 80, 'full-description': 4000,
})) {
  const file = `${name}.txt`;
  const buffer = await readFile(join(folder, file));
  const text = buffer.toString('utf8').trim();
  const characters = [...text].length;
  assert.ok(characters > 0 && characters <= maxCharacters, `${file}: invalid text length`);
  assert.ok(!text.includes('\u2014'), `${file}: no em dashes`);
  entries.push({ file, characters, maxCharacters, bytes: buffer.length, sha256: sha256(buffer) });
}

async function imageEntry(file, expected) {
  const buffer = await readFile(join(folder, file));
  const image = sharp(buffer);
  const metadata = await image.metadata();
  assert.equal(metadata.format, 'png', `${file}: expected PNG`);
  assert.equal(metadata.bitsPerSample, 8, `${file}: expected 8-bit channels`);
  assert.ok(!metadata.isPalette, `${file}: expected RGB image`);
  assert.ok(buffer.length <= expected.maxBytes, `${file}: image is too large`);
  assert.ok(metadata.width >= expected.minSide && metadata.height >= expected.minSide, `${file}: dimensions are too small`);
  assert.ok(metadata.width <= expected.maxSide && metadata.height <= expected.maxSide, `${file}: dimensions are too large`);
  if (expected.width) assert.equal(metadata.width, expected.width, `${file}: width`);
  if (expected.height) assert.equal(metadata.height, expected.height, `${file}: height`);
  if (expected.channels) assert.equal(metadata.channels, expected.channels, `${file}: channel count`);
  if (expected.screen) {
    assert.equal(metadata.hasAlpha, false, `${file}: screenshots must have no alpha channel`);
    const portrait = metadata.width * 16 === metadata.height * 9;
    const landscape = metadata.width * 9 === metadata.height * 16;
    assert.ok(portrait || landscape, `${file}: expected 9:16 or 16:9`);
  }
  entries.push({ file, width: metadata.width, height: metadata.height,
    format: metadata.format, channels: metadata.channels, hasAlpha: metadata.hasAlpha,
    colourSpace: metadata.space, bytes: buffer.length, sha256: sha256(buffer) });
}

await imageEntry('icon.png', { width: 512, height: 512, minSide: 512, maxSide: 512, channels: 4, maxBytes: 1024 ** 2 });
await imageEntry('feature-graphic.png', { width: 1024, height: 500, minSide: 500, maxSide: 1024, channels: 3, maxBytes: 15 * 1024 ** 2 });

const captureManifest = JSON.parse(await readFile(join(folder, 'screenshots', 'capture-manifest.json'), 'utf8'));
assert.equal(captureManifest.application, 'com.morsenepal');
assert.equal(captureManifest.trainerRevision, '5770ec9da03a00723edf', 'Screenshots must use the corrected trainer');
if (captureManifest.source.startsWith('Android release APK')) {
  assert.equal(captureManifest.versionCode, 4, 'Native captures must use the corrected Android release');
} else {
  assert.ok(captureManifest.source.includes('bundled Android WebView HTML rendered in isolated Chrome'), 'Capture source must be explicit');
  assert.equal(captureManifest.interfaceEdits, false);
  assert.equal(captureManifest.pixelContentEdits, false);
}
for (const [device, label] of Object.entries(labels)) {
  const files = (await readdir(join(folder, 'screenshots', device))).filter(name => name.endsWith('.png')).sort();
  assert.ok(files.length >= 4 && files.length <= 8, `${label}: provide 4 to 8 screenshots`);
  for (const name of files) {
    const file = `screenshots/${device}/${name}`;
    const capture = captureManifest.captures.find(entry => entry.file === `${device}/${name}`);
    assert.ok(capture, `${file}: capture provenance is required`);
    await imageEntry(file, { minSide: 1080, maxSide: device === 'tablet-10' ? 7680 : 3840,
      maxBytes: 8 * 1024 ** 2, screen: true });
    const entry = entries.at(-1);
    assert.equal(entry.sha256, capture.sha256, `${file}: capture hash`);
    Object.assign(entry, { theme: capture.theme, description: capture.description });
  }
}

const videoFiles = (await readdir(join(folder, 'video'))).filter(name => /\.mp4$/i.test(name));
assert.ok(videoFiles.length > 0, 'Optional preview video file has not been generated');
for (const file of videoFiles) {
  const path = `video/${file}`;
  const buffer = await readFile(join(folder, path));
  assert.ok(buffer.includes(Buffer.from('ftyp')), `${file}: expected MP4 container`);
  entries.push({ file: path, format: 'mp4', bytes: (await stat(join(folder, path))).size, sha256: sha256(buffer) });
}

const manifest = {
  appName: 'Morse Code Nepal', applicationIdentifier: 'com.morsenepal',
  verifiedAt: new Date().toISOString(), captureSource: captureManifest.source,
  files: entries,
  policies: {
    privacy: 'https://learnmorse.lelinadhikari.com.np/privacy.html',
    terms: 'https://learnmorse.lelinadhikari.com.np/terms.html',
    accountDeletion: 'https://learnmorse.lelinadhikari.com.np/delete-account.html',
  },
};
await writeFile(join(folder, 'asset-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const imageDescriptions = entries.filter(entry => entry.width).map(entry => {
  const description = entry.description ?? (entry.file === 'icon.png'
    ? 'Morse Code Nepal icon with a green dit and dah on a dark background.'
    : 'Morse Code Nepal: guided lessons, sending and receiving practice, and Morse chat.');
  assert.ok([...description].length <= 140, `${entry.file}: alt text must be concise`);
  return `${entry.file}\n${description}\n`;
}).join('\n');
await writeFile(join(folder, 'image-descriptions.txt'), imageDescriptions);
console.log(JSON.stringify({ ready: true, captureSource: manifest.captureSource,
  text: entries.filter(entry => entry.characters).map(({ file, characters, maxCharacters }) => ({ file, characters, maxCharacters })),
  images: entries.filter(entry => entry.width).length, videos: videoFiles.length }, null, 2));

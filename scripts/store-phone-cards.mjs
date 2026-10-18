import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from '../mobile/node_modules/sharp/lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = join(root, 'store-listing');
const output = join(store, 'screenshots', 'phone-framed');
const cards = JSON.parse(await readFile(join(store, 'sources', 'phone-cards.json'), 'utf8'));
const captures = JSON.parse(await readFile(join(store, 'screenshots', 'capture-manifest.json'), 'utf8'));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const screen = { left: 117, top: 367, width: 846, height: 1504, radius: 45 };
assert.equal(screen.width * 16, screen.height * 9);
await mkdir(output, { recursive: true });
const manifest = { application: 'com.morsenepal', source: captures.source,
  composition: 'Existing app-content screenshots scaled proportionally inside a generic Android phone frame, with feature captions.',
  deviceFrame: true, screenshotContentEdits: false, width: 1080, height: 1920, cards: [] };

function artwork(card) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs>
      <radialGradient id="field" cx="50%" cy="66%" r="60%"><stop stop-color="#102f20"/><stop offset="1" stop-color="#05110b"/></radialGradient>
      <linearGradient id="metal" x1="0" x2="1"><stop stop-color="#4e5c53"/><stop offset=".18" stop-color="#222d26"/><stop offset=".8" stop-color="#26342b"/><stop offset="1" stop-color="#66776b"/></linearGradient>
    </defs>
    <rect width="1080" height="1920" fill="url(#field)"/>
    <g fill="none" stroke="#244a33" opacity=".45"><circle cx="540" cy="1150" r="625"/><circle cx="540" cy="1150" r="680" stroke-dasharray="2 16"/></g>
    <circle cx="79" cy="61" r="8" fill="#34f58c"/><rect x="97" y="53" width="32" height="16" rx="8" fill="#34f58c"/>
    <text x="147" y="69" fill="#b1cbbd" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="500" letter-spacing=".4">Morse Room: Learn &amp; Chat</text>
    <text x="998" y="69" text-anchor="end" fill="#527b61" font-family="Consolas, monospace" font-size="22">${card.number} / 08</text>
    <g font-family="Segoe UI, Arial, sans-serif" font-size="78" font-weight="700" letter-spacing="-2">
      <text x="70" y="167" fill="#effff4">${escape(card.heading[0])}</text>
      <text x="70" y="250" fill="#34f58c">${escape(card.heading[1])}</text>
    </g>
    <text x="73" y="298" fill="#afc9ba" font-family="Segoe UI, Arial, sans-serif" font-size="30">${escape(card.caption)}</text>
    <rect x="83" y="363" width="914" height="1544" rx="92" fill="#000" opacity=".22"/>
    <rect x="93" y="526" width="7" height="78" rx="3.5" fill="#65786b"/>
    <rect x="93" y="627" width="7" height="113" rx="3.5" fill="#65786b"/>
    <rect x="980" y="612" width="7" height="133" rx="3.5" fill="#65786b"/>
    <rect x="98" y="323" width="884" height="1572" rx="67" fill="url(#metal)"/>
    <rect x="102" y="327" width="876" height="1564" rx="63" fill="#101813" stroke="#748b7b" stroke-opacity=".35"/>
    <rect x="113" y="363" width="854" height="1512" rx="49" fill="#000"/>
    <circle cx="540" cy="345" r="8" fill="#000" stroke="#43564a" stroke-width="2"/>
    <circle cx="542" cy="343" r="2.5" fill="#344b3c"/>
  </svg>`);
}

const mask = Buffer.from(`<svg width="${screen.width}" height="${screen.height}"><rect width="100%" height="100%" rx="${screen.radius}" fill="white"/></svg>`);
for (const card of cards) {
  const source = `phone/${card.source}`;
  const original = await readFile(join(store, 'screenshots', source));
  const capture = captures.captures.find(entry => entry.file === source);
  assert.ok(capture, `Missing capture: ${source}`);
  assert.equal(sha256(original), capture.sha256, `Original screenshot changed: ${source}`);
  const image = await sharp(original).resize(screen.width, screen.height, { fit: 'fill' })
    .ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const file = `${card.number}-${card.slug}.png`;
  await sharp(artwork(card)).composite([{ input: image, left: screen.left, top: screen.top }])
    .removeAlpha().toColourspace('srgb').withIccProfile('srgb')
    .png({ compressionLevel: 9, palette: false }).toFile(join(output, file));
  const buffer = await readFile(join(output, file));
  const info = await sharp(buffer).metadata();
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(info.channels, 3);
  assert.equal(info.hasAlpha, false);
  assert.ok(buffer.length < 8 * 1024 ** 2);
  manifest.cards.push({ file, heading: card.heading.join(' '), caption: card.caption,
    source, sourceSha256: sha256(original), sha256: sha256(buffer), bytes: buffer.length,
    description: card.description });
}
await writeFile(join(output, 'composition-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await mkdir(join(root, '.verification'), { recursive: true });
const thumbnails = await Promise.all(manifest.cards.map(async (card, index) => ({
  input: await sharp(join(output, card.file)).resize(270, 480).toBuffer(),
  left: (index % 4) * 270, top: Math.floor(index / 4) * 480,
})));
await sharp({ create: { width: 1080, height: 960, channels: 3, background: '#05110b' } })
  .composite(thumbnails).png().toFile(join(root, '.verification', 'framed-phone-contact.png'));
console.log(JSON.stringify({ cards: manifest.cards.length, dimensions: '1080 x 1920',
  originalScreenshotsVerified: true, bytes: manifest.cards.map(card => card.bytes) }, null, 2));

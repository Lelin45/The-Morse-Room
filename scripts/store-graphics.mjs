import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from '../mobile/node_modules/sharp/lib/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
  { name: 'icon', width: 512, height: 512, channels: 4, maxBytes: 1024 * 1024 },
  { name: 'feature-graphic', width: 1024, height: 500, channels: 3, maxBytes: 15 * 1024 * 1024 },
];

for (const asset of assets) {
  const sourcePath = path.join(root, 'store-listing', 'sources', `${asset.name}.svg`);
  const outputPath = path.join(root, 'store-listing', `${asset.name}.png`);
  const pipeline = sharp(await fs.readFile(sourcePath), { density: 72 })
    .resize(asset.width, asset.height)
    .toColourspace('srgb');
  if (asset.channels === 4) pipeline.ensureAlpha();
  else pipeline.removeAlpha();
  await pipeline
    .withIccProfile('srgb')
    .png({ compressionLevel: 9, palette: false })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  const { size } = await fs.stat(outputPath);
  if (metadata.width !== asset.width || metadata.height !== asset.height ||
      metadata.channels !== asset.channels || metadata.bitsPerSample !== 8 ||
      metadata.space !== 'srgb' || metadata.isPalette || size > asset.maxBytes) {
    throw new Error(`Invalid store asset: ${asset.name}`);
  }
  console.log(JSON.stringify({ file: path.relative(root, outputPath), width: metadata.width,
    height: metadata.height, channels: metadata.channels, bitsPerSample: metadata.bitsPerSample,
    space: metadata.space, hasProfile: metadata.hasProfile, size }, null, 2));
}

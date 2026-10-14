import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ||
    (existsSync(join(__dirname, '.credentials/google-services.json')) ? './.credentials/google-services.json' : undefined);
  if (process.env.EAS_BUILD === 'true' && !googleServicesFile) {
    throw new Error('Set the GOOGLE_SERVICES_JSON file variable before building Android notifications.');
  }
  return {
    ...config,
    name: config.name || 'Morse Code Nepal',
    slug: config.slug || 'the-morse-room',
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
  };
};

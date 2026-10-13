import { defineConfig } from 'eslint/config';
import expo from 'eslint-config-expo/flat.js';

export default defineConfig([expo, {
  ignores: ['generated/**', 'dist/**', 'android/**', 'ios/**', 'scripts/**', 'src/web-bridge.js'],
}]);

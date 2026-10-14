const { withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');

// Expo's template uses a default rules file that disables code optimization.
// Apply this during prebuild so the same settings reach every EAS release.
module.exports = function withAndroidReleaseOptimization(config) {
  config = withAppBuildGradle(config, (result) => {
    const original = /getDefaultProguardFile\(\s*(["'])proguard-android\.txt\1\s*\)/g;
    result.modResults.contents = result.modResults.contents.replace(
      original, 'getDefaultProguardFile("proguard-android-optimize.txt")',
    );
    if (!/getDefaultProguardFile\(\s*(["'])proguard-android-optimize\.txt\1\s*\)/.test(result.modResults.contents)) {
      throw new Error('The Android template changed. Check the release ProGuard defaults before building.');
    }
    return result;
  });

  return withGradleProperties(config, (result) => {
    const enabled = ['android.enableR8.fullMode', 'android.r8.optimizedResourceShrinking'];
    result.modResults = result.modResults.filter((entry) => !enabled.includes(entry.key));
    for (const key of enabled) result.modResults.push({ type: 'property', key, value: 'true' });
    return result;
  });
};

const { withAppBuildGradle, withProjectBuildGradle, withGradleProperties } = require('expo/config-plugins');

// Expo's template uses a default rules file that disables code optimization.
// Apply this during prebuild so the same settings reach every EAS release.
module.exports = function withAndroidReleaseOptimization(config) {
  config = withProjectBuildGradle(config, (result) => {
    // This patch release fixes optimization-statistics reporting in AGP 8.12's R8.
    const dependency = 'classpath("com.android.tools:r8:8.12.22")';
    if (!result.modResults.contents.includes(dependency)) {
      const anchor = /classpath\(\s*(["'])com\.android\.tools\.build:gradle\1\s*\)/;
      if (!anchor.test(result.modResults.contents)) throw new Error('Check the Android build classpath before updating R8.');
      result.modResults.contents = result.modResults.contents.replace(anchor, (match) => `${match}\n        ${dependency}`);
    }
    return result;
  });
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

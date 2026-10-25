const { withAndroidManifest, withGradleProperties, withProjectBuildGradle, withSettingsGradle } = require('@expo/config-plugins');

const AUDIO_PROJECT = "include ':expo-audio-local'\nproject(':expo-audio-local').projectDir = new File(rootDir, '../node_modules/expo-audio/android')";
const AUDIO_SUBSTITUTION = `

allprojects {
  configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
      substitute module('expo.modules.audio:expo.modules.audio') using project(':expo-audio-local')
    }
  }
}`;

// Keep local release builds focused on the production device target. The architecture
// can still be overridden for emulator/debug work with -PreactNativeArchitectures=....
const RELEASE_OPTIMIZATION_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  'android.enableBundleCompression': 'true',
  'reactNativeArchitectures': 'arm64-v8a',
  'expo.useLegacyPackaging': 'true'
};

module.exports = function withPatchedExpoAudio(config) {
  config = withAndroidManifest(config, (modConfig) => {
    const permissions = modConfig.modResults.manifest['uses-permission'] ?? [];
    if (!permissions.some((permission) => permission.$?.['android:name'] === 'android.permission.POST_NOTIFICATIONS')) {
      permissions.push({ $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } });
    }
    modConfig.modResults.manifest['uses-permission'] = permissions;
    return modConfig;
  });

  config = withGradleProperties(config, (modConfig) => {
    for (const [key, value] of Object.entries(RELEASE_OPTIMIZATION_PROPERTIES)) {
      const property = modConfig.modResults.find((item) => item.type === 'property' && item.key === key);
      if (property) property.value = value;
      else modConfig.modResults.push({ type: 'property', key, value });
    }
    return modConfig;
  });

  config = withSettingsGradle(config, (modConfig) => {
    if (!modConfig.modResults.contents.includes("include ':expo-audio-local'")) {
      modConfig.modResults.contents = modConfig.modResults.contents.replace(
        "include ':app'",
        `include ':app'\n${AUDIO_PROJECT}`
      );
    }
    return modConfig;
  });

  return withProjectBuildGradle(config, (modConfig) => {
    if (!modConfig.modResults.contents.includes("allprojects {\n  configurations.configureEach")) {
      modConfig.modResults.contents += AUDIO_SUBSTITUTION;
    }
    return modConfig;
  });
};

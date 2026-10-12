const { withProjectBuildGradle, withSettingsGradle } = require('@expo/config-plugins');

const AUDIO_PROJECT = "include ':expo-audio-local'\nproject(':expo-audio-local').projectDir = new File(rootDir, '../node_modules/expo-audio/android')";
const AUDIO_SUBSTITUTION = `

allprojects {
  configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
      substitute module('expo.modules.audio:expo.modules.audio') using project(':expo-audio-local')
    }
  }
}`;

module.exports = function withPatchedExpoAudio(config) {
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

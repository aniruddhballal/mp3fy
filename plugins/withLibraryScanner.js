const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withLibraryScanner(config) {
  config = withMainApplication(config, (modConfig) => {
    const marker = 'add(LibraryScannerPackage())';
    if (!modConfig.modResults.contents.includes(marker)) {
      modConfig.modResults.contents = modConfig.modResults.contents.replace(
        'PackageList(this).packages.apply {',
        `PackageList(this).packages.apply {\n          ${marker}`
      );
    }
    return modConfig;
  });
  return withDangerousMod(config, ['android', async (modConfig) => {
    const destination = path.join(modConfig.modRequest.platformProjectRoot, 'app/src/main/java/com/anonymous/mp3fy/LibraryScannerModule.kt');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'native/LibraryScannerModule.kt'), destination);
    return modConfig;
  }]);
};

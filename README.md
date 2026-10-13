# mp3fy

`mp3fy` is an Android-only, read-only local MP3 player. The user selects folders from phone or SD-card storage, and `mp3fy` scans those folders for existing `.mp3` files and plays them locally.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. It does not modify the user's files.

## Current status

The current playable build includes Android folder selection, recursive MP3 discovery, persistent selected folders, search, local playback, seeking, previous/next controls, shuffle, sequential order, repeat-folder, repeat-one, embedded album artwork, ID3 title/artist/album/track metadata, background controls, and loading feedback during startup and folder operations. Playback queues always stay within the folder where the track was selected.

The current Android release is version `1.4.13` (`versionCode` `28`). APK files keep the stable build filename `app-release.apk`; release identity is maintained internally in `app.json`.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. `mp3fy` remembers access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app recursively scans the selected directories and displays the MP3 files it finds.
6. Tapping a track starts local playback.
7. Playback can shuffle or follow filename order within the current folder, repeat the folder or current track, seek within a track, and move backward or forward through the queue.

Embedded album artwork in supported MP3 ID3 tags is extracted to the app cache and shown in the player and media controls when available. When present, the full-screen player uses the embedded ID3 title and contributing artist as its primary text, with album and track number shown as compact secondary metadata. Filename-derived title and artist text are used when tags are unavailable.

Folder artwork can be supplied by placing an image directly inside each selected folder. `folder.jpg`, `folder.jpeg`, `folder.png`, or `folder.webp` is preferred; common names such as `cover`, `artwork`, `albumart`, `album-art`, `thumbnail`, and `image` are also recognized. If no preferred name exists, the first supported image in the folder is used.

The app should support four or five selected folders and more. If selected folders overlap, the interface should avoid presenting the same file as a confusing duplicate.

## Scope boundaries

- Read, display, and play existing `.mp3` files only.
- Do not download, rip, convert, move, rename, delete, or copy audio files.
- Do not identify songs from audio.
- Do not request unrestricted access to the entire device when user-selected folder access is sufficient.
- Preserve the user's existing files and folder structure.

## Technology

- Expo
- React Native
- TypeScript
- Android Storage Access Framework
- `expo-file-system`
- `expo-audio`

## Getting started

### Prerequisites

For a complete Android build, install the following before cloning/building:

- Node.js `20.19.4+`, `22.13.0+`, or `24.3.0+` (use a supported LTS release).
- Java Development Kit (JDK) 17, with `JAVA_HOME` set to the JDK installation.
- Android Studio with the Android SDK, SDK Platform `36`, Android SDK Build-Tools `36.0.0`, and NDK `27.1.12297006` installed through **Tools > SDK Manager**.
- An Android emulator or a USB-debugging-enabled Android device if you want to install or launch the APK locally.

Make sure `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) points to the Android SDK directory. On Windows, it is commonly `%LOCALAPPDATA%\\Android\\Sdk`.

### Install and build the release APK

From a fresh clone, run these commands from the repository root:

```bash
git clone <repository-url>
cd mp3fy
npm ci
npx expo prebuild --platform android
```

`npm ci` uses the committed `package-lock.json` and runs the `patch-package` post-install step required by this project. Do not use `--ignore-scripts`.

The `android/` directory is generated and ignored by Git, so `npx expo prebuild --platform android` is required after cloning. It applies the Expo configuration and the local `expo-audio` plugin before Gradle builds the app.

Build the release APK with Gradle:

```bash
# Windows PowerShell
cd android
.\\gradlew.bat assembleRelease

# macOS/Linux (use this instead of the Windows commands)
cd android
./gradlew assembleRelease
```

The APK will be created at:

```text
android/app/build/outputs/apk/release/app-release.apk
```

The local release build uses the generated debug keystore, so it is suitable for local testing and installation, not Play Store distribution. For an attached device or running emulator, this command builds and installs the release variant in one step:

```bash
npx expo run:android --variant release
```

To install the generated APK manually with Android Debug Bridge (ADB):

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

### Development build

The app requires a custom native Android build for the folder picker, storage scanning, and background playback configuration. Expo Go alone is not sufficient for the complete app.

```bash
npm start
npx expo run:android
```

The first `npx expo run:android` also generates the native Android project when it is missing.

## Privacy and storage access

The app uses Android's user-controlled folder picker so the user chooses exactly which directories `mp3fy` can read. It scans only those selected directory trees, plays only local files, and remains read-only by default.

## Official reference

- [Android Storage Access Framework: access documents and other files](https://developer.android.com/training/data-storage/shared/documents-files)

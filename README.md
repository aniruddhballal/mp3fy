# mp3fy

`mp3fy` is an Android-only, read-only local MP3 player. The user selects folders from phone or SD-card storage, and `mp3fy` scans those folders for existing `.mp3` files and plays them locally.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. It does not modify the user's files.

## Current status

The current source includes Android folder selection, recursive MP3 discovery, persistent selected folders, search, local playback, seeking, previous/next controls, folder filename order, song title order, shuffle, repeat-folder, repeat-one, an editable playing queue, embedded album artwork, ID3 title/artist/album/track metadata, on-demand LRCLIB lyrics with time-synced display, background controls, and loading feedback during folder operations. It restores the last song, folder, playback position, and queue after reopening, showing the folders home screen with the mini player at the bottom, ready to continue when the user presses Play. Playback queues always stay within the folder where the track was selected. mp3fy Wrapped shows listening time and top artists and songs for a day, week, month, year, or all time.

The folder list, folder artwork locations, and discovered track list are saved in app storage. On later launches, the saved library appears as soon as it is read; a scan then refreshes it for files added or removed since the last launch. Adding or removing a folder also updates the saved library. The first launch after upgrading from an older build still needs one full scan to create this snapshot.

Songs in a folder are listed alphabetically by title. Each row shows the title first and the artist beneath it, using the same filename fallback and available ID3 metadata as the player. Search matches titles, artists, and filenames. The chosen playback order is independent of the song list's display order.

## Source layout

Application code lives under `src/`; the repository root contains project configuration, documentation, assets, tests, and the checked-in APK. Feature logic is grouped under `src/features`, reusable services under `src/services`, screens under `src/screens`, shared UI under `src/components`, and shared domain types under `src/types`.

## Playback order

Starting a song from a folder selects **A-Z**, which follows MP3 filename order within that folder. For filenames such as `Artist - Song.mp3`, this groups songs by artist and sorts the artists alphabetically. Tap the order control to cycle through **A-Z → a-z → shuffle → A-Z**. **a-z** sorts by the displayed song title, using ID3 titles already loaded by the player and filename-derived titles otherwise, regardless of the artist prefix. Shuffle randomizes the remaining songs in that folder. When at least two other songs are available, returning to shuffle avoids repeating the previous upcoming order, even after switching modes or reopening the app. Restoring an existing playback session preserves its selected mode; previously saved sequential playback is restored as **a-z**.

## Playing queue

Open **Queue** from the home screen, a folder's song list, or the full player whenever a song is loaded. Closing Queue returns to the screen it was opened from. Queue shows the current song at the top and the upcoming songs in playback order. The current song has animated playing bars. Drag a queued song by its handle to change the order, or remove it with the X button. The current song stays in place and keeps playing while the rest of the native playlist is updated. When repeat-folder is on, songs that would play after the playlist wraps appear at the end of the queue. Manual queue changes are saved with playback state and restored after reopening.

**Clear Queue** asks for confirmation. Confirming leaves only the current song in the playlist and switches to repeat-one. Removing the last upcoming song has the same repeat-one result. If repeat-one is already active while other songs remain queued, the current song continues repeating until repeat-one is turned off.

## Lyrics

The full-screen player has a **LYRICS** action beside the current song title. Lyrics are fetched from LRCLIB only after the user taps it, and only for the current track. Synced LRC lines follow playback time and scroll automatically; plain lyrics, instrumental tracks, missing results, and network failures each have a dedicated fallback state. Lyrics are not fetched for queued or background tracks.

The current Android release is version `1.6.7` (`versionCode` `52`). APK files keep the stable build filename `app-release.apk`; release identity is maintained internally in `app.json`. A copy of the verified optimized release is checked in at the project root as `mp3fy.apk`.

## mp3fy Wrapped

Wrapped records actual listening time while a track advances. A play counts once a listening session reaches 30 seconds, matching Spotify's published song-stream threshold. Paused time and jumps from seeking are excluded. Tracking starts with version 1.5.0; earlier listening cannot be recovered retroactively.

Each song is identified by a SHA-256 hash of its normalized MP3 filename, so copies with the same filename in different folders contribute to one Wrapped history. File URIs are still used to play the selected copy. Existing URI-based Wrapped histories are merged by filename when the database is upgraded. Renaming a file creates a new song identity. Artist and title come from ID3 tags when available, with filename-derived metadata as a fallback. Wrapped stores and credits the lead artist before `/`, `;`, or a `feat.`/`ft.`/`featuring` suffix. The player still shows the full credit from the MP3 tag. Existing Wrapped histories are corrected when upgraded. Wrapped displays the top five artists by listening time and the top five songs by counted plays for today, this week, this month, the selected calendar year, and all time. Day, week, and month show only the current period. Past calendar years remain browsable forever. Each annual report also shows that year's longest listening day and biggest month.

Stats are stored locally in SQLite as per-track totals rather than a growing log of every playback event. Per-track day, week, and month rankings are kept only for their current periods. Per-track yearly and all-time totals remain available. One small total per day and month is retained for annual milestones. This keeps storage growth linear with distinct tracks and years, and does not modify MP3 files.

Wrapped requires one backup folder before the app can be used. It keeps a single `mp3fy-wrapped.json` in that folder; the file survives uninstalling the app. On a fresh install, select the same folder and mp3fy automatically imports the existing JSON before playback can begin. New listening is then written back to that same file automatically, within about a minute and when the app goes to the background. A first-time folder remains empty until Wrapped history is recorded. The internal SQLite database is the live working store while the app is installed; the required JSON is its portable reinstall backup.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. `mp3fy` remembers access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app recursively scans the selected directories and displays the MP3 files it finds.
6. Tapping a track starts local playback.
7. Playback can follow filename order, song title order, or shuffle within the current folder; repeat the folder or current track; seek within a track; and move backward or forward through the queue.

Embedded album artwork in supported MP3 ID3 tags is extracted to the app cache and shown in the player and media controls when available. When present, the full-screen player uses the embedded ID3 title and contributing artist as its primary text, with album and track number shown as compact secondary metadata. Filename-derived title and artist text are used when tags are unavailable.

Folder artwork can be supplied by placing an image directly inside each selected folder. `folder.jpg`, `folder.jpeg`, `folder.png`, or `folder.webp` is preferred; common names such as `cover`, `artwork`, `albumart`, `album-art`, `thumbnail`, and `image` are also recognized. If no preferred name exists, the first supported image in the folder is used.

The app supports four or five selected folders and more. If selected folders overlap, the interface avoids presenting the same file as a confusing duplicate.

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

Release builds enable Hermes/R8 resource shrinking, bundle compression, compressed native-library packaging, and the `arm64-v8a` production ABI by default to keep the APK small. To build for an emulator or another ABI, override the architecture property, for example `./gradlew assembleRelease -PreactNativeArchitectures=x86_64`.

The local release build uses the generated debug keystore, so it is suitable for local testing and installation, not Play Store distribution. For an attached device or running emulator, this command builds and installs the release variant in one step:

```bash
npx expo run:android --variant release
```

To install the generated APK manually with Android Debug Bridge (ADB):

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

To install the checked-in root APK instead:

```bash
adb install -r mp3fy.apk
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
- [LRCLIB API documentation](https://lrclib.net/docs)

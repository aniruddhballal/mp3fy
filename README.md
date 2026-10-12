# mp3fy

`mp3fy` is an Android-only, read-only local MP3 player. The user selects folders from phone or SD-card storage, and `mp3fy` scans those folders for existing `.mp3` files and plays them locally.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. It does not modify the user's files.

## Current status

The current playable build includes Android folder selection, recursive MP3 discovery, persistent selected folders, search, local playback, seeking, previous/next controls, shuffle, sequential order, repeat-folder, repeat-one, embedded album artwork, background controls, and loading feedback during startup and folder operations. Playback queues always stay within the folder where the track was selected.

The current Android release is version `1.3.8` (`versionCode` `13`). APK files keep the stable build filename `app-release.apk`; release identity is maintained internally in `app.json`.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. `mp3fy` remembers access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app recursively scans the selected directories and displays the MP3 files it finds.
6. Tapping a track starts local playback.
7. Playback can shuffle or follow filename order within the current folder, repeat the folder or current track, seek within a track, and move backward or forward through the queue.

Embedded album artwork in supported MP3 ID3 tags is extracted to the app cache and shown in the player and media controls when available.

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

Install dependencies and start the Expo development server:

```bash
npm install
npm start
```

The app requires a custom native Android build for the folder picker, storage scanning, and background playback configuration. Expo Go alone is not sufficient for the complete app.

## Privacy and storage access

The app uses Android's user-controlled folder picker so the user chooses exactly which directories `mp3fy` can read. It scans only those selected directory trees, plays only local files, and remains read-only by default.

## Official reference

- [Android Storage Access Framework: access documents and other files](https://developer.android.com/training/data-storage/shared/documents-files)

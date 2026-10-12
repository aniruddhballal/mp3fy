# mp3fy

`mp3fy` is an Android-only mobile application for finding and playing MP3 files that already exist in folders selected by the user.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. Its purpose is to provide a focused, read-only player for the user's existing MP3 collection across selected phone and SD-card storage locations.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. The app stores access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app scans the selected directory trees and displays the MP3 files it finds.
6. The user taps a track to play it locally.
7. The user can seek, pause, resume, skip, go back, shuffle, play in filename order, repeat one track, and choose a queue covering the current folder or all selected folders.

The app should support multiple selected folders, including four or five folders and more. If the same file is reachable through overlapping selected folders, the interface should avoid showing confusing duplicates.

## Scope boundaries

- Read, display, and play existing `.mp3` files only.
- Do not download, rip, convert, move, rename, delete, or copy audio files.
- Do not identify songs from audio.
- Do not require access to the entire device; use Android's user-selected folder access.
- Preserve the user's existing files and folder structure.

## Initial principles

- Android-only, mobile-first experience
- User-controlled storage access
- Fast, searchable, readable MP3 listing and basic local playback
- Clear handling of missing, duplicate, or inaccessible files
- No background scanning unless the user explicitly starts it
- Privacy-conscious and read-only by default

## Known technical direction

Android's Storage Access Framework lets the user select a directory and grant access to the files and subdirectories inside it. `expo-file-system` provides the directory picker and recursive access, while `expo-audio` provides local playback and background media controls. The app requires a custom Android build for this native configuration.

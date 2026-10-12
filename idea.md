# mp3fy

`mp3fy` will be an Android-only mobile application for finding and displaying MP3 files that already exist in folders selected by the user.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. Its purpose is to provide a focused view of the user's existing MP3 collection across selected phone and SD-card storage locations.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. The app stores access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app scans the selected directory trees and displays the MP3 files it finds.

The app should support multiple selected folders, including four or five folders and more. If the same file is reachable through overlapping selected folders, the interface should avoid showing confusing duplicates.

## Scope boundaries

- Read and display existing `.mp3` files only.
- Do not download, stream, rip, convert, move, rename, delete, or copy audio files.
- Do not identify songs from audio.
- Do not require access to the entire device; use Android's user-selected folder access.
- Preserve the user's existing files and folder structure.

## Initial principles

- Android-only, mobile-first experience
- User-controlled storage access
- Fast, searchable, readable MP3 listing
- Clear handling of missing, duplicate, or inaccessible files
- No background scanning unless the user explicitly starts it
- Privacy-conscious and read-only by default

## Known technical direction

Android's Storage Access Framework can let the user select a directory and grant access to the files and subdirectories inside it. Multiple folder selections can be supported by repeating that user-driven selection flow. The current Expo scaffold will need a native Android module or custom development build to integrate this storage access and recursive scanning behavior.

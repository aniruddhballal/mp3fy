# mp3fy

`mp3fy` is an Android-only mobile application for finding and displaying MP3 files that already exist in folders selected by the user.

The app will not download music, create MP3 files, identify songs, or access storage without the user's explicit folder selection. It is intended to provide a focused view of an existing MP3 collection across selected phone and SD-card storage locations.

## Current status

The project is currently at the foundation stage. This repository contains only the initial Expo mobile-app scaffold. The folder picker, storage scanning, MP3 listing, and search experience have not been implemented yet.

## Planned workflow

1. The user taps **Add folder**.
2. Android's system folder picker asks the user to choose a directory.
3. `mp3fy` remembers access to that selected directory.
4. The user can add additional directories from internal storage or an SD card.
5. The app recursively scans the selected directories and displays the MP3 files it finds.

The app should support four or five selected folders and more. If selected folders overlap, the interface should avoid presenting the same file as a confusing duplicate.

## Scope boundaries

- Read and display existing `.mp3` files only.
- Do not download, stream, rip, convert, move, rename, delete, or copy audio files.
- Do not identify songs from audio.
- Do not request unrestricted access to the entire device when user-selected folder access is sufficient.
- Preserve the user's existing files and folder structure.

## Technology

- Expo
- React Native
- TypeScript
- Android Storage Access Framework (planned)
- Native Android module or custom Expo development build (planned)

## Getting started

Install dependencies and start the Expo development server:

```bash
npm install
npm start
```

The scaffold can be opened on an Android emulator or Android device. The folder-picker and storage-scanning features will require a custom native development build; Expo Go alone will not provide the required native integration.

## Privacy and storage access

The app should use Android's user-controlled folder picker so the user chooses exactly which directories `mp3fy` can read. The app should scan only those selected directory trees and remain read-only by default.

## Official reference

- [Android Storage Access Framework: access documents and other files](https://developer.android.com/training/data-storage/shared/documents-files)

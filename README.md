# mp3fy

`mp3fy` is an Android-only mobile application concept for identifying music that is currently playing on the device, through a simple workflow inspired by Shazam.

The intended result is the exact matched song information—at minimum the title and artist, with additional metadata where available. Any MP3 conversion workflow remains a separate product decision and is not being implemented yet.

The project is currently at the foundation stage. No recognition, audio capture, conversion, download, upload, or playback functionality has been implemented.

## Current status

This repository contains only the initial Expo mobile-app scaffold. The app is intended for Android devices only.

## Planned song recognition

The planned flow is:

1. The user taps **Identify**.
2. `mp3fy` captures a short audio sample.
3. ShazamKit matches the sample against the Shazam catalog.
4. The app displays the matched song title and artist, then stops capturing.

Two audio-input paths may be supported:

- **Microphone input:** identifies music coming from the phone speaker or another audible source.
- **Android playback capture:** on Android 10 and later, can capture eligible audio being played by another app after the user approves Android's system capture prompt.

Playback capture is subject to the source app's capture policy, audio type, Android version, user profile, and protected-content restrictions. Detecting connected headphones does not itself grant access to their private audio output; a headset microphone captures nearby sound rather than the earphone output.

Recognition should be implemented with ShazamKit rather than a custom fingerprinting system. The current Expo scaffold will require a native Android module or a custom development build before ShazamKit and playback capture can be integrated.

## Technology

- Expo
- React Native
- TypeScript
- ShazamKit (planned)
- Android playback capture APIs (planned)

## Getting started

Install dependencies and start the Expo development server:

```bash
npm install
npm start
```

The scaffold can be opened on an Android emulator or Android device. The recognition feature will require a custom native development build; Expo Go alone will not provide the required native integrations.

## Product considerations

Future design and implementation will account for user privacy, explicit recording consent, responsible media handling, copyright, Android platform rules, and applicable laws. Audio capture should stop as soon as the recognition attempt finishes.

## Official references

- [ShazamKit](https://developer.apple.com/shazamkit/)
- [ShazamKit for Android](https://developer.apple.com/shazamkit/android/)
- [Android playback capture](https://developer.android.com/media/platform/av-capture)

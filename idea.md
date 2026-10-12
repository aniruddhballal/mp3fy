# mp3fy

`mp3fy` will be an Android-only mobile application for identifying music that is currently playing on the device, in a simple workflow inspired by Shazam.

The intended result is the exact matched song information—at minimum the title and artist, with additional metadata where available. Any MP3 conversion workflow remains a separate product decision and is not being implemented yet.

## Planned recognition approach

1. The user taps an **Identify** action.
2. The app captures a short audio sample.
3. The sample is sent to ShazamKit for matching against the Shazam catalog.
4. The app displays the matched song information and stops capturing audio.

The app should support two input paths where Android allows them:

- **Microphone input:** identify music coming from the phone speaker or another audible source.
- **Android playback capture:** on Android 10 and later, capture eligible audio being played by another app, subject to user approval and the source app's capture policy.

The app may detect that headphones are connected, but that does not automatically grant access to the audio routed through them. A headset microphone captures nearby sound, not the private earphone output.

This repository is intentionally starting as an empty product foundation. The recognition experience, supported audio sources, permissions, native Android integration, and user experience will be defined before functionality is implemented.

## Initial principles

- Android-only, mobile-first experience
- Clear, lightweight interface
- Explicit user consent for microphone and playback capture
- Capture audio only for as long as recognition requires
- Respect for copyright, platform rules, permissions, and applicable laws
- Privacy-conscious handling of audio and recognition results

## Known technical boundaries

- Playback capture is not guaranteed for every Android app or every type of audio.
- The source app can disallow playback capture, and protected audio may not be available.
- Playback capture requires Android's system permission flow and native Android APIs.
- The current Expo scaffold will need a native Android module or custom development build before recognition can be integrated.

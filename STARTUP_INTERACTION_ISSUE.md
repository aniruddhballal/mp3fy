# Startup interaction issue

## Original report

The following is the original problem description, preserved verbatim:

> um, one issue that i keep facing in this mp3fy app is that as soon as i open the app, fine it shows loading, checking wrapped folder etc etc which shows the circular loading animation and thats all fine. but then, after that, it shows the landing page, right? it shows the home page and the most recently played song is shown at the bottom. now, the issue is that even if it shows all this - nothing on the app is clickable for like 4-5 seconds or so after it first gets displayed. so, i need you to check why that happens, and if that can be fixed. or if it cannot be avoided, then you would need to either not show the buttons or anything in the ui until it can be clickable - you get the point, right? why show a button if clicking it at that moment wont register any action. so, yeah thats the isssue. like the scrolling is responsive - but clicking on the short "now playing" bottom ui doesnt open it completely, neither does any folder or any of the other 4 buttons that exist at the top.
>
> and sometimes, when the app opens, it shows this in the ui: so many of the buttons arent rendering only - check the screenshot - so yeah - this is what the issue is.

The follow-up requirement was:

> ofc dont show empty screens, its always better to show a loading and its okay if loading takes too long also - instead of showing something that the user cannot interact with

The performance constraint was:

> also do check if its a performance issue that can be fixed without increasing the load time etc

## What was happening

After the initial loading screen disappeared, mp3fy could show the home screen and the “Now Playing” bar before the app was actually ready to respond to taps.

Typical symptoms were:

- scrolling worked, but tapping the “Now Playing” bar did nothing for several seconds;
- folder cards and the buttons in the header did not respond immediately;
- the header sometimes showed empty bordered boxes where the icons should be;
- the screen looked ready even though startup work was still occupying the JavaScript/UI interaction path.

The delay was most noticeable when the app restored a saved library containing many folders or tracks.

## Likely cause

The saved library snapshot was displayed quickly, but a background folder rescan started shortly afterwards. Directory traversal and file inspection were performed from JavaScript. Large synchronous batches of file-system work could keep the JavaScript thread busy while the home screen was already visible.

Scrolling could still appear responsive because some scrolling work is handled natively, but React Native press handlers could not be processed promptly. This made the UI look interactive before it was reliably interactive.

There was also a separate startup race around the MaterialCommunityIcons font. The header could render its icon containers before the icon font had finished loading, producing empty boxes.

## What was tried

### 1. Keep the startup screen visible until the initial state is ready

`src/App.tsx` now keeps the loading screen visible until:

- the icon font has loaded;
- the library state has been restored or initially scanned;
- the Wrapped backup state is ready.

The startup screen uses simple loading text and does not expose the main app controls while those prerequisites are incomplete.

### 2. Explicitly preload the icon font

`MaterialCommunityIcons.font` is loaded with `useFonts`. The main interface is not rendered until `iconsLoaded` is true. This was intended to prevent the header from showing blank icon boxes during the first render.

### 3. Keep cached startup fast

When a valid saved library snapshot exists, the snapshot is shown immediately instead of making the user wait for a complete rescan. A refresh is scheduled after the home screen appears so the app can discover changes to the folders.

This preserves the fast cached startup, but it also means the background refresh must remain cooperative and must not monopolize the JavaScript thread.

### 4. Yield during library scanning

`src/services/libraryScanner.ts` now yields to the event loop:

- before scanning each directory;
- after every 32 processed directory entries.

The scanner was changed to async traversal so long scans are split into smaller pieces. The intention is to let touch handlers and other app work run between scan batches.

## Why the issue may still occur

These changes reduce one known source of blocking; they do not prove that every startup task is non-blocking. Other possible contributors still need to be measured, including:

- restoring a large playback queue and adding many player items;
- artwork loading, image decoding, or artwork-cache cleanup;
- React re-rendering caused by replacing the entire folder/track collection;
- native file-system calls that remain synchronous internally;
- audio-session, notification, or lock-screen initialization;
- work triggered by components mounted immediately after the home screen appears.

If the delay is still present, the next step should be to profile startup timing and identify which operation overlaps the unresponsive period, rather than increasing the loading delay blindly.

## Useful reproduction details

When investigating another occurrence, record:

1. whether the app had a saved library snapshot;
2. approximate folder and track counts;
3. whether the delay happens on a cold launch, every launch, or only after reinstall/update;
4. whether scrolling works while taps fail;
5. whether the header icons are blank;
6. whether the delay ends after the library refresh finishes.

The current implementation should be treated as a mitigation attempt for the startup interaction problem, not as confirmation that the underlying performance issue is fully resolved.

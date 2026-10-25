export type LockScreenMetadata = {
  title: string;
  artist: string;
  albumTitle?: string;
  artworkUrl?: string;
};

type PlayerWithOptionalMethods = object & Record<string, unknown>;

function callOptionalPlayerMethod(player: object, methodName: string, ...args: unknown[]) {
  const method = (player as PlayerWithOptionalMethods)[methodName];
  if (typeof method !== 'function') return;
  try {
    method.apply(player, args);
  } catch {
    // Lock-screen controls are an enhancement; they must never interrupt playback.
  }
}

const lockScreenOptions = { showSeekBackward: false, showSeekForward: false };

export function activateLockScreen(player: object, metadata: LockScreenMetadata) {
  callOptionalPlayerMethod(player, 'setActiveForLockScreen', true, metadata, lockScreenOptions);
}

export function updateLockScreen(player: object, metadata: LockScreenMetadata) {
  callOptionalPlayerMethod(player, 'updateLockScreenMetadata', metadata);
}

export function deactivateLockScreen(player: object) {
  callOptionalPlayerMethod(player, 'setActiveForLockScreen', false);
}

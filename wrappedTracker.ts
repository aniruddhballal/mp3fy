import { localDay, type ListeningEntry } from './wrappedStore';

export type ListeningTrack = { uri: string; title: string; artist: string };
export type PlaybackSample = {
  track: ListeningTrack | null;
  positionSeconds: number;
  durationSeconds: number;
  playing: boolean;
  buffering: boolean;
  atMs: number;
};

const PLAY_THRESHOLD_MS = 30_000;

export class ListeningTracker {
  private previous: PlaybackSample | null = null;
  private heardInSessionMs = 0;
  private countedSession = false;
  private ignoreNextPositionJump = false;
  private pending = new Map<string, ListeningEntry>();
  private flushing = Promise.resolve();

  constructor(private readonly write: (entries: ListeningEntry[]) => Promise<void>) {}

  private add(track: ListeningTrack, day: string, listenedMs: number, plays: number) {
    if (listenedMs <= 0 && plays <= 0) return;
    const key = `${day}\u0000${track.uri}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.listenedMs += listenedMs;
      existing.plays += plays;
      existing.title = track.title;
      existing.artist = track.artist;
    } else {
      this.pending.set(key, { ...track, day, listenedMs, plays });
    }
  }

  private addListening(track: ListeningTrack, fromMs: number, toMs: number, listenedMs: number) {
    const wallMs = Math.max(1, toMs - fromMs);
    let cursor = fromMs;
    let remaining = listenedMs;
    while (cursor < toMs) {
      const current = new Date(cursor);
      const nextDay = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
      const end = Math.min(nextDay, toMs);
      const amount = end === toMs ? remaining : Math.round(listenedMs * (end - cursor) / wallMs);
      this.add(track, localDay(current), amount, 0);
      remaining -= amount;
      cursor = end;
    }
  }

  private hear(track: ListeningTrack, fromMs: number, toMs: number, listenedMs: number) {
    if (listenedMs <= 0) return;
    this.addListening(track, fromMs, toMs, listenedMs);
    this.heardInSessionMs += listenedMs;
    if (!this.countedSession && this.heardInSessionMs >= PLAY_THRESHOLD_MS) {
      this.countedSession = true;
      this.add(track, localDay(new Date(toMs)), 0, 1);
    }
  }

  observe(sample: PlaybackSample) {
    const previous = this.previous;
    if (!sample.track) {
      this.previous = sample;
      this.heardInSessionMs = 0;
      this.countedSession = false;
      return;
    }
    if (!previous || previous.track?.uri !== sample.track.uri) {
      this.previous = sample;
      this.heardInSessionMs = 0;
      this.countedSession = false;
      this.ignoreNextPositionJump = false;
      return;
    }

    if (this.ignoreNextPositionJump) {
      this.ignoreNextPositionJump = false;
      this.previous = sample;
      return;
    }

    const wallMs = Math.max(0, sample.atMs - previous.atMs);
    const previousAudible = previous.playing && !previous.buffering;
    const positionMs = (sample.positionSeconds - previous.positionSeconds) * 1000;
    const maxListeningMs = wallMs + 1000;
    const looped = previous.durationSeconds > 0
      && previous.positionSeconds >= previous.durationSeconds - 5
      && sample.positionSeconds < 5
      && positionMs < -1000
      && sample.playing;

    if (looped) {
      if (previousAudible) {
        const beforeLoop = Math.min(maxListeningMs, Math.max(0, (previous.durationSeconds - previous.positionSeconds) * 1000));
        this.hear(sample.track, previous.atMs, Math.min(sample.atMs, previous.atMs + beforeLoop), beforeLoop);
      }
      this.heardInSessionMs = 0;
      this.countedSession = false;
      if (sample.playing && !sample.buffering) {
        const afterLoop = Math.min(Math.max(0, maxListeningMs - Math.max(0, (previous.durationSeconds - previous.positionSeconds) * 1000)), Math.max(0, sample.positionSeconds * 1000));
        this.hear(sample.track, Math.max(previous.atMs, sample.atMs - afterLoop), sample.atMs, afterLoop);
      }
    } else if (previousAudible && positionMs > 0) {
      const listenedMs = Math.min(positionMs, maxListeningMs);
      this.hear(sample.track, Math.max(previous.atMs, sample.atMs - listenedMs), sample.atMs, listenedMs);
    }
    this.previous = sample;
  }

  markSeek() {
    this.ignoreNextPositionJump = true;
  }

  restart() {
    this.previous = null;
    this.heardInSessionMs = 0;
    this.countedSession = false;
    this.ignoreNextPositionJump = false;
  }

  flush(): Promise<void> {
    if (!this.pending.size) return this.flushing;
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    const next = this.flushing.catch(() => undefined).then(() => this.write(entries)).catch((error) => {
      for (const entry of entries) this.add(entry, entry.day, entry.listenedMs, entry.plays);
      throw error;
    });
    this.flushing = next;
    return next;
  }
}

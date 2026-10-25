import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { type AudioPlaylistStatus } from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, LayoutChangeEvent, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as SystemStatusBar } from 'react-native';
import { fetchLyrics, type LyricsResult } from '../../features/lyrics/lyrics';
import { nextPlaybackMode, type PlaybackMode } from '../../features/playback/playbackOrder';
import type { RepeatMode, Track, TrackMetadata } from '../../types/domain';
import { ActionButton, AlbumArt, MarqueeText, QueueButton, ScreenHeader, SmallButton } from '../AppPrimitives';
import { styles } from '../../styles/appStyles';

const LYRICS_SYNC_LEAD_SECONDS = 0.12;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

type TransportIconKind = 'shuffle' | 'repeatAll' | 'repeatOne';

function TransportGlyph({ kind, active }: { kind: TransportIconKind; active: boolean }) {
  const color = active ? '#FFFFFF' : '#000000';
  if (kind === 'repeatAll' || kind === 'repeatOne') {
    // The ring is identical in both states; repeat-one just adds a small raised "1" (like an exponent) in the free space to its right.
    return <View style={styles.repeatFrame}><Text style={[styles.glyphText, styles.repeatRing, { color }]}>{'\u21bb'}</Text>{kind === 'repeatOne' ? <Text style={[styles.repeatOneNumber, { color }]}>1</Text> : null}</View>;
  }
  const bar = (left: number, top: number, width: number) => <View style={[styles.glyphBar, { backgroundColor: color, left, top, width }]} />;
  const head = (top: number) => <View style={[styles.glyphArrowHead, { borderLeftColor: color, top }]} />;
  // Two lines that cross over each other, both ending in arrows.
  return <View style={styles.smallIconFrame}>{bar(0, 5, 5)}{bar(0, 13, 5)}<View style={[styles.glyphBar, { backgroundColor: color, left: 3.3, top: 9, width: 11.3, transform: [{ rotate: '45deg' }] }]} /><View style={[styles.glyphBar, { backgroundColor: color, left: 3.3, top: 9, width: 11.3, transform: [{ rotate: '-45deg' }] }]} />{bar(13, 5, 3)}{bar(13, 13, 3)}{head(3)}{head(11)}</View>;
}

function IconButton({ icon, accessibilityLabel, onPress, active = false, transport = false }: { icon: TransportIconKind; accessibilityLabel: string; onPress: () => void; active?: boolean; transport?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.iconButton, transport && styles.transportSideButton, active && styles.activeIconButton, pressed && styles.pressed]}><TransportGlyph kind={icon} active={active} /></Pressable>;
}

function PlaybackOrderButton({ mode, onPress }: { mode: PlaybackMode; onPress: () => void }) {
  const shuffled = mode === 'shuffle';
  const accessibilityLabel = mode === 'folder' ? 'Folder filename order. Switch to song title order' : mode === 'title' ? 'Song title order. Switch to shuffle' : 'Shuffle. Switch to folder filename order';
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} style={({ pressed }) => [styles.iconButton, styles.transportSideButton, shuffled && styles.activeIconButton, pressed && styles.pressed]}>{shuffled ? <TransportGlyph kind="shuffle" active /> : <Text style={styles.orderModeText}>{mode === 'folder' ? 'A-Z' : 'a-z'}</Text>}</Pressable>;
}

export function PlayerScreen({ track, metadata, artwork, artworkLoading, status, progress, progressWidth, mode, repeatMode, onSeek, onProgressLayout, onPrevious, onNext, onTogglePlay, onModeChange, onRepeatChange, onOpenQueue }: { track: Track; metadata: TrackMetadata; artwork: string | null; artworkLoading: boolean; status: AudioPlaylistStatus; progress: number; progressWidth: number; mode: PlaybackMode; repeatMode: RepeatMode; onSeek: (event: { nativeEvent: { locationX: number } }) => void; onProgressLayout: (event: LayoutChangeEvent) => void; onPrevious: () => void; onNext: () => void; onTogglePlay: () => void; onModeChange: (mode: PlaybackMode) => void; onRepeatChange: (mode: RepeatMode) => void; onOpenQueue: () => void }) {
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsResult, setLyricsResult] = useState<LyricsResult | null>(null);
  const lyricsRequest = useRef(0);

  const requestLyrics = useCallback(() => {
    if (lyricsLoading) return;
    const requestId = ++lyricsRequest.current;
    setLyricsLoading(true);
    setLyricsResult(null);
    void fetchLyrics({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album || undefined,
      duration: Number.isFinite(status.duration) && status.duration >= 1 && status.duration <= 3600 ? status.duration : undefined,
    }).then((result) => {
      if (requestId !== lyricsRequest.current) return;
      setLyricsResult(result);
      setLyricsLoading(false);
    });
  }, [lyricsLoading, metadata.album, metadata.artist, metadata.title, status.duration]);

  const openLyrics = useCallback(() => {
    setLyricsOpen(true);
    if (!lyricsResult && !lyricsLoading) requestLyrics();
  }, [lyricsLoading, lyricsResult, requestLyrics]);

  useEffect(() => {
    lyricsRequest.current += 1;
    setLyricsOpen(false);
    setLyricsLoading(false);
    setLyricsResult(null);
    return () => { lyricsRequest.current += 1; };
  }, [track.uri]);

  return (
    <ScrollView contentContainerStyle={styles.playerScreen} showsVerticalScrollIndicator={false}>
      <ScreenHeader right={<View style={styles.playerHeaderActions}><MarqueeText alignRight style={styles.playerHeaderFolderViewport} text={track.folderName} textStyle={styles.playerHeaderFolderText} /></View>} />
      <View style={styles.playerArt}><AlbumArt label={metadata.title} size={280} uri={artwork} loading={artworkLoading} /></View>
      <View style={styles.playerTitleRow}><MarqueeText style={styles.playerTitleViewport} text={metadata.title} textStyle={styles.playerTitle} /><View style={styles.playerTitleActions}><Pressable accessibilityRole="button" accessibilityLabel="Show lyrics" onPress={openLyrics} style={({ pressed }) => [styles.lyricsButton, pressed && styles.pressed]}><Text style={styles.lyricsButtonText}>LYRICS</Text></Pressable><QueueButton onPress={onOpenQueue} /></View></View>
      {metadata.artist ? <MarqueeText style={styles.playerArtistViewport} text={metadata.artist} textStyle={styles.playerArtist} /> : null}
      {metadata.album || metadata.trackNumber ? <View style={styles.metadataDetails}>
        {metadata.album ? <MarqueeText style={styles.metadataAlbumViewport} text={metadata.album} textStyle={styles.metadataItem} /> : null}
        {metadata.trackNumber ? <Text style={styles.metadataItem} numberOfLines={1}>#{metadata.trackNumber}</Text> : null}
      </View> : null}
      <Pressable accessibilityRole="adjustable" onLayout={onProgressLayout} onPress={onSeek} style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></Pressable>
      <View style={styles.timeRow}><Text style={styles.timeText}>{formatTime(status.currentTime)}</Text><Text style={styles.timeText}>{formatTime(status.duration)}</Text></View>
      <View style={styles.transportRow}><PlaybackOrderButton mode={mode} onPress={() => onModeChange(nextPlaybackMode(mode))} /><SmallButton label="|<" transport onPress={onPrevious} /><ActionButton label={status.playing ? 'PAUSE' : 'PLAY'} transport onPress={onTogglePlay} /><SmallButton label="|>" transport onPress={onNext} /><IconButton icon={repeatMode === 'one' ? 'repeatOne' : 'repeatAll'} transport accessibilityLabel={repeatMode === 'one' ? 'Repeat current song. Switch to repeat folder' : 'Repeat folder. Switch to repeat current song'} active={repeatMode === 'one'} onPress={() => onRepeatChange(repeatMode === 'one' ? 'all' : 'one')} /></View>
      <LyricsModal visible={lyricsOpen} title={metadata.title} artist={metadata.artist} result={lyricsResult} loading={lyricsLoading} currentTime={status.currentTime} onClose={() => setLyricsOpen(false)} onRetry={requestLyrics} />
    </ScrollView>
  );
}

function LyricsModal({ visible, title, artist, result, loading, currentTime, onClose, onRetry }: { visible: boolean; title: string; artist: string; result: LyricsResult | null; loading: boolean; currentTime: number; onClose: () => void; onRetry: () => void }) {
  const scrollRef = useRef<ScrollView>(null);
  const lineOffsets = useRef<Record<number, number>>({});
  const previousActiveLine = useRef(-2);
  const syncedLines = result?.kind === 'synced' ? result.lines : [];
  const activeLine = useMemo(() => {
    if (result?.kind !== 'synced') return -1;
    let active = -1;
    result.lines.forEach((line, index) => { if (line.timestampMs / 1000 <= currentTime + LYRICS_SYNC_LEAD_SECONDS) active = index; });
    return active;
  }, [currentTime, result]);

  useEffect(() => {
    lineOffsets.current = {};
    previousActiveLine.current = -2;
  }, [result]);

  useEffect(() => {
    if (activeLine < 0 || activeLine === previousActiveLine.current) return;
    previousActiveLine.current = activeLine;
    const offset = lineOffsets.current[activeLine];
    if (offset !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, offset - 120), animated: true });
  }, [activeLine]);

  return <Modal animationType="slide" navigationBarTranslucent={false} statusBarTranslucent={false} visible={visible} onRequestClose={onClose}>
    <SafeAreaView edges={['top', 'bottom']} style={styles.lyricsModal}>
      <SystemStatusBar barStyle="dark-content" backgroundColor="#FFFFFF" translucent={false} />
      <View style={styles.lyricsHeader}><View><Text style={styles.wordmark}>mp3fy</Text><Text style={styles.label}>LYRICS</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close lyrics" onPress={onClose} style={styles.headerIconButton}><MaterialCommunityIcons name="close" size={23} color="#000000" /></Pressable></View>
      <View style={styles.lyricsTrack}><Text numberOfLines={1} style={styles.lyricsTitle}>{title}</Text>{artist ? <Text numberOfLines={1} style={styles.lyricsArtist}>{artist}</Text> : null}</View>
      {loading ? <View style={styles.lyricsMessage}><ActivityIndicator color="#000000" /><Text style={styles.lyricsMessageText}>Loading lyrics...</Text></View> : result?.kind === 'error' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>Lyrics unavailable</Text><Text style={styles.lyricsMessageText}>{result.message}</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.lyricsRetry}><Text style={styles.lyricsRetryText}>TRY AGAIN</Text></Pressable></View> : result?.kind === 'not-found' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>No lyrics found</Text><Text style={styles.lyricsMessageText}>LRCLIB does not have lyrics for this song.</Text></View> : result?.kind === 'instrumental' ? <View style={styles.lyricsMessage}><Text style={styles.lyricsMessageTitle}>Instrumental track</Text><Text style={styles.lyricsMessageText}>There are no lyrics for this song.</Text></View> : result?.kind === 'plain' ? <ScrollView style={styles.lyricsScroll} contentContainerStyle={styles.lyricsContent} showsVerticalScrollIndicator={false}>{result.plainLyrics.split(/\r?\n/).map((line, index) => <Text key={`${index}-${line}`} style={styles.plainLyricLine}>{line || ' '}</Text>)}</ScrollView> : result?.kind === 'synced' ? <ScrollView ref={scrollRef} style={styles.lyricsScroll} contentContainerStyle={styles.lyricsContent} showsVerticalScrollIndicator={false}>{syncedLines.map((line, index) => <SyncedLyricLine key={`${index}-${line.timestampMs}`} line={line.text} active={index === activeLine} onLayout={(event) => { lineOffsets.current[index] = event.nativeEvent.layout.y; }} />)}</ScrollView> : null}
    </SafeAreaView>
  </Modal>;
}

function SyncedLyricLine({ line, active, onLayout }: { line: string; active: boolean; onLayout: (event: { nativeEvent: { layout: { y: number } } }) => void }) {
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, { duration: 180, easing: Easing.out(Easing.cubic), toValue: active ? 1 : 0, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [active, progress]);

  return <View onLayout={onLayout} style={styles.syncedLyricRow}><Animated.Text style={[styles.syncedLyricText, { color: progress.interpolate({ inputRange: [0, 1], outputRange: ['#999999', '#000000'] }), opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) }]}>{line || ' '}</Animated.Text></View>;
}




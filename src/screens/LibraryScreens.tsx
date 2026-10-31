import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, Text, TextInput, View } from 'react-native';
import { fallbackMetadata } from '../services/trackMetadata';
import type { Folder, Track, TrackMetadata } from '../types/domain';
import { AlbumArt, FolderArtwork, MarqueeText, QueueButton, ScreenHeader, WrappedButton } from '../components/AppPrimitives';
import { styles } from '../styles/appStyles';

export const FoldersScreen = memo(function FoldersScreen({ folders, tracksCount, hasQueue, isScanning, scanningFolderUris, notice, onAddFolder, onAddSong, onOpenFolder, onLongPressFolder, onOpenWrapped, onOpenQueue }: { folders: { folder: Folder; count: number }[]; tracksCount: number; hasQueue: boolean; isScanning: boolean; scanningFolderUris: ReadonlySet<string>; notice: string; onAddFolder: () => void; onAddSong: () => void; onOpenFolder: (folder: Folder) => void; onLongPressFolder: (folder: Folder) => void; onOpenWrapped: () => void; onOpenQueue: () => void }) {
  return (
    <View style={styles.screen}>
      <ScreenHeader right={<View style={styles.headerActions}><Text style={styles.count}>{folders.length} FOLDERS - {tracksCount} TRACKS</Text><View style={styles.homeHeaderActions}><WrappedButton onPress={onOpenWrapped} /><Pressable accessibilityRole="button" accessibilityLabel="Add song" accessibilityHint="Choose an MP3 file" onPress={onAddSong} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="music-note-plus" size={22} color="#000000" /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Add folder" accessibilityHint="Choose a folder of MP3 files" onPress={onAddFolder} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="folder-plus-outline" size={22} color="#000000" /></Pressable>{hasQueue ? <QueueButton onPress={onOpenQueue} /> : null}</View></View>} />
      {isScanning && !folders.length ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning selected folders...</Text></View> : folders.length ? <FlatList data={folders} keyExtractor={({ folder }) => folder.uri} numColumns={2} columnWrapperStyle={styles.folderGridRow} renderItem={({ item }) => <Pressable delayLongPress={450} onLongPress={() => onLongPressFolder(item.folder)} onPress={() => onOpenFolder(item.folder)} style={({ pressed }) => [styles.folderCard, pressed && styles.pressed]}><FolderArtwork grid uri={item.folder.imageUri} /><View style={styles.folderCopy}><Text style={styles.folderTitle} numberOfLines={2}>{item.folder.name}</Text><View style={styles.folderMetaRow}><Text style={styles.folderMeta}>{item.count}</Text>{scanningFolderUris.has(item.folder.uri) ? <ActivityIndicator color="#000000" size="small" /> : null}</View></View><Text style={styles.chevron}>&gt;</Text></Pressable>} contentContainerStyle={styles.folderGrid} initialNumToRender={8} maxToRenderPerBatch={8} removeClippedSubviews windowSize={5} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No folders selected</Text><Text style={styles.description}>Add a folder containing your MP3 files. Only the folders you choose will be scanned.</Text><Text style={styles.notice}>{notice}</Text></View>}
    </View>
  );
});

export const SongsScreen = memo(function SongsScreen({ folder, tracks, currentTrack, currentMetadata, metadataCache, isScanning, onPlayTrack, onOpenQueue }: { folder: Folder; tracks: Track[]; currentTrack: Track | null; currentMetadata: TrackMetadata | null; metadataCache: ReadonlyMap<string, TrackMetadata>; isScanning: boolean; onPlayTrack: (track: Track) => void; onOpenQueue: () => void }) {
  const [search, setSearch] = useState('');
  const visibleTracks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tracks.map((track) => ({
      track,
      metadata: track.uri === currentTrack?.uri && currentMetadata
        ? currentMetadata
        : metadataCache.get(track.uri) ?? fallbackMetadata(track),
    })).filter(({ track, metadata }) => !query || `${metadata.title} ${metadata.artist} ${track.name}`.toLowerCase().includes(query))
      .sort((a, b) => a.metadata.title.localeCompare(b.metadata.title) || a.track.name.localeCompare(b.track.name));
  }, [currentMetadata, currentTrack, metadataCache, search, tracks]);
  return (
    <View style={styles.screen}>
      <ScreenHeader right={<View style={styles.headerActions}><Text style={styles.count}>{tracks.length} TRACKS</Text><View style={styles.playerHeaderButtons}>{currentTrack ? <QueueButton onPress={onOpenQueue} /> : null}</View></View>} />
      <View style={styles.pageHeading}><Text numberOfLines={2} style={styles.screenTitle}>{folder.name}</Text></View>
      <TextInput accessibilityLabel="Search songs in folder" onChangeText={setSearch} placeholder="Search songs" placeholderTextColor="#666666" style={styles.search} value={search} />
      {isScanning ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.notice}>Scanning folder.</Text></View> : visibleTracks.length ? <FlatList data={visibleTracks} keyExtractor={({ track }) => track.uri} initialNumToRender={16} maxToRenderPerBatch={12} removeClippedSubviews windowSize={7} renderItem={({ item: { track, metadata } }) => {
        const isPlaying = currentTrack?.uri === track.uri;
        return <Pressable onPress={() => onPlayTrack(track)} style={({ pressed }) => [styles.trackRow, isPlaying && styles.activeTrackRow, pressed && styles.pressed]}><View style={[styles.trackIndicator, isPlaying && styles.activeTrackIndicator]} /><View style={styles.trackCopy}>{isPlaying ? <MarqueeText style={styles.trackNameViewport} text={metadata.title} textStyle={styles.trackName} fadeColor="#F2F2F2" fadeTransparentColor="rgba(242,242,242,0)" /> : <Text ellipsizeMode="tail" numberOfLines={1} style={styles.trackName}>{metadata.title}</Text>}{metadata.artist ? <Text ellipsizeMode="tail" numberOfLines={1} style={styles.trackArtist}>{metadata.artist}</Text> : null}</View></Pressable>;
      }} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false} /> : <View style={styles.emptyState}><View style={styles.rule} /><Text style={styles.title}>No MP3 files</Text><Text style={styles.description}>This folder does not currently contain any MP3 files.</Text></View>}
    </View>
  );
});

export const MiniPlayer = memo(function MiniPlayer({ track, metadata, artwork, artworkLoading, playing, onOpen, onTogglePlay, onNext }: { track: Track; metadata: TrackMetadata; artwork: string | null; artworkLoading: boolean; playing: boolean; onOpen: () => void; onTogglePlay: () => void; onNext: () => void }) {
  return <View style={styles.miniPlayer}><Pressable onPress={onOpen} style={styles.miniMain}><AlbumArt label={metadata.title} size={52} uri={artwork} loading={artworkLoading} /><View style={styles.miniCopy}><Text style={styles.miniLabel}>NOW PLAYING</Text><MarqueeText style={styles.miniTitleViewport} text={metadata.title} textStyle={styles.miniTitle} /><MarqueeText style={styles.miniArtistViewport} text={metadata.artist || track.folderName} textStyle={styles.miniFolder} /></View></Pressable><Pressable accessibilityRole="button" onPress={onTogglePlay} style={styles.miniButton}><Text style={styles.miniButtonText}>{playing ? '||' : '>'}</Text></Pressable><Pressable accessibilityRole="button" onPress={onNext} style={styles.miniButton}><Text style={styles.miniButtonText}>&gt;|</Text></Pressable></View>;
});



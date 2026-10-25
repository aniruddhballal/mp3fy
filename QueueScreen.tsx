import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { APP_VERSION } from './appVersion';

export type QueueRow = { uri: string; title: string; artist: string };

const ROW_HEIGHT = 68;
const EDGE_SIZE = 64;

function PlayingBars({ playing }: { playing: boolean }) {
  const bars = useRef([new Animated.Value(0.45), new Animated.Value(0.85), new Animated.Value(0.6)]).current;
  useEffect(() => {
    if (!playing) {
      bars.forEach((bar) => bar.setValue(0.35));
      return;
    }
    const animations = bars.map((bar, index) => Animated.loop(Animated.sequence([
      Animated.timing(bar, { toValue: index === 1 ? 0.3 : 1, duration: 260 + index * 80, useNativeDriver: true }),
      Animated.timing(bar, { toValue: index === 1 ? 1 : 0.3, duration: 330 + index * 70, useNativeDriver: true }),
    ])));
    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
  }, [bars, playing]);
  return <View accessibilityLabel={playing ? 'Playing' : 'Paused'} style={styles.playingBars}>{bars.map((bar, index) => <Animated.View key={index} style={[styles.playingBar, { transform: [{ scaleY: bar }] }]} />)}</View>;
}

function DragHandle({ index, title, onStart, onMove, onEnd, onCancel, onMoveBy }: { index: number; title: string; onStart: (index: number, pageY: number) => void; onMove: (dy: number, pageY: number) => void; onEnd: () => void; onCancel: () => void; onMoveBy: (from: number, to: number) => void }) {
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => onStart(index, event.nativeEvent.pageY),
    onPanResponderMove: (_, gesture) => onMove(gesture.dy, gesture.moveY),
    onPanResponderRelease: onEnd,
    onPanResponderTerminate: onCancel,
    onPanResponderTerminationRequest: () => false,
  }), [index, onCancel, onEnd, onMove, onStart]);
  return <View {...responder.panHandlers} accessible accessibilityRole="adjustable" accessibilityLabel={`Reorder ${title}`} accessibilityHint="Drag to move this song in the queue" accessibilityActions={[{ name: 'decrement', label: 'Move up' }, { name: 'increment', label: 'Move down' }]} onAccessibilityAction={(event) => onMoveBy(index, index + (event.nativeEvent.actionName === 'decrement' ? -1 : 1))} style={styles.dragHandle}><MaterialCommunityIcons name="drag-horizontal-variant" size={24} color="#333333" /></View>;
}

export const QueueScreen = memo(function QueueScreen({ current, upcoming, playing, onBack, onMove, onRemove, onClear }: { current: QueueRow; upcoming: QueueRow[]; playing: boolean; onBack: () => void; onMove: (from: number, to: number) => void; onRemove: (uri: string) => void; onClear: () => void }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number; startOffset: number; dy: number } | null>(null);
  const dragOffset = useRef(new Animated.Value(0)).current;
  const listContainerRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const listBounds = useRef({ top: 0, bottom: 0 });
  const pointerY = useRef(0);
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateDrag = useCallback((dy: number, pageY: number) => {
    const active = dragRef.current;
    if (!active) return;
    active.dy = dy;
    pointerY.current = pageY;
    const displacement = dy + scrollOffset.current - active.startOffset;
    dragOffset.setValue(displacement);
    const to = Math.max(0, Math.min(upcoming.length - 1, active.from + Math.round(displacement / ROW_HEIGHT)));
    if (to !== active.to) {
      active.to = to;
      setDrag({ from: active.from, to });
    }
  }, [dragOffset, upcoming.length]);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
    autoScrollTimer.current = null;
  }, []);

  const startDrag = useCallback((index: number, pageY: number) => {
    stopAutoScroll();
    dragRef.current = { from: index, to: index, startOffset: scrollOffset.current, dy: 0 };
    pointerY.current = pageY;
    dragOffset.setValue(0);
    setDrag({ from: index, to: index });
    listContainerRef.current?.measureInWindow((_, y, __, height) => { listBounds.current = { top: y, bottom: y + height }; });
    autoScrollTimer.current = setInterval(() => {
      const active = dragRef.current;
      if (!active) return;
      const { top, bottom } = listBounds.current;
      if (bottom <= top) return;
      const direction = pointerY.current < top + EDGE_SIZE ? -1 : pointerY.current > bottom - EDGE_SIZE ? 1 : 0;
      if (!direction) return;
      const maxOffset = Math.max(0, contentHeight.current - viewportHeight.current);
      const nextOffset = Math.max(0, Math.min(maxOffset, scrollOffset.current + direction * 16));
      if (nextOffset === scrollOffset.current) return;
      scrollOffset.current = nextOffset;
      scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
      updateDrag(active.dy, pointerY.current);
    }, 40);
  }, [dragOffset, stopAutoScroll, updateDrag]);

  const endDrag = useCallback(() => {
    const active = dragRef.current;
    dragRef.current = null;
    stopAutoScroll();
    dragOffset.setValue(0);
    setDrag(null);
    if (active && active.from !== active.to) onMove(active.from, active.to);
  }, [dragOffset, onMove, stopAutoScroll]);

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    stopAutoScroll();
    dragOffset.setValue(0);
    setDrag(null);
  }, [dragOffset, stopAutoScroll]);

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);
  useEffect(() => { if (dragRef.current) cancelDrag(); }, [cancelDrag, current.uri]);

  return <View style={styles.screen}>
    <View style={styles.header}><View><Text style={styles.wordmark}>mp3fy</Text><Text style={styles.headerSubtitle}>{APP_VERSION}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close queue" onPress={onBack} style={styles.headerButton}><MaterialCommunityIcons name="close" size={23} color="#000000" /></Pressable></View>
    <View style={styles.currentCard}><PlayingBars playing={playing} /><View style={styles.currentCopy}><Text style={styles.eyebrow}>CURRENT SONG</Text><Text numberOfLines={1} style={styles.currentTitle}>{current.title}</Text>{current.artist ? <Text numberOfLines={1} style={styles.artist}>{current.artist}</Text> : null}</View></View>
    <View style={styles.sectionHeader}><View><Text style={styles.sectionTitle}>UP NEXT</Text><Text style={styles.sectionCount}>{upcoming.length} {upcoming.length === 1 ? 'song' : 'songs'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Clear queue" accessibilityState={{ disabled: upcoming.length === 0 }} disabled={upcoming.length === 0} onPress={() => setConfirmClear(true)}><Text style={[styles.clearText, upcoming.length === 0 && styles.disabledText]}>CLEAR QUEUE</Text></Pressable></View>
    <View ref={listContainerRef} onLayout={(event) => { viewportHeight.current = event.nativeEvent.layout.height; }} style={styles.list}><ScrollView ref={scrollRef} scrollEnabled={!drag} scrollEventThrottle={16} onScroll={(event) => { scrollOffset.current = event.nativeEvent.contentOffset.y; }} onContentSizeChange={(_, height) => { contentHeight.current = height; }} showsVerticalScrollIndicator={false} contentContainerStyle={styles.listContent}>
      {upcoming.length ? upcoming.map((item, index) => <Animated.View key={item.uri} style={[styles.queueRow, drag?.to === index && drag.from !== index && styles.dropTarget, drag?.from === index && { backgroundColor: '#FFFFFF', elevation: 8, zIndex: 10, transform: [{ translateY: dragOffset }] }]}><Text style={styles.rowNumber}>{index + 1}</Text><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>{item.artist ? <Text numberOfLines={1} style={styles.artist}>{item.artist}</Text> : null}</View><Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.title} from queue`} onPress={() => onRemove(item.uri)} style={styles.removeButton}><MaterialCommunityIcons name="close" size={20} color="#555555" /></Pressable><DragHandle index={index} title={item.title} onStart={startDrag} onMove={updateDrag} onEnd={endDrag} onCancel={cancelDrag} onMoveBy={onMove} /></Animated.View>) : <View style={styles.emptyQueue}><Text style={styles.emptyTitle}>Queue is clear</Text><Text style={styles.emptyDetail}>The current song will repeat.</Text></View>}
    </ScrollView></View>
    <Modal visible={confirmClear} transparent animationType="fade" onRequestClose={() => setConfirmClear(false)}><View style={styles.modalBackdrop}><View style={styles.modalCard}><Text style={styles.modalTitle}>Clear the queue?</Text><Text style={styles.modalDescription}>Only the current song will remain, and repeat one will turn on.</Text><Pressable accessibilityRole="button" onPress={() => { setConfirmClear(false); onClear(); }} style={styles.confirmButton}><Text style={styles.confirmText}>CLEAR QUEUE</Text></Pressable><Pressable accessibilityRole="button" onPress={() => setConfirmClear(false)} style={styles.cancelButton}><Text style={styles.cancelText}>CANCEL</Text></Pressable></View></View></Modal>
  </View>;
});

const styles = StyleSheet.create({
  screen: { backgroundColor: '#FFFFFF', flex: 1 },
  header: { alignItems: 'flex-end', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, paddingTop: 10 },
  wordmark: { color: '#000000', fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  headerSubtitle: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 },
  headerButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, height: 40, justifyContent: 'center', width: 40 },
  currentCard: { alignItems: 'center', backgroundColor: '#F2F2F2', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', minHeight: 92, paddingHorizontal: 12, paddingVertical: 14 },
  playingBars: { alignItems: 'center', flexDirection: 'row', gap: 3, height: 28, justifyContent: 'center', marginRight: 14, width: 30 },
  playingBar: { backgroundColor: '#000000', height: 24, width: 5 },
  currentCopy: { flex: 1, minWidth: 0 },
  eyebrow: { color: '#555555', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  currentTitle: { color: '#000000', fontSize: 16, fontWeight: '700', marginTop: 4 },
  artist: { color: '#666666', fontSize: 12, marginTop: 4 },
  sectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingTop: 20 },
  sectionTitle: { color: '#000000', fontSize: 18, fontWeight: '700' },
  sectionCount: { color: '#666666', fontSize: 11, marginTop: 3 },
  clearText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.6, textDecorationLine: 'underline' },
  disabledText: { color: '#AAAAAA' },
  list: { flex: 1, marginTop: 10 },
  listContent: { paddingBottom: 24 },
  queueRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', height: ROW_HEIGHT },
  dropTarget: { borderTopColor: '#000000', borderTopWidth: 2 },
  rowNumber: { color: '#777777', fontSize: 11, width: 25 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#000000', fontSize: 14, fontWeight: '600' },
  removeButton: { alignItems: 'center', height: 42, justifyContent: 'center', width: 38 },
  dragHandle: { alignItems: 'center', height: ROW_HEIGHT, justifyContent: 'center', width: 38 },
  emptyQueue: { alignItems: 'center', paddingTop: 42 },
  emptyTitle: { color: '#000000', fontSize: 18, fontWeight: '700' },
  emptyDetail: { color: '#666666', fontSize: 12, marginTop: 7 },
  modalBackdrop: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  modalCard: { backgroundColor: '#FFFFFF', padding: 22, width: '100%' },
  modalTitle: { color: '#000000', fontSize: 20, fontWeight: '700' },
  modalDescription: { color: '#444444', fontSize: 13, lineHeight: 19, marginBottom: 20, marginTop: 10 },
  confirmButton: { alignItems: 'center', backgroundColor: '#000000', paddingVertical: 15 },
  confirmText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
  cancelButton: { alignItems: 'center', borderColor: '#000000', borderWidth: 1, marginTop: 9, paddingVertical: 14 },
  cancelText: { color: '#000000', fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },
});

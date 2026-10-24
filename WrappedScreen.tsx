import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { getAvailablePeriods, getWrappedSummary, localDay, weekStart, type AvailablePeriods, type WrappedPeriod, type WrappedRank, type WrappedSummary } from './wrappedStore';

const TABS: { key: WrappedPeriod; label: string }[] = [
  { key: 'day', label: 'DAY' },
  { key: 'week', label: 'WEEK' },
  { key: 'month', label: 'MONTH' },
  { key: 'year', label: 'YEAR' },
  { key: 'all', label: 'ALL TIME' },
];

function initialPeriods(): AvailablePeriods {
  const today = localDay(new Date());
  return { day: [today], week: [weekStart(today)], month: [today.slice(0, 7)], year: [today.slice(0, 4)] };
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function periodLabel(period: WrappedPeriod, key: string): string {
  if (period === 'all') return 'ALL OF YOUR LISTENING';
  if (period === 'year') return key;
  if (period === 'month') {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();
  }
  const [year, month, day] = key.split('-').map(Number);
  const start = new Date(year, month - 1, day);
  if (period === 'day') return start.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
  const end = new Date(year, month - 1, day + 6);
  return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`.toUpperCase();
}

function RankedList({ title, entries, metric }: { title: string; entries: WrappedRank[]; metric: 'plays' | 'time' }) {
  return (
    <View style={styles.rankingSection}>
      <Text style={styles.sectionEyebrow}>TOP 5</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
      {entries.length ? entries.map((entry, index) => (
        <View key={`${entry.name}:${entry.artist}:${index}`} style={styles.rankRow}>
          <Text style={styles.rankNumber}>{String(index + 1).padStart(2, '0')}</Text>
          <View style={styles.rankCopy}>
            <Text style={styles.rankName} numberOfLines={1}>{entry.name}</Text>
            {metric === 'plays' ? <Text style={styles.rankSubline} numberOfLines={1}>{entry.artist}</Text> : null}
          </View>
          <Text style={styles.rankMetric}>{metric === 'plays' ? `${entry.plays} ${entry.plays === 1 ? 'play' : 'plays'}` : durationLabel(entry.listenedMs)}</Text>
        </View>
      )) : <Text style={styles.emptyRanking}>No plays in this period yet.</Text>}
    </View>
  );
}

export function WrappedScreen({ revision, onBack }: { revision: number; onBack: () => void }) {
  const [period, setPeriod] = useState<WrappedPeriod>('year');
  const [available, setAvailable] = useState<AvailablePeriods>(initialPeriods);
  const [selectedKeys, setSelectedKeys] = useState<Partial<Record<WrappedPeriod, string>>>({});
  const [summary, setSummary] = useState<WrappedSummary | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const choices = period === 'all' ? [] : available[period];
  const key = period === 'all' ? '*' : selectedKeys[period] ?? choices[0];
  const selectedIndex = choices.indexOf(key);

  useEffect(() => {
    let live = true;
    getAvailablePeriods().then((periods) => {
      if (live) setAvailable(periods);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [revision, retry]);

  useEffect(() => {
    let live = true;
    const requestedKey = `${period}:${key}`;
    setError(false);
    getWrappedSummary(period, key).then((data) => {
      if (live) {
        setSummary(data);
        setLoadedKey(requestedKey);
        setError(false);
      }
    }).catch(() => {
      if (live) setError(true);
    });
    return () => { live = false; };
  }, [key, period, retry, revision]);

  const heroLabel = useMemo(() => period === 'year' ? 'YOUR YEAR IN SOUND' : period === 'all' ? 'EVERY MOMENT COUNTS' : 'YOUR LISTENING', [period]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <View><Text style={styles.wordmark}>mp3fy</Text><Text style={styles.brandSubline}>WRAPPED</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to music" onPress={onBack} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}><Text style={styles.backText}>BACK</Text></Pressable>
      </View>

      <Text style={styles.pageTitle}>Your music, in numbers.</Text>
      <Text style={styles.pageIntro}>The songs and artists you have spent time with.</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {TABS.map((tab) => <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: period === tab.key }} onPress={() => setPeriod(tab.key)} style={[styles.tab, period === tab.key && styles.activeTab]}><Text style={[styles.tabText, period === tab.key && styles.activeTabText]}>{tab.label}</Text></Pressable>)}
      </ScrollView>

      {period !== 'all' ? <View style={styles.periodNavigation}>
        <Pressable accessibilityRole="button" disabled={selectedIndex >= choices.length - 1} onPress={() => setSelectedKeys((keys) => ({ ...keys, [period]: choices[selectedIndex + 1] }))} style={[styles.navButton, selectedIndex >= choices.length - 1 && styles.disabled]}><Text style={styles.navText}>‹ PREV</Text></Pressable>
        <Text style={styles.periodText} numberOfLines={1}>{periodLabel(period, key)}</Text>
        <Pressable accessibilityRole="button" disabled={selectedIndex <= 0} onPress={() => setSelectedKeys((keys) => ({ ...keys, [period]: choices[selectedIndex - 1] }))} style={[styles.navButton, selectedIndex <= 0 && styles.disabled]}><Text style={styles.navText}>NEXT ›</Text></Pressable>
      </View> : <Text style={styles.allTimeLabel}>{periodLabel(period, key)}</Text>}

      {error ? <View style={styles.messageCard}><Text style={styles.messageTitle}>Could not load your listening history.</Text><Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)}><Text style={styles.retryText}>TRY AGAIN</Text></Pressable></View> : !summary || loadedKey !== `${period}:${key}` ? <View style={styles.loading}><ActivityIndicator color="#000000" /><Text style={styles.loadingText}>Loading your Wrapped...</Text></View> : <>
        <View style={styles.hero}>
          <Text style={styles.heroEyebrow}>{heroLabel}</Text>
          <Text style={styles.heroDuration}>{durationLabel(summary.listenedMs)}</Text>
          <Text style={styles.heroCaption}>OF MUSIC LISTENED</Text>
          {period === 'year' ? <Text style={styles.heroNote}>A living recap of {key}. It updates as you listen.</Text> : null}
        </View>

        <View style={styles.winners}>
          <View style={styles.winnerCard}><Text style={styles.winnerEyebrow}>MOST LISTENED ARTIST</Text><Text style={styles.winnerName} numberOfLines={2}>{summary.artists[0]?.name ?? 'Your first artist awaits'}</Text><Text style={styles.winnerMetric}>{summary.artists[0] ? durationLabel(summary.artists[0].listenedMs) : 'Start listening'}</Text></View>
          <View style={styles.winnerCard}><Text style={styles.winnerEyebrow}>MOST PLAYED SONG</Text><Text style={styles.winnerName} numberOfLines={2}>{summary.songs[0]?.name ?? 'Your first song awaits'}</Text><Text style={styles.winnerMetric}>{summary.songs[0] ? `${summary.songs[0].plays} ${summary.songs[0].plays === 1 ? 'play' : 'plays'}` : '30 seconds counts as a play'}</Text></View>
        </View>

        <RankedList title="Artists" entries={summary.artists} metric="time" />
        <RankedList title="Songs" entries={summary.songs} metric="plays" />

        <View style={styles.milestones}>
          <Text style={styles.sectionEyebrow}>THE BIG PICTURE</Text>
          <Text style={styles.sectionTitle}>Your milestones</Text>
          <View style={styles.milestoneRow}><Text style={styles.milestoneLabel}>ALL-TIME LISTENING</Text><Text style={styles.milestoneValue}>{durationLabel(summary.allTimeMs)}</Text></View>
          <View style={styles.milestoneRow}><View><Text style={styles.milestoneLabel}>LONGEST DAY</Text><Text style={styles.milestoneDetail}>{summary.longestDay ? periodLabel('day', summary.longestDay.period) : 'No listening yet'}</Text></View><Text style={styles.milestoneValue}>{summary.longestDay ? durationLabel(summary.longestDay.listenedMs) : '—'}</Text></View>
          <View style={styles.milestoneRow}><View><Text style={styles.milestoneLabel}>BIGGEST MONTH</Text><Text style={styles.milestoneDetail}>{summary.longestMonth ? periodLabel('month', summary.longestMonth.period) : 'No listening yet'}</Text></View><Text style={styles.milestoneValue}>{summary.longestMonth ? durationLabel(summary.longestMonth.listenedMs) : '—'}</Text></View>
        </View>
        <Text style={styles.footnote}>A play is counted after 30 seconds of listening. Time reflects actual playback, including listens shorter than 30 seconds. Daily and weekly song rankings cover recent listening; monthly, yearly and all-time rankings remain available.</Text>
      </>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#FFFFFF', flex: 1 },
  content: { paddingBottom: 32 },
  header: { alignItems: 'flex-end', borderBottomColor: '#000000', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, paddingTop: 10 },
  wordmark: { color: '#000000', fontSize: 30, fontWeight: '700', letterSpacing: -1 },
  brandSubline: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 },
  backButton: { borderColor: '#000000', borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10 },
  backText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  pressed: { opacity: 0.6 },
  pageTitle: { color: '#000000', fontSize: 27, fontWeight: '700', letterSpacing: -0.8, marginTop: 22 },
  pageIntro: { color: '#555555', fontSize: 13, marginTop: 5 },
  tabs: { gap: 7, paddingTop: 22, paddingBottom: 10 },
  tab: { borderColor: '#000000', borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  activeTab: { backgroundColor: '#000000' },
  tabText: { color: '#000000', fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  activeTabText: { color: '#FFFFFF' },
  periodNavigation: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12, marginTop: 7 },
  navButton: { minWidth: 58, paddingVertical: 7 },
  navText: { color: '#000000', fontSize: 10, fontWeight: '700' },
  disabled: { opacity: 0.28 },
  periodText: { color: '#000000', flex: 1, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textAlign: 'center' },
  allTimeLabel: { color: '#000000', fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 12, marginTop: 15, textAlign: 'center' },
  loading: { alignItems: 'center', justifyContent: 'center', minHeight: 240 },
  loadingText: { color: '#555555', fontSize: 12, marginTop: 12 },
  messageCard: { borderColor: '#000000', borderWidth: 1, padding: 20 },
  messageTitle: { color: '#000000', fontSize: 15, fontWeight: '700' },
  retryText: { color: '#000000', fontSize: 11, fontWeight: '700', marginTop: 15 },
  hero: { backgroundColor: '#000000', minHeight: 220, padding: 23 },
  heroEyebrow: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  heroDuration: { color: '#FFFFFF', fontSize: 48, fontWeight: '700', letterSpacing: -2, marginTop: 24 },
  heroCaption: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 6 },
  heroNote: { color: '#CCCCCC', fontSize: 11, lineHeight: 16, marginTop: 20 },
  winners: { gap: 10, marginTop: 10 },
  winnerCard: { borderColor: '#000000', borderWidth: 1, minHeight: 126, padding: 18 },
  winnerEyebrow: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  winnerName: { color: '#000000', fontSize: 22, fontWeight: '700', lineHeight: 27, marginTop: 10 },
  winnerMetric: { color: '#555555', fontSize: 12, marginTop: 8 },
  rankingSection: { marginTop: 30 },
  sectionEyebrow: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  sectionTitle: { color: '#000000', fontSize: 23, fontWeight: '700', marginBottom: 9, marginTop: 4 },
  rankRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', minHeight: 66, paddingVertical: 10 },
  rankNumber: { color: '#000000', fontSize: 18, fontWeight: '700', width: 39 },
  rankCopy: { flex: 1, minWidth: 0 },
  rankName: { color: '#000000', fontSize: 14, fontWeight: '700' },
  rankSubline: { color: '#666666', fontSize: 11, marginTop: 4 },
  rankMetric: { color: '#000000', fontSize: 11, fontWeight: '700', marginLeft: 8 },
  emptyRanking: { color: '#666666', fontSize: 12, paddingVertical: 22 },
  milestones: { marginTop: 32 },
  milestoneRow: { alignItems: 'center', borderBottomColor: '#DDDDDD', borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 67, paddingVertical: 11 },
  milestoneLabel: { color: '#000000', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  milestoneDetail: { color: '#666666', fontSize: 10, marginTop: 4 },
  milestoneValue: { color: '#000000', fontSize: 16, fontWeight: '700', marginLeft: 10 },
  footnote: { color: '#666666', fontSize: 11, lineHeight: 17, marginTop: 24 },
});

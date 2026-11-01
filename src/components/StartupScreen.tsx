import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { styles } from '../styles/appStyles';

type StartupScreenProps = {
  iconsLoaded: boolean;
  libraryReady: boolean;
  backupReady: boolean;
  backupBusy: boolean;
  backupMessage: string;
  onSelectBackup: () => void;
};

export function StartupScreen({ iconsLoaded, libraryReady, backupReady, backupBusy, backupMessage, onSelectBackup }: StartupScreenProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const [trackWidth, setTrackWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const needsBackup = iconsLoaded && libraryReady && !backupReady && !backupBusy;
  const status = !iconsLoaded ? 'Loading interface…' : !libraryReady ? 'Loading library…' : 'Checking Wrapped backup…';

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (mounted) setReduceMotion(enabled); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (reduceMotion || needsBackup) return;
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 1,
      duration: 1500,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
      isInteraction: false,
    }));
    progress.setValue(0);
    animation.start();
    return () => animation.stop();
  }, [needsBackup, progress, reduceMotion]);

  return <View style={startupStyles.screen}>
    <View style={startupStyles.content}>
      <Text style={startupStyles.wordmark}>mp3fy</Text>
      {needsBackup ? <View style={startupStyles.backup}>
        <Text style={startupStyles.backupTitle}>Choose a Wrapped backup folder</Text>
        <Text style={startupStyles.backupDescription}>mp3fy keeps one required Wrapped backup file in this folder. Select the same folder after reinstalling to restore your listening history.</Text>
        <Pressable accessibilityRole="button" onPress={onSelectBackup} style={({ pressed }) => [styles.button, startupStyles.backupButton, pressed && styles.pressed]}><Text style={styles.buttonText}>SELECT BACKUP FOLDER</Text></Pressable>
        {backupMessage ? <Text style={styles.notice}>{backupMessage}</Text> : null}
      </View> : <View style={startupStyles.loading}>
        <Text accessibilityLiveRegion="polite" numberOfLines={1} style={startupStyles.status}>{status}</Text>
        <View accessibilityRole="progressbar" accessibilityLabel="Starting mp3fy" accessibilityValue={{ text: status }} onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)} style={startupStyles.track}>
          <Animated.View style={[startupStyles.segment, { transform: [{ translateX: reduceMotion ? 0 : progress.interpolate({ inputRange: [0, 1], outputRange: [-trackWidth * 0.34, trackWidth] }) }] }]} />
        </View>
      </View>}
    </View>
  </View>;
}

const startupStyles = StyleSheet.create({
  screen: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  content: { maxWidth: 340, width: '100%' },
  wordmark: { color: '#000000', fontSize: 40, fontWeight: '700', letterSpacing: -1.5, marginBottom: 38 },
  loading: { width: '100%' },
  status: { color: '#555555', fontSize: 13, height: 22, lineHeight: 22, marginBottom: 12 },
  track: { backgroundColor: '#EAEAEA', height: 4, overflow: 'hidden', width: '100%' },
  segment: { backgroundColor: '#000000', height: '100%', width: '34%' },
  backup: { width: '100%' },
  backupTitle: { color: '#000000', fontSize: 21, fontWeight: '700' },
  backupDescription: { color: '#444444', fontSize: 15, lineHeight: 22, marginTop: 12 },
  backupButton: { alignSelf: 'flex-start', marginTop: 20 },
});

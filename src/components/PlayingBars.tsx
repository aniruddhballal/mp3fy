import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

export function PlayingBars({ playing, compact = false }: { playing: boolean; compact?: boolean }) {
  const bars = useRef([new Animated.Value(0.45), new Animated.Value(0.85), new Animated.Value(0.6)]).current;
  useEffect(() => {
    if (!playing) {
      bars.forEach((bar) => bar.setValue(0.35));
      return;
    }
    const animations = bars.map((bar, index) => Animated.loop(Animated.sequence([
      Animated.timing(bar, { toValue: index === 1 ? 0.3 : 1, duration: 260 + index * 80, useNativeDriver: true, isInteraction: false }),
      Animated.timing(bar, { toValue: index === 1 ? 1 : 0.3, duration: 330 + index * 70, useNativeDriver: true, isInteraction: false }),
    ])));
    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
  }, [bars, playing]);
  return <View accessibilityLabel={playing ? 'Playing' : 'Paused'} style={[styles.bars, compact && styles.compactBars]}>{bars.map((bar, index) => <Animated.View key={index} style={[styles.bar, compact && styles.compactBar, { transform: [{ scaleY: bar }] }]} />)}</View>;
}

const styles = StyleSheet.create({
  bars: { alignItems: 'center', flexDirection: 'row', gap: 3, height: 28, justifyContent: 'center', marginRight: 14, width: 30 },
  bar: { backgroundColor: '#000000', height: 24, width: 5 },
  compactBars: { gap: 2, height: 24, marginRight: 12, width: 18 },
  compactBar: { height: 17, width: 3 },
});

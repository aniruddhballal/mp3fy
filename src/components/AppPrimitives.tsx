import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, Text, View } from 'react-native';
import { APP_VERSION } from '../config/appVersion';
import { styles } from '../styles/appStyles';

const MARQUEE_FADE_WIDTH = 28;

export function ActionButton({ label, onPress, secondary = false, transport = false }: { label: string; onPress: () => void; secondary?: boolean; transport?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, transport && styles.transportMainButton, secondary && styles.secondaryButton, pressed && styles.pressed]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

export function SmallButton({ label, onPress, active = false, transport = false }: { label: string; onPress: () => void; active?: boolean; transport?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.smallButton, transport && styles.transportSideButton, active && styles.activeSmallButton, pressed && styles.pressed]}>
      <Text style={[styles.smallButtonText, active && styles.activeSmallButtonText]}>{label}</Text>
    </Pressable>
  );
}

export const AlbumArt = memo(function AlbumArt({ uri, size, label, loading = false }: { uri: string | null; size: number; label: string; loading?: boolean }) {
  return uri ? <Image accessibilityLabel={`Album artwork for ${label}`} source={{ uri }} style={{ height: size, width: size }} /> : (
    <View style={[styles.artPlaceholder, { height: size, width: size }]}>
      {loading ? <><ActivityIndicator color="#000000" /><Text style={styles.artLoadingText}>LOADING ARTWORK</Text></> : <Text style={styles.artPlaceholderText}>mp3fy</Text>}
    </View>
  );
});

export function MarqueeText({ text, textStyle, style, alignRight = false, fadeColor = '#FFFFFF', fadeTransparentColor = 'rgba(255,255,255,0)' }: { text: string; textStyle: object; style?: object; alignRight?: boolean; fadeColor?: string; fadeTransparentColor?: string }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);

  useEffect(() => {
    setTextWidth(0);
  }, [text]);

  useEffect(() => {
    animation.current?.stop();
    translateX.setValue(0);
    if (containerWidth > 0 && textWidth > containerWidth + 1) {
      const distance = textWidth - containerWidth;
      animation.current = Animated.loop(Animated.sequence([
        Animated.delay(1000),
        Animated.timing(translateX, { duration: Math.max(1400, distance * 28), toValue: -distance, useNativeDriver: true }),
        Animated.delay(800),
        Animated.timing(translateX, { duration: Math.max(1400, distance * 28), toValue: 0, useNativeDriver: true }),
        Animated.delay(1000),
      ]));
      animation.current.start();
    }
    return () => animation.current?.stop();
  }, [containerWidth, text, textWidth, translateX]);

  const marqueeDistance = Math.max(0, textWidth - containerWidth);

  return (
    <View onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)} style={[styles.marqueeViewport, style]}>
      <Animated.View style={[styles.marqueeContent, { transform: [{ translateX }], width: Math.max(containerWidth, textWidth) }]}> 
        <Text numberOfLines={1} ellipsizeMode="clip" style={[textStyle, styles.marqueeText, { textAlign: alignRight && textWidth <= containerWidth ? 'right' : 'left', width: Math.max(containerWidth, textWidth) }]}>{text}</Text>
      </Animated.View>
      {containerWidth > 0 && textWidth > containerWidth + 1 ? <>
        <Animated.View pointerEvents="none" style={[styles.marqueeFade, styles.marqueeFadeLeft, { opacity: translateX.interpolate({ inputRange: [-8, 0], outputRange: [1, 0], extrapolate: 'clamp' }) }]}>
          <LinearGradient colors={[fadeColor, fadeTransparentColor]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.marqueeFadeGradient} />
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.marqueeFade, styles.marqueeFadeRight, { opacity: translateX.interpolate({ inputRange: [-marqueeDistance, -Math.max(0, marqueeDistance - MARQUEE_FADE_WIDTH)], outputRange: [0, 1], extrapolate: 'clamp' }) }]}>
          <LinearGradient colors={[fadeTransparentColor, fadeColor]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={styles.marqueeFadeGradient} />
        </Animated.View>
      </> : null}
      <Text onTextLayout={(event) => {
        const width = event.nativeEvent.lines.reduce((largest, line) => Math.max(largest, line.width), 0);
        if (width > 0 && width !== textWidth) setTextWidth(Math.ceil(width));
      }} style={[textStyle, styles.marqueeMeasure]}>{text}</Text>
    </View>
  );
}


export function ScreenHeader({ right }: { right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerMain}>
        <Text style={styles.wordmark}>mp3fy</Text>
        <Text style={styles.label}>{APP_VERSION}</Text>
      </View>
      {right ?? null}
    </View>
  );
}

export function WrappedButton({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Open Wrapped" onPress={onPress} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="timer-sand" size={21} color="#000000" /></Pressable>;
}

export function QueueButton({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Open queue" onPress={onPress} style={({ pressed }) => [styles.headerIconButton, pressed && styles.pressed]}><MaterialCommunityIcons name="playlist-music" size={22} color="#000000" /></Pressable>;
}

export function FolderArtwork({ uri }: { uri?: string | null }) {
  return uri ? <Image source={{ uri }} style={styles.folderArtwork} /> : <View style={styles.folderArtworkPlaceholder}><Text style={styles.folderArtworkPlaceholderText}>DIR</Text></View>;
}



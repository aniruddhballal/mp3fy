import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

export default function App() {
  const [notice, setNotice] = useState('No folders have been selected.');

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />

      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>mp3fy</Text>
          <Text style={styles.label}>LOCAL AUDIO LIBRARY</Text>
        </View>

        <View style={styles.main}>
          <View style={styles.rule} />
          <Text style={styles.title}>No folders selected</Text>
          <Text style={styles.description}>
            Select folders containing your MP3 files to view them in one place.
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={() => setNotice('Folder selection will be available in the next build.')}
            style={({ pressed }: { pressed: boolean }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>Add folder</Text>
          </Pressable>

          <Text style={styles.notice}>{notice}</Text>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>READ-ONLY MP3 BROWSER</Text>
          <Text style={styles.footerText}>BUILD 01</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  header: {
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
    paddingBottom: 16,
  },
  wordmark: {
    color: '#000000',
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -1,
  },
  label: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 6,
  },
  main: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  rule: {
    backgroundColor: '#000000',
    height: 4,
    marginBottom: 24,
    width: 48,
  },
  title: {
    color: '#000000',
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  description: {
    color: '#000000',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 12,
    maxWidth: 320,
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#000000',
    marginTop: 28,
    minWidth: 140,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  notice: {
    color: '#000000',
    fontSize: 13,
    lineHeight: 20,
    marginTop: 18,
    maxWidth: 320,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#000000',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
  },
  footerText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
});

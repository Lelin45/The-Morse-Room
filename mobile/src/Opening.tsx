import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import timing from '../generated/welcome-timing.json';

type OpeningProps = { dark: boolean; volume: number; preferencesReady: boolean; visible: boolean; loadFailed: boolean; onFinish: () => void };

export default function Opening({ dark, volume, preferencesReady, visible, loadFailed, onFinish }: OpeningProps) {
  // The WAV is bundled with the app, so it can load directly without an asset download.
  const player = useAudioPlayer(require('../assets/welcome.wav'), { updateInterval: 40 });
  const status = useAudioPlayerStatus(player);
  const [fade] = useState(() => new Animated.Value(1));
  const [pulse] = useState(() => new Animated.Value(0.45));
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [appState, setAppState] = useState(() => AppState.currentState);
  const finished = useRef(false);
  const started = useRef(false);
  const accent = dark ? '#34f58c' : '#217044';
  const color = dark ? '#e2f7e8' : '#123226';

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    try { player.pause(); } catch { /* Unavailable audio still allows entry. */ }
    Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }).start(onFinish);
  }, [fade, onFinish, player]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppState(state);
      // Startup can report null or inactive before the Activity becomes active.
      // An actual background transition after requesting playback ends the welcome.
      if (state === 'background' && visible && started.current) finish();
    });
    return () => subscription.remove();
  }, [finish, visible]);

  useEffect(() => {
    if (!visible || !preferencesReady || appState !== 'active' || finished.current) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.45, duration: 350, useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [visible, preferencesReady, appState, pulse]);

  useEffect(() => {
    // Expo Audio exposes native volume through this documented setter.
    // eslint-disable-next-line react-hooks/immutability
    player.volume = Math.max(0, Math.min(1, volume / 100));
  }, [player, volume]);
  useEffect(() => {
    if (!visible || preferencesReady || appState !== 'active' || finished.current) return;
    // A failed WebView must not emit a default sound over a saved mute setting.
    const timeout = setTimeout(finish, 15000);
    return () => clearTimeout(timeout);
  }, [visible, preferencesReady, appState, finish]);
  useEffect(() => { if (visible && loadFailed) finish(); }, [visible, loadFailed, finish]);
  useEffect(() => {
    if (!visible || !preferencesReady || loadFailed || appState !== 'active' || !status.isLoaded || started.current || finished.current) return;
    let active = true;
    // Android's silent/vibrate ringer must not suppress media with media volume on.
    // System media volume and the saved trainer mute still apply.
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true,
      shouldPlayInBackground: false, shouldRouteThroughEarpiece: false, interruptionMode: 'duckOthers' }).then(() => {
      if (active && !started.current && !finished.current && AppState.currentState === 'active') {
        started.current = true;
        player.play();
      }
    }).catch(() => { /* The bounded animation continues if audio is unavailable. */ });
    return () => { active = false; };
  }, [visible, preferencesReady, loadFailed, appState, status.isLoaded, player]);
  useEffect(() => {
    if (started.current && !finished.current && (status.playing || status.currentTime > 0)) setPlaybackStarted(true);
  }, [status.playing, status.currentTime]);
  useEffect(() => {
    if (!visible || !preferencesReady || appState !== 'active' || playbackStarted || finished.current) return;
    // Wait for native playback confirmation, not just a synchronous play request.
    // Cold launches on slower devices can take longer than the old two-second limit.
    const timeout = setTimeout(finish, 10000);
    return () => clearTimeout(timeout);
  }, [visible, preferencesReady, appState, playbackStarted, finish]);
  useEffect(() => {
    if (!playbackStarted || finished.current) return;
    const maximum = setTimeout(finish, (timing.duration + 2) * 1000);
    return () => clearTimeout(maximum);
  }, [playbackStarted, finish]);
  useEffect(() => { if (playbackStarted && status.didJustFinish) finish(); }, [playbackStarted, status.didJustFinish, finish]);

  const elapsed = status.currentTime;
  return <Animated.View style={[styles.overlay, { backgroundColor: dark ? '#000000' : '#f7f6f2', opacity: fade }]}>
    <Animated.View style={[styles.mark, { opacity: pulse, transform: [{ scale: pulse.interpolate({ inputRange: [0.45, 1], outputRange: [0.96, 1.02] }) }] }]}>
      <View style={[styles.dit, { backgroundColor: accent }]} />
      <View style={[styles.dah, { backgroundColor: accent }]} />
    </Animated.View>
    <Text style={[styles.title, { color }]}>Morse Code Nepal</Text>
    <View style={styles.letters} accessibilityLabel="Welcome in Morse code">
      {timing.letters.map((entry, index) => <View key={index} style={styles.letter}>
        <Text style={[styles.character, { color: accent, opacity: elapsed >= entry.start ? 1 : 0.72 }]}>{entry.letter}</Text>
        <Text style={[styles.morse, { color, opacity: elapsed >= entry.start ? 1 : 0.82 }]}>{['.--', '.', '.-..', '-.-.', '---', '--', '.'][index]}</Text>
      </View>)}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Skip welcome and open trainer" onPress={finish}
      style={({ pressed }) => [styles.skip, { opacity: pressed ? 0.65 : 1 }]}>
      <Text style={[styles.skipText, { color }]}>Skip</Text>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 19, marginBottom: 32 },
  dit: { width: 25, height: 25, borderRadius: 14 },
  dah: { width: 76, height: 25, borderRadius: 14 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 38 },
  letters: { flexDirection: 'row', gap: 3, width: '100%', maxWidth: 350, paddingHorizontal: 12 },
  letter: { alignItems: 'center', flex: 1, minWidth: 0 },
  character: { fontSize: 28, fontWeight: '600' },
  morse: { fontSize: 15, fontWeight: '600', marginTop: 9, letterSpacing: 0, fontVariant: ['tabular-nums'] },
  skip: { position: 'absolute', right: 18, bottom: 28, minHeight: 48, minWidth: 64, justifyContent: 'center', alignItems: 'center' },
  skipText: { fontSize: 14 },
});

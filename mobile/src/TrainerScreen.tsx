import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import * as SplashScreen from 'expo-splash-screen';
import html from '../generated/trainer-html';
import Opening from './Opening';
import { useChatNotifications } from './use-chat-notifications';
import { AUTH_RETURN_URL, SITE_URL, PENDING_AUTH_KEY, base64URL, finishAuthScript, navigationAction, parseAuthCallback, readPendingAuth } from './auth-utils';
import { AUDIO_PREFERENCES_KEY, readAudioPreferences, withAudioPreferences, createAudioPreferenceWriter } from './audio-preferences';
import { effectiveAudio } from '../generated/audio-settings';
import { nativeNotifications } from './notifications-native';
import { useRadioBridge } from './use-radio-bridge';

void SplashScreen.preventAutoHideAsync().catch(() => { /* A development shell may already be visible. */ });
WebBrowser.maybeCompleteAuthSession();
type AudioPreferences = NonNullable<ReturnType<typeof readAudioPreferences>>;
const trainerSource = (preferences: AudioPreferences | null) => ({ html: withAudioPreferences(html, preferences), baseUrl: SITE_URL });
const dispatch = (name: string) => `window.dispatchEvent(new CustomEvent(${JSON.stringify(name)})); true;`;
type Pending = NonNullable<ReturnType<typeof readPendingAuth>>;

export default function TrainerScreen() {
  const webview = useRef<WebView>(null);
  const handleRadioMessage = useRadioBridge(webview);
  const ready = useRef(false);
  const pending = useRef<Pending | null>(null);
  const exchangeRunning = useRef(false);
  const authRunning = useRef(false);
  const authRestoring = useRef(true);
  const callbackRunning = useRef(false);
  const completedState = useRef<string | null>(null);
  const backWaiting = useRef(false);
  const backTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const splashHideRequested = useRef(false);
  const audioPreferences = useRef<AudioPreferences | null>(null);
  const saveAudioPreferences = useRef(createAudioPreferenceWriter(async (value: string) => {
    await SecureStore.setItemAsync(AUDIO_PREFERENCES_KEY, value).catch(() => {});
    const profile = readAudioPreferences(value);
    if (profile) await nativeNotifications.updateAudioSettingsAsync(effectiveAudio(profile));
  }));
  const [source, setSource] = useState<ReturnType<typeof trainerSource> | null>(null);
  const [dark, setDark] = useState(true);
  const [volume, setVolume] = useState(50);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [splashHidden, setSplashHidden] = useState(false);
  const [opening, setOpening] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [generation, setGeneration] = useState(0);
  const { handleMessage: handleNotificationMessage, clear: clearNotificationAccount } = useChatNotifications({ webview, visible: !opening, ready: !loading && !failure });
  const background = dark ? '#000000' : '#f7f6f2';
  const foreground = dark ? '#d5f8df' : '#123226';

  useEffect(() => {
    let active = true;
    // Restore before the trainer starts so an old WebView snapshot cannot
    // replace the profile the user saved in the installed app.
    void SecureStore.getItemAsync(AUDIO_PREFERENCES_KEY).then((saved) => {
      if (active) audioPreferences.current = readAudioPreferences(saved);
    }).catch(() => { /* Existing WebView preferences remain the upgrade fallback. */ })
      .finally(() => { if (active) setSource(trainerSource(audioPreferences.current)); });
    return () => { active = false; };
  }, []);

  const flushExchange = useCallback(() => {
    if (!ready.current || exchangeRunning.current || !pending.current?.code) return;
    exchangeRunning.current = true;
    setSigningIn(true);
    webview.current?.injectJavaScript(finishAuthScript(pending.current.code, pending.current.verifier));
  }, []);

  const receiveCallback = useCallback(async (url: string) => {
    if (callbackRunning.current || exchangeRunning.current) return;
    callbackRunning.current = true;
    let saved: Pending | null = null;
    try {
      const returnedState = new URL(url).searchParams.get('state');
      if (returnedState && returnedState === completedState.current) return;
      saved = readPendingAuth(await SecureStore.getItemAsync(PENDING_AUTH_KEY));
      if (!saved) throw new Error('Sign-in expired. Please sign in again.');
      // A delayed return from an earlier attempt must not cancel a newer one.
      if (returnedState !== saved.state) return;
      const result = parseAuthCallback(url, saved.state);
      pending.current = { ...saved, code: result.code };
      await SecureStore.setItemAsync(PENDING_AUTH_KEY, JSON.stringify(pending.current));
      flushExchange();
    } catch (error) {
      if (!saved) {
        await SecureStore.deleteItemAsync(PENDING_AUTH_KEY).catch(() => {});
        pending.current = null;
      }
      setSigningIn(false);
      Alert.alert('Sign in', error instanceof Error ? error.message : 'Please try signing in again.');
    } finally { callbackRunning.current = false; }
  }, [flushExchange]);

  const signIn = useCallback(async () => {
    if (authRestoring.current || authRunning.current || callbackRunning.current || exchangeRunning.current) return;
    authRunning.current = true;
    setSigningIn(true);
    try {
      const verifier = base64URL(Crypto.getRandomBytes(32));
      const state = base64URL(Crypto.getRandomBytes(32));
      const encoded = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.BASE64 });
      const challenge = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const flow = { verifier, state, createdAt: Date.now() };
      await SecureStore.setItemAsync(PENDING_AUTH_KEY, JSON.stringify(flow));
      pending.current = flow;
      const url = new URL('/api/auth/google', SITE_URL);
      url.searchParams.set('mobile_challenge', challenge);
      url.searchParams.set('mobile_state', state);
      const result = await WebBrowser.openAuthSessionAsync(url.href, AUTH_RETURN_URL);
      if (result.type === 'success') await receiveCallback(result.url);
      else if (!exchangeRunning.current && !callbackRunning.current && !pending.current?.code) {
        // Android can report browser dismissal before delivering its return
        // link. Keep the short-lived proof until the link arrives or it expires.
        setSigningIn(false);
      }
    } catch {
      setSigningIn(false);
      Alert.alert('Sign in', 'Google sign-in could not open. Check your connection and try again.');
    } finally { authRunning.current = false; }
  }, [receiveCallback]);

  useEffect(() => {
    const listener = Linking.addEventListener('url', ({ url }) => {
      if (navigationAction(url) === 'auth-return') void receiveCallback(url);
    });
    let active = true;
    void (async () => {
      const initialURL = await Linking.getInitialURL();
      if (!active) return;
      if (initialURL && navigationAction(initialURL) === 'auth-return') await receiveCallback(initialURL);
      else {
        const restored = readPendingAuth(await SecureStore.getItemAsync(PENDING_AUTH_KEY));
        // A return link may have already supplied the code while storage loaded.
        if (!pending.current) pending.current = restored;
        if (pending.current?.code) flushExchange();
        else if (!pending.current) await SecureStore.deleteItemAsync(PENDING_AUTH_KEY);
      }
    })().catch(() => { /* Sign-in remains available if storage could not be restored. */ })
      .finally(() => { authRestoring.current = false; });
    return () => { active = false; listener.remove(); };
  }, [receiveCallback, flushExchange]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') webview.current?.injectJavaScript(dispatch('morse-native-background'));
    });
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (opening) { setOpening(false); return true; }
      if (failure) return false;
      if (backWaiting.current) return true;
      backWaiting.current = true;
      webview.current?.injectJavaScript(dispatch('morse-native-back'));
      backTimeout.current = setTimeout(() => { backWaiting.current = false; BackHandler.exitApp(); }, 1000);
      return true;
    });
    return () => { subscription.remove(); back.remove(); if (backTimeout.current) clearTimeout(backTimeout.current); };
  }, [failure, opening]);

  const message = useCallback((event: WebViewMessageEvent) => {
    if (event.nativeEvent.data.length > 16384) return;
    try {
      const value = JSON.parse(event.nativeEvent.data);
      if (handleRadioMessage(value)) return;
      if (event.nativeEvent.data.length > 2048) return;
      if (handleNotificationMessage(value)) return;
      if (value.type === 'audio-settings') {
        const settings = readAudioPreferences(value.settings);
        if (!settings) return;
        audioPreferences.current = settings;
        setVolume(settings.volume);
        void saveAudioPreferences.current(settings);
      } else if (value.type === 'ready' || value.type === 'morse-native-ready') {
        ready.current = true; setLoading(false); setFailure(false); flushExchange();
        if (value.type === 'morse-native-ready') {
          if (value.theme === 'dark' || value.theme === 'light') {
            setDark(value.theme === 'dark');
            void nativeNotifications.updateThemeAsync(value.theme).catch(() => {});
          }
          if (Number.isFinite(value.volume)) setVolume(Math.max(0, Math.min(100, value.volume * 100)));
          setPreferencesReady(true);
        }
      } else if (value.type === 'theme' || value.type === 'preferences') {
        if (typeof value.dark === 'boolean') {
          setDark(value.dark);
          void nativeNotifications.updateThemeAsync(value.dark ? 'dark' : 'light').catch(() => {});
        }
        if (value.type === 'preferences' && Number.isFinite(value.volume)) setVolume(Math.max(0, Math.min(100, value.volume)));
      } else if (value.type === 'sign-in') void signIn();
      else if (value.type === 'morse-native-auth-cleared') {
        clearNotificationAccount();
        pending.current = null; exchangeRunning.current = false; setSigningIn(false);
        void SecureStore.deleteItemAsync(PENDING_AUTH_KEY);
      }
      else if (value.type === 'auth-finish') {
        completedState.current = pending.current?.state || null;
        exchangeRunning.current = false; pending.current = null; setSigningIn(false);
        void SecureStore.deleteItemAsync(PENDING_AUTH_KEY);
        if (value.ok !== true) Alert.alert('Sign in', 'Sign-in could not finish. Check your connection and sign in again.');
      } else if (value.type === 'back') {
        if (backTimeout.current) clearTimeout(backTimeout.current);
        backWaiting.current = false;
        if (value.handled !== true) BackHandler.exitApp();
      }
    } catch { /* Discard unrecognized bridge messages. */ }
  }, [flushExchange, signIn, handleNotificationMessage, clearNotificationAccount, handleRadioMessage]);

  const openBrowser = useCallback((url: string) => {
    void (url.startsWith('mailto:') ? Linking.openURL(url) : WebBrowser.openBrowserAsync(url))
      .catch(() => Alert.alert('Open link', 'This link could not open on your device.'));
  }, []);
  const navigate = useCallback((request: ShouldStartLoadRequest) => {
    if (request.isTopFrame === false) return false;
    const action = navigationAction(request.url);
    if (action === 'allow') return true;
    if (action === 'sign-in') void signIn();
    else if (action === 'auth-return') void receiveCallback(request.url);
    else if (action === 'home') webview.current?.injectJavaScript("document.querySelector('[data-mode=learn]')?.click(); true;");
    else if (action === 'browser') openBrowser(request.url);
    return false;
  }, [openBrowser, receiveCallback, signIn]);
  const reload = useCallback(() => {
    ready.current = false; exchangeRunning.current = false;
    setSource(trainerSource(audioPreferences.current));
    setFailure(false); setLoading(true); setGeneration((value) => value + 1);
  }, []);
  const loadFailure = useCallback(() => { ready.current = false; setFailure(true); setLoading(false); }, []);
  const finishOpening = useCallback(() => setOpening(false), []);
  const hideSplash = useCallback(() => {
    if (splashHideRequested.current) return;
    splashHideRequested.current = true;
    void SplashScreen.hideAsync().then(() => {
      requestAnimationFrame(() => setSplashHidden(true));
    }).catch(() => { setSplashHidden(true); });
  }, []);

  return <SafeAreaView style={[styles.screen, { backgroundColor: background }]} edges={['top', 'bottom', 'left', 'right']}
    onLayout={hideSplash}>
    <StatusBar style={dark ? 'light' : 'dark'} />
    <KeyboardAvoidingView style={styles.content} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {source && <WebView key={generation} ref={webview} source={source} style={{ backgroundColor: background }}
        originWhitelist={['*']} onShouldStartLoadWithRequest={navigate} onMessage={message}
        onOpenWindow={({ nativeEvent }) => {
          const action = navigationAction(nativeEvent.targetUrl);
          if (action === 'sign-in') void signIn();
          else if (action === 'browser') openBrowser(nativeEvent.targetUrl);
        }}
        javaScriptEnabled domStorageEnabled mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback mixedContentMode="never" allowFileAccess={false}
        allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        thirdPartyCookiesEnabled={false} setSupportMultipleWindows={false}
        textZoom={100} overScrollMode="never" bounces={false}
        webviewDebuggingEnabled={__DEV__} applicationNameForUserAgent="MorseCodeNepal/1.0"
        onLoadEnd={() => { setLoading(false); }} onError={loadFailure}
        onRenderProcessGone={loadFailure} onContentProcessDidTerminate={loadFailure}
        keyboardDisplayRequiresUserAction={false}
        contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false} />}
      {loading && !opening && !failure && <View style={[styles.overlay, { backgroundColor: background }]}><ActivityIndicator color={dark ? '#34f58c' : '#217044'} /></View>}
      {failure && <View style={[styles.overlay, { backgroundColor: background }]}>
        <Text style={[styles.failureTitle, { color: foreground }]}>Open your trainer again</Text>
        <Text style={[styles.failureCopy, { color: foreground }]}>Your saved progress stays on this device.</Text>
        <Pressable style={styles.retry} accessibilityRole="button" onPress={reload}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>}
      {signingIn && !opening && !failure && <View style={[styles.authNotice, { backgroundColor: background }]} accessibilityLiveRegion="polite">
        <ActivityIndicator size="small" color={dark ? '#34f58c' : '#217044'} /><Text style={{ color: foreground, fontSize: 13 }}>Completing sign-in...</Text>
      </View>}
      {opening && <Opening dark={dark} volume={volume} preferencesReady={preferencesReady}
        visible={splashHidden} loadFailed={failure} onFinish={finishOpening} />}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, content: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center', padding: 24 },
  failureTitle: { fontSize: 20, fontWeight: '600', marginBottom: 12 },
  failureCopy: { fontSize: 14, textAlign: 'center', marginBottom: 24 },
  retry: { minHeight: 48, justifyContent: 'center', borderRadius: 25, paddingHorizontal: 26, backgroundColor: '#217044' },
  retryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  authNotice: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 10, alignItems: 'center', padding: 12 },
});

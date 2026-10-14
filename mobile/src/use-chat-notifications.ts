import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Alert, AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { WebView } from 'react-native-webview';
import { nativeNotifications, type NotificationConfiguration, type NotificationRoute } from './notifications-native';

type Account = { userId: string | null; available: boolean };
type Options = { webview: RefObject<WebView | null>; visible: boolean; ready: boolean };
type RegistrationSignature = { userId: string; installationId: string; fcmToken: string };
const PROMPT_KEY = 'morse-notifications-prompt';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RETRY_DELAY = 30000;
const signatureKey = (value: RegistrationSignature) => JSON.stringify(value);

export function useChatNotifications({ webview, visible, ready }: Options) {
  const [account, setAccount] = useState<Account>({ userId: null, available: false });
  const current = useRef(account);
  const registration = useRef(false);
  const revision = useRef(0);
  const activeRequest = useRef<string | null>(null);
  const pendingSignature = useRef<RegistrationSignature | null>(null);
  const successfulSignature = useRef<RegistrationSignature | null>(null);
  const retry = useRef<{ key: string; until: number } | null>(null);
  const nativeWork = useRef<Promise<void>>(Promise.resolve());
  const registrationTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prompted = useRef(false);
  const routeMounted = useRef(true);
  const routeReadiness = useRef({ visible, ready });
  const waitingRoute = useRef<NotificationRoute | null>(null);
  const lastRoute = useRef({ key: '', time: 0 });
  const queueNative = useCallback((action: () => Promise<unknown>) => {
    const work = nativeWork.current.then(action).then(() => {}).catch(() => {});
    nativeWork.current = work;
    return work;
  }, []);
  const resetRegistration = useCallback(() => {
    activeRequest.current = null;
    pendingSignature.current = null;
    successfulSignature.current = null;
    retry.current = null;
    registration.current = false;
    if (registrationTimeout.current) clearTimeout(registrationTimeout.current);
    registrationTimeout.current = null;
  }, []);

  const openRoute = useCallback((route: NotificationRoute | null) => {
    if (!routeMounted.current || !route || !/^[A-Za-z0-9_-]{1,80}$/.test(route.conversationId)) return;
    if (!routeReadiness.current.visible || !routeReadiness.current.ready) { waitingRoute.current = route; return; }
    const key = `${route.conversationId}:${route.messageId}`;
    if (lastRoute.current.key === key && Date.now() - lastRoute.current.time < 1000) return;
    lastRoute.current = { key, time: Date.now() };
    waitingRoute.current = null;
    webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('morse-native-open-conversation',{detail:${JSON.stringify(route)}})); true;`);
  }, [webview]);

  const connect = useCallback(async (allowPrompt = true) => {
    const selected = current.current;
    if (!visible || !ready || !selected.userId || !selected.available || registration.current) return;
    let failureKey = `account:${selected.userId}`;
    if (retry.current?.key === failureKey && Date.now() < retry.current.until) return;
    const version = revision.current;
    const requestId = Crypto.randomUUID();
    const valid = () => routeMounted.current && revision.current === version && activeRequest.current === requestId
      && current.current.userId === selected.userId && current.current.available;
    activeRequest.current = requestId;
    registration.current = true;
    let sent = false;
    try {
      await nativeWork.current;
      if (!valid()) return;
      const state = await nativeNotifications.getStateAsync();
      if (!valid()) return;
      if (!state.supported || !state.fcmConfigured) return;
      if (successfulSignature.current && !state.accountConfigured) {
        successfulSignature.current = null;
        retry.current = null;
      }
      if (!state.enabled) {
        if (!allowPrompt || prompted.current) return;
        prompted.current = true;
        if (await SecureStore.getItemAsync(PROMPT_KEY) || !valid()) return;
        await SecureStore.setItemAsync(PROMPT_KEY, 'shown');
        if (!valid()) return;
        Alert.alert('Receive Morse messages', 'Enable notifications to receive messages from friends and groups while the app is closed.', [
          { text: 'Not now', style: 'cancel' },
          { text: 'Enable', onPress: () => { retry.current = null; void nativeNotifications.openSettingsAsync().catch(() => {}); } },
        ]);
        return;
      }
      if (!UUID.test(state.deviceId)) throw new Error('Native installation ID is unavailable.');
      const installationId = state.deviceId.toLowerCase();
      const fcmToken = await nativeNotifications.getFCMTokenAsync();
      if (!valid()) return;
      if (!fcmToken) throw new Error('Native notification token is unavailable.');
      const signature = { userId: selected.userId, installationId, fcmToken };
      failureKey = signatureKey(signature);
      if (state.accountConfigured && state.configuredUserId === selected.userId && successfulSignature.current
          && signatureKey(successfulSignature.current) === failureKey) return;
      if (retry.current?.key === failureKey && Date.now() < retry.current.until) return;
      pendingSignature.current = signature;
      registrationTimeout.current = setTimeout(() => {
        if (activeRequest.current === requestId) {
          retry.current = { key: failureKey, until: Date.now() + RETRY_DELAY };
          registration.current = false; activeRequest.current = null; pendingSignature.current = null;
        }
      }, 15000);
      sent = true;
      webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('morse-native-register-notifications',{detail:${JSON.stringify({ installationId, fcmToken, userId: selected.userId, requestId })}})); true;`);
    } catch { if (valid()) retry.current = { key: failureKey, until: Date.now() + RETRY_DELAY }; }
    finally {
      if (!sent && activeRequest.current === requestId) {
        registration.current = false; activeRequest.current = null; pendingSignature.current = null;
      }
    }
  }, [visible, ready, webview]);

  const clear = useCallback(() => {
    current.current = { userId: null, available: false };
    revision.current += 1;
    resetRegistration();
    setAccount(current.current);
    waitingRoute.current = null;
    void queueNative(() => nativeNotifications.clearAsync());
  }, [queueNative, resetRegistration]);

  const handleMessage = useCallback((value: Record<string, unknown>) => {
    if (value.type === 'chat-account') {
      const userId = typeof value.userId === 'string' ? value.userId : null;
      const next = { userId, available: value.notificationsAvailable === true };
      if (current.current.userId !== userId) {
        revision.current += 1;
        resetRegistration();
        if (current.current.userId) void queueNative(() => nativeNotifications.clearAsync());
      }
      current.current = next;
      setAccount(previous => previous.userId === next.userId && previous.available === next.available ? previous : next);
      if (!userId) clear();
      return true;
    }
    if (value.type === 'notifications-registered') {
      if (!activeRequest.current || value.requestId !== activeRequest.current) return true;
      const signature = pendingSignature.current;
      if (registrationTimeout.current) clearTimeout(registrationTimeout.current);
      registrationTimeout.current = null;
      activeRequest.current = null;
      pendingSignature.current = null;
      const data = value.data as Partial<NotificationConfiguration> | undefined;
      const version = revision.current;
      if (signature && value.ok === true && data?.userId === current.current.userId &&
          typeof data.deviceId === 'string' && typeof data.authToken === 'string') {
        void queueNative(async () => {
          if (!routeMounted.current || revision.current !== version || data.userId !== current.current.userId) return;
          try {
            const state = await nativeNotifications.configureAsync(data as NotificationConfiguration);
            if (routeMounted.current && revision.current === version && data.userId === current.current.userId) {
              if (!state.accountConfigured) throw new Error('Native notification registration did not finish.');
              successfulSignature.current = signature;
              retry.current = null;
            }
          } catch {
            if (revision.current === version) retry.current = { key: signatureKey(signature), until: Date.now() + RETRY_DELAY };
          } finally { if (revision.current === version) registration.current = false; }
        });
      } else {
        registration.current = false;
        if (signature) retry.current = { key: signatureKey(signature), until: Date.now() + RETRY_DELAY };
      }
      return true;
    }
    if (value.type === 'notifications-settings') {
      retry.current = null;
      void nativeNotifications.openSettingsAsync().catch(() => {});
      return true;
    }
    return false;
  }, [clear, queueNative, resetRegistration]);

  useEffect(() => { routeReadiness.current = { visible, ready }; }, [visible, ready]);
  useEffect(() => { void connect(); }, [connect, account]);
  useEffect(() => {
    if (!visible || !ready) return;
    if (waitingRoute.current) openRoute(waitingRoute.current);
    void nativeNotifications.consumeRouteAsync().then(openRoute).catch(() => {});
  }, [visible, ready, openRoute]);
  useEffect(() => {
    const app = AppState.addEventListener('change', state => { if (state === 'active') void connect(false); });
    const token = nativeNotifications.addListener('onTokenChanged', value => {
      const known = successfulSignature.current || pendingSignature.current;
      if (!known || known.fcmToken !== value.token) { revision.current += 1; resetRegistration(); }
      void connect(false);
    });
    const state = nativeNotifications.addListener('onStateChange', value => {
      if (!value.accountConfigured && successfulSignature.current) {
        revision.current += 1;
        resetRegistration();
        void connect(false);
      }
    });
    const route = nativeNotifications.addListener('onNotificationOpen', openRoute);
    return () => { app.remove(); token.remove(); state.remove(); route.remove(); };
  }, [connect, openRoute, resetRegistration]);
  useEffect(() => {
    routeMounted.current = true;
    return () => {
      routeMounted.current = false;
      revision.current += 1;
      resetRegistration();
      waitingRoute.current = null;
    };
  }, [resetRegistration]);

  return { handleMessage, clear };
}

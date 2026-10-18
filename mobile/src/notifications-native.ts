import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface NotificationState {
  supported: boolean;
  enabled: boolean;
  fcmConfigured: boolean;
  token: string | null;
  deviceId: string;
  accountConfigured: boolean;
  registeredDeviceId?: string | null;
  configuredUserId?: string | null;
}

export interface NotificationConfiguration {
  deviceId: string;
  authToken: string;
  userId: string;
}

export interface NotificationAudioSettings {
  wpm: number;
  farnsworth: number;
  frequency: number;
  volume: number;
}

export interface NotificationRoute {
  conversationId: string;
  messageId: string;
}

type NotificationEvents = {
  onTokenChanged: { token: string; deviceId: string };
  onStateChange: NotificationState;
  onNotificationOpen: NotificationRoute;
  onMessageReceived: NotificationRoute;
};

interface NativeNotificationsModule {
  updateAudioSettingsAsync?(options: NotificationAudioSettings): Promise<void>;
  getStateAsync(): Promise<NotificationState>;
  getFCMTokenAsync(): Promise<string | null>;
  configureAsync(options: NotificationConfiguration): Promise<NotificationState>;
  clearAsync(): Promise<NotificationState>;
  consumeRouteAsync(): Promise<NotificationRoute | null>;
  openSettingsAsync(): Promise<void>;
  fetchMessageNotificationAsync(messageId: string): Promise<void>;
  showDebugNotificationAsync(options: { text: string; senderUsername?: string; conversationId?: string }): Promise<void>;
  addListener<K extends keyof NotificationEvents>(event: K, listener: (payload: NotificationEvents[K]) => void): EventSubscription;
}

// Expo Go, iOS and old binaries stay usable without this Android-only module.
const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeNotificationsModule>('MorseNotifications')
  : null;
const unsupported: NotificationState = {
  supported: false, enabled: false, fcmConfigured: false, token: null, deviceId: '', accountConfigured: false,
};

export const nativeNotifications = {
  async updateAudioSettingsAsync(options: NotificationAudioSettings): Promise<void> {
    if (nativeModule?.updateAudioSettingsAsync) await nativeModule.updateAudioSettingsAsync(options);
  },
  async getStateAsync(): Promise<NotificationState> {
    return nativeModule ? nativeModule.getStateAsync() : { ...unsupported };
  },
  async getFCMTokenAsync(): Promise<string | null> {
    return nativeModule ? nativeModule.getFCMTokenAsync() : null;
  },
  async configureAsync(options: NotificationConfiguration): Promise<NotificationState> {
    return nativeModule ? nativeModule.configureAsync(options) : { ...unsupported };
  },
  async clearAsync(): Promise<NotificationState> {
    return nativeModule ? nativeModule.clearAsync() : { ...unsupported };
  },
  async consumeRouteAsync(): Promise<NotificationRoute | null> {
    return nativeModule ? nativeModule.consumeRouteAsync() : null;
  },
  async openSettingsAsync(): Promise<void> {
    if (nativeModule) await nativeModule.openSettingsAsync();
  },
  async fetchMessageNotificationAsync(messageId: string): Promise<void> {
    if (nativeModule) await nativeModule.fetchMessageNotificationAsync(messageId);
  },
  addListener<K extends keyof NotificationEvents>(event: K, listener: (payload: NotificationEvents[K]) => void): EventSubscription {
    return nativeModule ? nativeModule.addListener(event, listener) : { remove() {} };
  },
  async showDebugNotificationAsync(options: { text: string; senderUsername?: string; conversationId?: string }): Promise<void> {
    if (!__DEV__) throw new Error('Notification testing requires a development build.');
    if (nativeModule) await nativeModule.showDebugNotificationAsync(options);
  },
};

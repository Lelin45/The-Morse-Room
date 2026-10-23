import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

export interface RadioCapabilities {
  supported: boolean;
  audioReceive: boolean;
  usbHost: boolean;
  usbKeyer: boolean;
  bluetoothKeyer: boolean;
  protocol: string;
}

export interface RadioAudioInput {
  id: number;
  name: string;
  type: number;
  kind: 'usb' | 'wired' | 'microphone' | 'other';
  external: boolean;
}

export interface RadioKeyer {
  id: number;
  name: string;
  vendorId: number;
  productId: number;
  eligible: boolean;
  permissionGranted: boolean;
}

export interface RadioTransmission {
  id: string;
  ditMs: number;
  characterGapMs: number;
  wordGapMs: number;
  morse: string;
}

export type RadioEvent =
  | { kind: 'audio'; sampleRate: number; samples: number[] }
  | { kind: 'status'; state: 'starting' | 'receiving' | 'stopped' | 'error'; sampleRate?: number;
    device?: RadioAudioInput; deviceId?: number; deviceName?: string; message?: string }
  | { kind: 'keyer'; state: 'connected' | 'transmitting' | 'queued' | 'done' | 'stopped' | 'disconnected' | 'error';
    id?: string; deviceId?: number; deviceName?: string; protocol?: string; message?: string };

interface NativeRadioModule {
  getCapabilitiesAsync(): Promise<RadioCapabilities>;
  getAudioInputsAsync(): Promise<RadioAudioInput[]>;
  startReceiveAsync(options: { deviceId?: number }): Promise<{ state: string; sampleRate: number }>;
  stopReceiveAsync(): Promise<void>;
  listKeyersAsync(): Promise<RadioKeyer[]>;
  connectKeyerAsync(deviceId: number): Promise<RadioEvent>;
  transmitAsync(options: RadioTransmission): Promise<{ state: string; id: string }>;
  stopTransmitAsync(): Promise<void>;
  disconnectKeyerAsync(): Promise<void>;
  addListener(event: 'onRadioEvent', listener: (payload: RadioEvent) => void): EventSubscription;
}

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeRadioModule>('MorseRadio')
  : null;

const unsupported: RadioCapabilities = {
  supported: false, audioReceive: false, usbHost: false, usbKeyer: false, bluetoothKeyer: false, protocol: 'MR1',
};

function requireRadio(): NativeRadioModule {
  if (!nativeModule) throw new Error('Radio hardware needs the Android app build with Advanced mode.');
  return nativeModule;
}

export async function requestRadioMicrophonePermission(): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('Radio audio input is available in the Android app.');
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) return;
  const result = await PermissionsAndroid.request(permission, {
    title: 'Receive radio audio',
    message: 'Morse Room processes live audio on this phone to decode Morse. Audio is not saved or uploaded.',
    buttonPositive: 'Continue',
    buttonNegative: 'Cancel',
  });
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error(result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      ? 'Allow microphone access in Android app settings to receive radio audio.'
      : 'Microphone access is needed to receive radio audio.');
  }
}

export const nativeRadio = {
  async getCapabilitiesAsync(): Promise<RadioCapabilities> {
    return nativeModule ? nativeModule.getCapabilitiesAsync() : { ...unsupported };
  },
  async getAudioInputsAsync(): Promise<RadioAudioInput[]> {
    return nativeModule ? nativeModule.getAudioInputsAsync() : [];
  },
  async startReceiveAsync(options: { deviceId?: number } = {}): Promise<{ state: string; sampleRate: number }> {
    const radio = requireRadio();
    await requestRadioMicrophonePermission();
    return radio.startReceiveAsync(options);
  },
  async stopReceiveAsync(): Promise<void> { if (nativeModule) await nativeModule.stopReceiveAsync(); },
  async listKeyersAsync(): Promise<RadioKeyer[]> { return nativeModule ? nativeModule.listKeyersAsync() : []; },
  async connectKeyerAsync(deviceId: number): Promise<RadioEvent> { return requireRadio().connectKeyerAsync(deviceId); },
  async transmitAsync(options: RadioTransmission): Promise<{ state: string; id: string }> { return requireRadio().transmitAsync(options); },
  async stopTransmitAsync(): Promise<void> { if (nativeModule) await nativeModule.stopTransmitAsync(); },
  async disconnectKeyerAsync(): Promise<void> { if (nativeModule) await nativeModule.disconnectKeyerAsync(); },
  addListener(event: 'onRadioEvent', listener: (payload: RadioEvent) => void): EventSubscription {
    return nativeModule ? nativeModule.addListener(event, listener) : { remove() {} };
  },
};

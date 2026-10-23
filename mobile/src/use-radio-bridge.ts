import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { AppState } from 'react-native';
import type { WebView } from 'react-native-webview';
import { nativeRadio, requestRadioMicrophonePermission, type RadioTransmission } from './radio-native';

type RadioMessage = { type?: string; action?: string; requestId?: string; payload?: Record<string, unknown> };

function injectRadioEvent(webview: RefObject<WebView | null>, detail: unknown) {
  webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('morse-radio',{detail:${JSON.stringify(detail)}}));true;`);
}

export function useRadioBridge(webview: RefObject<WebView | null>) {
  const receiveGeneration = useRef(0);
  const publish = useCallback((detail: unknown) => injectRadioEvent(webview, detail), [webview]);
  useEffect(() => {
    const events = nativeRadio.addListener('onRadioEvent', publish);
    const stop = () => {
      receiveGeneration.current += 1;
      void nativeRadio.stopReceiveAsync().catch(() => {});
      void nativeRadio.disconnectKeyerAsync().catch(() => {});
    };
    const lifecycle = AppState.addEventListener('change', state => { if (state === 'background') stop(); });
    return () => { events.remove(); lifecycle.remove(); stop(); };
  }, [publish]);

  return useCallback((message: RadioMessage): boolean => {
    if (message.type !== 'radio-command') return false;
    if (!message.requestId || !/^radio[0-9_]+$/u.test(message.requestId)) return true;
    const requestId = message.requestId;
    const payload = message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {};
    void (async () => {
      try {
        let data: unknown;
        switch (message.action) {
          case 'getCapabilities': {
            const capabilities = await nativeRadio.getCapabilitiesAsync();
            data = { ...capabilities, available: capabilities.supported, audioInput: capabilities.audioReceive };
            break;
          }
          case 'getAudioInputs': data = await nativeRadio.getAudioInputsAsync(); break;
          case 'listKeyers': data = await nativeRadio.listKeyersAsync(); break;
          case 'startReceive': {
            if (AppState.currentState !== 'active') throw new Error('Open the app to receive radio audio.');
            const generation = ++receiveGeneration.current;
            await requestRadioMicrophonePermission();
            if (generation !== receiveGeneration.current || AppState.currentState !== 'active') throw new Error('Receiving was cancelled.');
            await nativeRadio.stopTransmitAsync();
            data = await nativeRadio.startReceiveAsync(Number.isInteger(payload.deviceId) ? { deviceId: Number(payload.deviceId) } : {});
            if (generation !== receiveGeneration.current || AppState.currentState !== 'active') {
              await nativeRadio.stopReceiveAsync();
              throw new Error('Receiving was cancelled.');
            }
            break;
          }
          case 'stopReceive': receiveGeneration.current += 1; data = await nativeRadio.stopReceiveAsync(); break;
          case 'connectKeyer':
            if (!Number.isInteger(payload.deviceId)) throw new Error('Choose a connected USB keyer.');
            data = await nativeRadio.connectKeyerAsync(Number(payload.deviceId)); break;
          case 'transmit': {
            if (AppState.currentState !== 'active') throw new Error('Open the app to transmit.');
            const callsign = String(payload.callsign ?? '').toUpperCase();
            if (!/^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9/]{3,16}$/u.test(callsign) || payload.hardwareReady !== true) {
              throw new Error('Add your station callsign and confirm the isolated keyer setup before transmitting.');
            }
            const transmission: RadioTransmission = {
              id: String(payload.id ?? ''), morse: String(payload.morse ?? ''), ditMs: Number(payload.ditMs),
              characterGapMs: Number(payload.characterGapMs), wordGapMs: Number(payload.wordGapMs),
            };
            receiveGeneration.current += 1;
            data = await nativeRadio.transmitAsync(transmission); break;
          }
          case 'stopTransmit': data = await nativeRadio.stopTransmitAsync(); break;
          case 'disconnectKeyer': data = await nativeRadio.disconnectKeyerAsync(); break;
          default: throw new Error('This radio command is unavailable.');
        }
        publish({ requestId, ok: true, data: data ?? null });
      } catch (error) { publish({ requestId, ok: false, error: error instanceof Error ? error.message : 'Radio connection failed.' }); }
    })();
    return true;
  }, [publish]);
}

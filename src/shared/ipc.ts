/** Allowlist channel IPC; dipakai preload (penjaga) dan main (handler). */
export const INVOKE_CHANNELS = [
  'state:get',
  'settings:set',
  'android:start',
  'android:pair',
  'android:connect',
  'android:disconnect',
  'android:wireless',
  'airplay:restart',
  'iosusb:driver',
  'iosusb:start',
  'session:stop',
  'mirror:ready',
] as const;

export const SEND_CHANNELS = ['mirror:size', 'mirror:stats'] as const;

export const EVENT_CHANNELS = ['state:changed', 'mirror:media', 'mirror:audio-settings', 'mirror:closed'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type SendChannel = (typeof SEND_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface Api {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  send(channel: SendChannel, payload?: unknown): void;
  /** Mengembalikan fungsi unsubscribe. */
  on<T = unknown>(channel: EventChannel, listener: (payload: T) => void): () => void;
}

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS, type Api } from '../shared/ipc';

function assertAllowed(list: readonly string[], channel: string): void {
  if (!list.includes(channel)) throw new Error(`Channel IPC tidak diizinkan: ${channel}`);
}

const api: Api = {
  invoke(channel, payload) {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel, payload) {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, payload);
  },
  on(channel, listener) {
    assertAllowed(EVENT_CHANNELS, channel);
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);

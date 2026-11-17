import { app, type BrowserWindow } from 'electron';
import path from 'node:path';

/** Folder binary hasil unduh/build: `resources/` saat dev, `process.resourcesPath` saat packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
}

export const adbPath = (): string => path.join(resourcesDir(), 'adb', 'win32', 'adb.exe');
export const scrcpyServerPath = (): string => path.join(resourcesDir(), 'scrcpy-server');
export const airplayRuntimeDir = (): string => path.join(resourcesDir(), 'airplay', 'win32');
export const usbRuntimeDir = (): string => path.join(resourcesDir(), 'usb', 'win32');
export const userDataDir = (): string => app.getPath('userData');
export const preloadPath = (): string => path.join(__dirname, '../preload/index.js');

/** Memuat halaman renderer (`index.html` / `mirror.html`) dari dev server atau dari hasil build. */
export function loadRendererPage(win: BrowserWindow, page: 'index.html' | 'mirror.html'): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl ? win.loadURL(`${devUrl}/${page}`) : win.loadFile(path.join(__dirname, '../renderer', page));
}

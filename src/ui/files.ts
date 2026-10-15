import { Capacitor } from '@capacitor/core';

/**
 * Hands a text file to the user: on Android it is written to the app cache and offered through
 * the share sheet (save to Files, Drive, email…); in a browser it is downloaded.
 */
export async function saveTextFile(name: string, text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const { uri } = await Filesystem.writeFile({
      path: name,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({ title: name, files: [uri], dialogTitle: 'Export story' });
    } catch (e) {
      // Closing the share sheet without choosing a target is not an error.
      if (!/cancel/iu.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    return;
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

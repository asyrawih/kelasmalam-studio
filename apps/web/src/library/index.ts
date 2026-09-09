/**
 * Barrel kepustakaan.
 *
 * `LibraryDock` sengaja tidak terikat pada satu halaman: ia menerima `apiBase`
 * dan `onLoaded`, dan tidak tahu apa-apa soal timeline maupun deck. Yang
 * memasangnya memutuskan apa artinya "lagu sudah mendarat".
 */

export { LibraryDock, type LibraryDockProps } from './LibraryDock';
export { StoreSettings } from './StoreSettings';
export { libraryActions, libraryStore, useLibrary } from './store';
export { createLibraryApi, LibraryError, type LibraryApi } from './api';
export { createLocalLibraryApi } from './local-api';
export { loadTrack, type LoadOutcome } from './load-track';
export {
  createInitialLibrary,
  formatBytes,
  formatDuration,
  summarize,
  type LibraryState,
  type LibraryStatus,
  type LibraryTrack,
  type LibraryUser,
} from './model';

import type { QueueItem, RobloxTarget } from './model';

const DB_NAME = 'dawonweb-roblox-upload';
const STORE = 'queue';
const KEY = 'current';

export interface PersistedRobloxQueue {
  readonly items: readonly QueueItem[];
  readonly selected: number | null;
  readonly target: Omit<RobloxTarget, 'apiKey'>;
  readonly files: readonly { readonly id: number; readonly file: File }[];
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadRobloxQueue(): Promise<PersistedRobloxQueue | null> {
  const db = await database();
  if (db === null) return null;
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as PersistedRobloxQueue | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRobloxQueue(value: PersistedRobloxQueue): Promise<void> {
  const db = await database();
  if (db === null) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function clearRobloxQueue(): Promise<void> {
  const db = await database();
  if (db === null) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

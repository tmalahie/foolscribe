import type { RecordingDetail } from './types';

// Épinglage « disponible hors-ligne » (§10 du plan) : les octets audio + le
// détail (analyse comprise) sont stockés sous une clé stable (id de
// l'enregistrement) dans IndexedDB. Indépendant de l'expiration des URLs
// présignées : la lecture hors-ligne lit le blob local.

const DB_NAME = 'foolscribe-offline';
const DB_VERSION = 1;
const AUDIO_STORE = 'audio';
const DATA_STORE = 'data';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE);
      }
      if (!db.objectStoreNames.contains(DATA_STORE)) {
        db.createObjectStore(DATA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await txDone(tx);
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export interface PinnedRecording {
  detail: RecordingDetail;
  pinnedAt: string;
}

export async function pinRecording(id: number): Promise<void> {
  const detailRes = await fetch(`/api/recordings/${id}`);
  if (!detailRes.ok) throw new Error('Impossible de récupérer le détail');
  const detail = (await detailRes.json()) as RecordingDetail;

  // ?stream=1 : le flux passe par le serveur (même origine), ce qui évite le
  // CORS d'un fetch() vers l'URL présignée de l'Object Storage.
  const audioRes = await fetch(`/api/recordings/${id}/audio?stream=1`);
  if (!audioRes.ok) throw new Error('Impossible de télécharger l’audio');
  const audioBlob = await audioRes.blob();

  await idbPut(AUDIO_STORE, id, audioBlob);
  const pinned: PinnedRecording = {
    detail,
    pinnedAt: new Date().toISOString(),
  };
  await idbPut(DATA_STORE, id, pinned);
}

/** Met à jour le détail épinglé (ex. nouvelle analyse) sans re-télécharger l'audio. */
export async function refreshPinnedDetail(
  id: number,
  detail: RecordingDetail,
): Promise<void> {
  const existing = await idbGet<PinnedRecording>(DATA_STORE, id);
  if (!existing) return;
  await idbPut(DATA_STORE, id, { ...existing, detail });
}

export async function unpinRecording(id: number): Promise<void> {
  await idbDelete(AUDIO_STORE, id);
  await idbDelete(DATA_STORE, id);
}

export async function isPinned(id: number): Promise<boolean> {
  return (await idbGet<PinnedRecording>(DATA_STORE, id)) != null;
}

export async function getPinnedDetail(
  id: number,
): Promise<RecordingDetail | null> {
  const pinned = await idbGet<PinnedRecording>(DATA_STORE, id);
  return pinned?.detail ?? null;
}

export async function getPinnedAudio(id: number): Promise<Blob | null> {
  return idbGet<Blob>(AUDIO_STORE, id);
}

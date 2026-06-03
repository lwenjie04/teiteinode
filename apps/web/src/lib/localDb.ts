import type { Diary, UserSettings } from "@tietie/shared";
import { openDB } from "idb";

export interface LocalAsset {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface DeletedDiaryRecord {
  id: string;
  diary: Diary;
  deletedAt: string;
}

export interface SyncQueueItem {
  id: string;
  type: string;
  payload: unknown;
}

const dbPromise = openDB("tietie-diary", 3, {
  upgrade(db) {
    if (!db.objectStoreNames.contains("diaries")) db.createObjectStore("diaries", { keyPath: "id" });
    if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "id" });
    if (!db.objectStoreNames.contains("syncQueue")) db.createObjectStore("syncQueue", { keyPath: "id" });
    if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
    if (!db.objectStoreNames.contains("deletedDiaries")) db.createObjectStore("deletedDiaries", { keyPath: "id" });
  }
});

let syncQueueWrite = Promise.resolve();

function chainSyncQueueWrite<T>(writer: () => Promise<T>) {
  const nextWrite = syncQueueWrite.then(writer);
  syncQueueWrite = nextWrite.then(
    () => undefined,
    () => undefined
  );
  return nextWrite;
}

export async function saveDiaryLocal(diary: Diary) {
  const db = await dbPromise;
  await db.put("diaries", diary);
}

export async function saveDiariesLocal(diaries: Diary[]) {
  const db = await dbPromise;
  const tx = db.transaction("diaries", "readwrite");
  await Promise.all(diaries.map((diary) => tx.store.put(diary)));
  await tx.done;
}

export async function listLocalDiaries() {
  const db = await dbPromise;
  return db.getAll("diaries") as Promise<Diary[]>;
}

export async function deleteDiaryLocal(id: string) {
  const db = await dbPromise;
  await db.delete("diaries", id);
}

export async function clearLocalDiaries() {
  const db = await dbPromise;
  await db.clear("diaries");
}

export async function saveSettingsLocal(settings: UserSettings) {
  const db = await dbPromise;
  await db.put("settings", { id: "user", ...settings });
}

export async function loadSettingsLocal() {
  const db = await dbPromise;
  return db.get("settings", "user") as Promise<(UserSettings & { id: string }) | undefined>;
}

function payloadId(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" ? id : "";
}

function diaryQueueId(item: SyncQueueItem) {
  if (!item.type.startsWith("diary:")) return "";
  return payloadId(item.payload);
}

function isSettingsQueueItem(item: SyncQueueItem) {
  return item.type.startsWith("settings:");
}

export function compactSyncQueueItems(items: SyncQueueItem[]) {
  const compacted: SyncQueueItem[] = [];

  for (const item of items) {
    const diaryId = diaryQueueId(item);

    if (diaryId) {
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        if (diaryQueueId(compacted[index]) === diaryId) compacted.splice(index, 1);
      }
      compacted.push(item);
      continue;
    }

    if (isSettingsQueueItem(item)) {
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        if (isSettingsQueueItem(compacted[index])) compacted.splice(index, 1);
      }
      compacted.push(item);
      continue;
    }

    compacted.push(item);
  }

  return compacted;
}

async function replaceSyncQueueItems(items: SyncQueueItem[]) {
  const db = await dbPromise;
  const tx = db.transaction("syncQueue", "readwrite");
  const store = tx.objectStore("syncQueue");
  store.clear();
  for (const entry of items) store.put(entry);
  await tx.done;
}

export async function enqueueSync(item: SyncQueueItem) {
  await chainSyncQueueWrite(async () => {
    const db = await dbPromise;
    const existing = (await db.getAll("syncQueue")) as SyncQueueItem[];
    await replaceSyncQueueItems(compactSyncQueueItems([...existing, item]));
  });
}

export async function removeDiarySyncItems(id: string) {
  await chainSyncQueueWrite(async () => {
    const db = await dbPromise;
    const existing = (await db.getAll("syncQueue")) as SyncQueueItem[];
    await replaceSyncQueueItems(existing.filter((item) => diaryQueueId(item) !== id));
  });
}

export async function compactSyncQueue() {
  return chainSyncQueueWrite(async () => {
    const db = await dbPromise;
    const existing = (await db.getAll("syncQueue")) as SyncQueueItem[];
    const compacted = compactSyncQueueItems(existing);
    if (compacted.length !== existing.length || compacted.some((item, index) => item.id !== existing[index]?.id)) {
      await replaceSyncQueueItems(compacted);
    }
    return {
      before: existing.length,
      after: compacted.length
    };
  });
}

export async function countSyncQueue() {
  await syncQueueWrite;
  const db = await dbPromise;
  return db.count("syncQueue");
}

export async function listSyncQueue() {
  await syncQueueWrite;
  const db = await dbPromise;
  return db.getAll("syncQueue") as Promise<SyncQueueItem[]>;
}

export async function clearSyncQueue() {
  await chainSyncQueueWrite(async () => {
    const db = await dbPromise;
    await db.clear("syncQueue");
  });
}

export async function saveLocalAsset(asset: LocalAsset) {
  const db = await dbPromise;
  await db.put("assets", asset);
}

export async function listLocalAssets() {
  const db = await dbPromise;
  const assets = (await db.getAll("assets")) as LocalAsset[];
  return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteLocalAsset(id: string) {
  const db = await dbPromise;
  await db.delete("assets", id);
}

export async function clearLocalAssets() {
  const db = await dbPromise;
  await db.clear("assets");
}

export async function saveDeletedDiaryLocal(record: DeletedDiaryRecord) {
  const db = await dbPromise;
  await db.put("deletedDiaries", record);
}

export async function getLatestDeletedDiaryLocal() {
  const db = await dbPromise;
  const records = (await db.getAll("deletedDiaries")) as DeletedDiaryRecord[];
  return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))[0];
}

export async function deleteDeletedDiaryLocal(id: string) {
  const db = await dbPromise;
  await db.delete("deletedDiaries", id);
}

export async function clearDeletedDiariesLocal() {
  const db = await dbPromise;
  await db.clear("deletedDiaries");
}

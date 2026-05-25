import type { Decoration, DecorationKind, Diary, DoodleStroke, Sticker, StickerVariant, SubjectSelection, UserSettings } from "@tietie/shared";
import { defineStore } from "pinia";
import { pullDiaries, pushDiaries } from "../lib/api";
import { formatLocalDateKey } from "../lib/dateTools";
import {
  clearDeletedDiariesLocal,
  clearLocalDiaries,
  clearSyncQueue,
  compactSyncQueue,
  deleteDiaryLocal,
  enqueueSync,
  getLatestDeletedDiaryLocal,
  listLocalDiaries,
  listSyncQueue,
  saveDeletedDiaryLocal,
  saveDiariesLocal,
  saveDiaryLocal
} from "../lib/localDb";
import type { LocalAsset, SyncQueueItem } from "../lib/localDb";
import { useSettingsStore } from "./settingsStore";

const now = new Date().toISOString();

const sampleDiaries: Diary[] = [
  {
    id: "demo-1",
    localId: "local-demo-1",
    status: "done",
    body: "今日快乐被一杯奶茶稳稳接住了。杯身上还挂着一点水珠，像给这个下午贴了一枚小小的甜味印章。",
    date: "2026-05-11",
    location: "街角奶茶店",
    mood: "开心",
    tags: ["美食", "自我照顾"],
    writingStyle: "可爱活泼",
    length: "一小段",
    background: "拍立得",
    cardImageUrl: "",
    stickers: [],
    decorations: [],
    doodles: [],
    lastModifiedAt: now,
    createdAt: now,
    updatedAt: now
  },
  {
    id: "draft-1",
    localId: "local-draft-1",
    status: "draft",
    body: "等联网后继续生成这篇小日记。",
    date: "2026-05-11",
    location: "",
    mood: "平静",
    tags: ["生活"],
    writingStyle: "文艺感",
    length: "一小段",
    background: "牛皮纸",
    cardImageUrl: "",
    stickers: [],
    decorations: [],
    doodles: [],
    lastModifiedAt: now,
    createdAt: now,
    updatedAt: now
  }
];

function sortByModified(diaries: Diary[]) {
  return [...diaries].sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
}

function normalizeDiary(diary: Diary): Diary {
  return {
    ...diary,
    decorations: diary.decorations ?? [],
    doodles: diary.doodles ?? [],
    stickers: (diary.stickers ?? []).map((sticker) =>
      sticker.status === "processing"
        ? {
            ...sticker,
            fileUrl: sticker.sourceImageUrl ?? sticker.fileUrl,
            status: "ready" as const,
            errorMessage: "上次处理没有完成，已自动恢复原贴纸。"
          }
        : sticker
    )
  };
}

function normalizeDiaries(diaries: Diary[]) {
  return diaries.map(normalizeDiary);
}

function deletedIdsFromQueue(items: Array<{ type: string; payload: unknown }>) {
  return items
    .filter((item) => item.type === "diary:delete")
    .map((item) => (item.payload as { id?: string }).id)
    .filter((id): id is string => Boolean(id));
}

export interface DiaryBackup {
  app: "贴贴日记";
  version: 1 | 2 | 3;
  exportedAt: string;
  diaries: Diary[];
  settings?: UserSettings;
  assets?: LocalAsset[];
}

export const useDiaryStore = defineStore("diaries", {
  state: () => ({
    diaries: sampleDiaries,
    syncState: "已同步",
    aiAvailable: true,
    hydrated: false,
    syncing: false,
    lastSyncedAt: "",
    pendingSyncCount: 0,
    syncQueueItems: [] as SyncQueueItem[],
    lastSyncQueueCompactedCount: 0,
    lastDeletedDiary: null as Diary | null,
    lastDeletedAt: ""
  }),
  getters: {
    drafts: (state) => state.diaries.filter((diary) => diary.status === "draft"),
    doneDiaries: (state) => state.diaries.filter((diary) => diary.status === "done"),
    latest: (state) => state.diaries[0]
  },
  actions: {
    async hydrate() {
      if (this.hydrated) return;
      const localDiaries = await listLocalDiaries();
      if (localDiaries.length) {
        const recovered = normalizeDiaries(localDiaries);
        this.diaries = sortByModified(recovered);
        await saveDiariesLocal(recovered);
      } else {
        await saveDiariesLocal(sampleDiaries);
      }
      const latestDeleted = await getLatestDeletedDiaryLocal();
      this.lastDeletedDiary = latestDeleted ? normalizeDiary(latestDeleted.diary) : null;
      this.lastDeletedAt = latestDeleted?.deletedAt ?? "";
      await this.refreshPendingSyncCount();
      this.hydrated = true;
    },
    async compactPendingSyncQueue() {
      const result = await compactSyncQueue();
      this.syncQueueItems = await listSyncQueue();
      this.pendingSyncCount = this.syncQueueItems.length;
      this.lastSyncQueueCompactedCount = result.before - result.after;
      return this.pendingSyncCount;
    },
    async refreshPendingSyncCount() {
      return this.compactPendingSyncQueue();
    },
    async persistDiary(diary: Diary, syncType = "diary:update") {
      await saveDiaryLocal(diary);
      await enqueueSync({
        id: crypto.randomUUID(),
        type: syncType,
        payload: diary
      });
      await this.refreshPendingSyncCount();
      this.syncState = "等待同步";
    },
    async createDraft(defaults?: Pick<Diary, "writingStyle" | "length" | "background"> & Partial<Pick<Diary, "date">>) {
      const createdAt = new Date().toISOString();
      const draft: Diary = {
        id: crypto.randomUUID(),
        localId: crypto.randomUUID(),
        status: "draft",
        body: "",
        date: defaults?.date ?? formatLocalDateKey(),
        mood: "开心",
        tags: [],
        writingStyle: defaults?.writingStyle ?? "可爱活泼",
        length: defaults?.length ?? "一小段",
        background: defaults?.background ?? "横线纸",
        stickers: [],
        decorations: [],
        doodles: [],
        lastModifiedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      };
      this.diaries.unshift(draft);
      await this.persistDiary(draft, "diary:create");
      return draft;
    },
    getDiary(id: string) {
      return this.diaries.find((diary) => diary.id === id);
    },
    async updateDiary(id: string, patch: Partial<Diary>) {
      const index = this.diaries.findIndex((diary) => diary.id === id);
      if (index < 0) return undefined;
      const updatedAt = new Date().toISOString();
      const next: Diary = normalizeDiary({
        ...this.diaries[index],
        ...patch,
        lastModifiedAt: updatedAt,
        updatedAt
      });
      this.diaries.splice(index, 1, next);
      await this.persistDiary(next);
      return next;
    },
    async removeDiary(id: string) {
      const existing = this.getDiary(id);
      if (!existing) return;
      const deletedAt = new Date().toISOString();
      this.lastDeletedDiary = normalizeDiary(existing);
      this.lastDeletedAt = deletedAt;
      this.diaries = this.diaries.filter((diary) => diary.id !== id);
      await clearDeletedDiariesLocal();
      await saveDeletedDiaryLocal({
        id,
        diary: this.lastDeletedDiary,
        deletedAt
      });
      await deleteDiaryLocal(id);
      await enqueueSync({
        id: crypto.randomUUID(),
        type: "diary:delete",
        payload: {
          id,
          deletedAt: new Date().toISOString()
        }
      });
      await this.refreshPendingSyncCount();
      this.syncState = "等待同步";
    },
    async restoreLastDeletedDiary() {
      if (!this.lastDeletedDiary) return undefined;
      const restored = normalizeDiary({
        ...this.lastDeletedDiary,
        updatedAt: new Date().toISOString(),
        lastModifiedAt: new Date().toISOString()
      });
      const existingIndex = this.diaries.findIndex((diary) => diary.id === restored.id);
      if (existingIndex >= 0) this.diaries.splice(existingIndex, 1, restored);
      else this.diaries.unshift(restored);
      this.diaries = sortByModified(this.diaries);
      await saveDiaryLocal(restored);
      await clearDeletedDiariesLocal();
      await enqueueSync({
        id: crypto.randomUUID(),
        type: "diary:restore",
        payload: restored
      });
      await this.refreshPendingSyncCount();
      this.syncState = "等待同步";
      this.lastDeletedDiary = null;
      this.lastDeletedAt = "";
      return restored;
    },
    async addSticker(diaryId: string, fileUrl: string, variant: StickerVariant = "白边贴纸") {
      const diary = this.getDiary(diaryId);
      if (!diary) return undefined;
      const sticker: Sticker = {
        id: crypto.randomUUID(),
        diaryId,
        fileUrl,
        sourceImageUrl: fileUrl,
        originalFileUrl: fileUrl,
        variant,
        status: "ready",
        x: 32 + diary.stickers.length * 22,
        y: 38 + diary.stickers.length * 18,
        scale: 1,
        rotation: diary.stickers.length % 2 === 0 ? -6 : 7,
        zIndex: diary.stickers.length + 1
      };
      await this.updateDiary(diaryId, {
        stickers: [...diary.stickers, sticker]
      });
      return sticker;
    },
    async updateSticker(diaryId: string, stickerId: string, patch: Partial<Sticker>) {
      const diary = this.getDiary(diaryId);
      if (!diary) return undefined;
      const nextStickers = diary.stickers.map((sticker) => (sticker.id === stickerId ? { ...sticker, ...patch } : sticker));
      await this.updateDiary(diaryId, { stickers: nextStickers });
      return nextStickers.find((sticker) => sticker.id === stickerId);
    },
    async setStickerSelection(diaryId: string, stickerId: string, selection: SubjectSelection) {
      return this.updateSticker(diaryId, stickerId, {
        selection,
        status: "selecting",
        errorMessage: undefined
      });
    },
    async addDecoration(diaryId: string, kind: DecorationKind, text: string, color = "#ffcf56") {
      const diary = this.getDiary(diaryId);
      if (!diary) return undefined;
      const count = diary.decorations?.length ?? 0;
      const decoration: Decoration = {
        id: crypto.randomUUID(),
        diaryId,
        kind,
        text,
        color,
        x: 42 + count * 8,
        y: 24 + count * 9,
        scale: 1,
        rotation: count % 2 === 0 ? -4 : 5,
        zIndex: 50 + count
      };
      await this.updateDiary(diaryId, {
        decorations: [...(diary.decorations ?? []), decoration]
      });
      return decoration;
    },
    async updateDecoration(diaryId: string, decorationId: string, patch: Partial<Decoration>) {
      const diary = this.getDiary(diaryId);
      if (!diary) return undefined;
      const nextDecorations = (diary.decorations ?? []).map((decoration) => (decoration.id === decorationId ? { ...decoration, ...patch } : decoration));
      await this.updateDiary(diaryId, { decorations: nextDecorations });
      return nextDecorations.find((decoration) => decoration.id === decorationId);
    },
    async removeDecoration(diaryId: string, decorationId: string) {
      const diary = this.getDiary(diaryId);
      if (!diary) return;
      await this.updateDiary(diaryId, {
        decorations: (diary.decorations ?? []).filter((decoration) => decoration.id !== decorationId)
      });
    },
    async addDoodleStroke(diaryId: string, stroke: DoodleStroke) {
      const diary = this.getDiary(diaryId);
      if (!diary) return;
      await this.updateDiary(diaryId, {
        doodles: [...(diary.doodles ?? []), stroke]
      });
    },
    async undoDoodleStroke(diaryId: string) {
      const diary = this.getDiary(diaryId);
      if (!diary) return;
      await this.updateDiary(diaryId, {
        doodles: (diary.doodles ?? []).slice(0, -1)
      });
    },
    async clearDoodles(diaryId: string) {
      await this.updateDiary(diaryId, { doodles: [] });
    },
    createBackup(): DiaryBackup {
      const settings = useSettingsStore();
      return {
        app: "贴贴日记",
        version: 2,
        exportedAt: new Date().toISOString(),
        diaries: normalizeDiaries(this.diaries),
        settings: settings.values
      };
    },
    async importBackup(backup: DiaryBackup) {
      if (backup.app !== "贴贴日记" || !Array.isArray(backup.diaries)) {
        throw new Error("备份文件格式不正确");
      }
      const incoming = normalizeDiaries(backup.diaries);
      const merged = new Map<string, Diary>();
      for (const diary of this.diaries) merged.set(diary.id, diary);
      for (const diary of incoming) merged.set(diary.id, diary);
      const next = sortByModified([...merged.values()]);
      this.diaries = next;
      await saveDiariesLocal(next);
      for (const diary of incoming) {
        await enqueueSync({
          id: crypto.randomUUID(),
          type: "diary:import",
          payload: diary
        });
      }
      if (backup.settings) {
        const importedSettings = await useSettingsStore().applySettings(backup.settings);
        await enqueueSync({
          id: crypto.randomUUID(),
          type: "settings:update",
          payload: importedSettings
        });
      }
      await this.refreshPendingSyncCount();
      this.syncState = "等待同步";
      return incoming.length;
    },
    async clearAllLocalData() {
      this.diaries = [];
      await clearLocalDiaries();
      await clearDeletedDiariesLocal();
      await clearSyncQueue();
      this.lastDeletedDiary = null;
      this.lastDeletedAt = "";
      await this.refreshPendingSyncCount();
      this.syncState = "已清空本地数据";
    },
    async pushToCloud(token: string) {
      this.syncing = true;
      this.syncState = "正在上传";
      try {
        const settings = useSettingsStore();
        await this.compactPendingSyncQueue();
        const queued = this.syncQueueItems;
        const result = await pushDiaries(token, normalizeDiaries(this.diaries), deletedIdsFromQueue(queued), settings.values);
        const merged = normalizeDiaries(result.diaries ?? this.diaries);
        this.diaries = sortByModified(merged);
        await saveDiariesLocal(merged);
        if (result.settings) await settings.applySettings(result.settings);
        await clearSyncQueue();
        await this.refreshPendingSyncCount();
        this.lastSyncedAt = result.serverTime;
        this.syncState = result.conflicts.length ? "已同步，有冲突按最后修改保留" : "已同步";
        return result;
      } finally {
        this.syncing = false;
      }
    },
    async pullFromCloud(token: string) {
      this.syncing = true;
      this.syncState = "正在下载";
      try {
        const settings = useSettingsStore();
        const result = await pullDiaries(token);
        const mergedMap = new Map<string, Diary>();
        for (const diary of normalizeDiaries(this.diaries)) mergedMap.set(diary.id, diary);
        for (const diary of normalizeDiaries(result.diaries)) {
          const existing = mergedMap.get(diary.id);
          mergedMap.set(diary.id, !existing || diary.lastModifiedAt >= existing.lastModifiedAt ? diary : existing);
        }
        const merged = sortByModified([...mergedMap.values()]);
        this.diaries = merged;
        await saveDiariesLocal(merged);
        if (result.settings) await settings.applySettings(result.settings);
        await this.refreshPendingSyncCount();
        this.lastSyncedAt = result.serverTime;
        this.syncState = "已同步";
        return result;
      } finally {
        this.syncing = false;
      }
    },
    async syncWithCloud(token: string) {
      await this.pushToCloud(token);
      await this.pullFromCloud(token);
    }
  }
});

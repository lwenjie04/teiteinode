<script setup lang="ts">
import { backgrounds, diaryLengths, writingStyles } from "@tietie/shared";
import type { Diary } from "@tietie/shared";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { deleteUploadedFile, getAiStatus, getFileStats, listUploadedFiles, uploadImage } from "../lib/api";
import { formatLocalDateKey } from "../lib/dateTools";
import { clearLocalAssets, deleteLocalAsset, listLocalAssets, saveLocalAsset } from "../lib/localDb";
import type { LocalAsset, SyncQueueItem } from "../lib/localDb";
import { useAuthStore } from "../stores/authStore";
import type { DiaryBackup } from "../stores/diaryStore";
import { useDiaryStore } from "../stores/diaryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

type BrowserStorageManager = StorageManager & {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
};

interface ImageReferenceIssue {
  id: string;
  diaryId: string;
  diaryDate: string;
  label: string;
  reason: string;
  url: string;
}

interface ImageReference {
  diaryId: string;
  diaryDate: string;
  label: string;
}

interface BackupImportReport {
  importedAt: string;
  diaryCount: number;
  restoredAssets: number;
  totalReferences: number;
  embeddedReferences: number;
  restoredLocalReferences: number;
  externalReferences: ImageReferenceIssue[];
  volatileReferences: ImageReferenceIssue[];
  unmatchedReferences: ImageReferenceIssue[];
}

const store = useDiaryStore();
const settings = useSettingsStore();
const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();
const email = ref("");
const code = ref("");
const aiMessage = ref("检查中");
const checkingAiStatus = ref(false);
const fileStats = ref({
  storage: "unknown",
  count: 0,
  totalSize: 0
});
const browserStorage = ref({
  available: false,
  usage: 0,
  quota: 0,
  persisted: false,
  message: "浏览器暂未提供存储估算"
});
const uploadedFiles = ref<Array<{ id: string; filename: string; mimeType: string; size: number; url: string; createdAt: string }>>([]);
const localAssets = ref<LocalAsset[]>([]);
const importReport = ref<BackupImportReport | null>(null);
const loadingFiles = ref(false);
const migratingLocalAssets = ref(false);
const checkingImageRefs = ref(false);
const imageAccessIssues = ref<ImageReferenceIssue[]>([]);
const imageAccessCheckedAt = ref("");
const importInput = ref<HTMLInputElement | null>(null);
const nowTick = ref(Date.now());
let clockTimer = 0;

const resendSeconds = computed(() => Math.max(0, Math.ceil((auth.resendAvailableAt - nowTick.value) / 1000)));
const localAssetStats = computed(() => ({
  count: localAssets.value.length,
  totalSize: localAssets.value.reduce((sum, asset) => sum + asset.size, 0)
}));
const imageReferenceLookup = computed(() => {
  const references = new Map<string, ImageReference[]>();
  for (const diary of store.diaries) {
    addImageReference(references, diary.cardImageUrl, {
      diaryId: diary.id,
      diaryDate: diary.date,
      label: "卡片预览图"
    });
    diary.stickers.forEach((sticker, index) => {
      addImageReference(references, sticker.fileUrl, {
        diaryId: diary.id,
        diaryDate: diary.date,
        label: `贴纸 ${index + 1}`
      });
      addImageReference(references, sticker.sourceImageUrl, {
        diaryId: diary.id,
        diaryDate: diary.date,
        label: `贴纸 ${index + 1} 原图`
      });
      addImageReference(references, sticker.originalFileUrl, {
        diaryId: diary.id,
        diaryDate: diary.date,
        label: `贴纸 ${index + 1} 抠图源`
      });
    });
  }
  return references;
});
const localAssetReferenceStats = computed(() => {
  const unusedAssets = localAssets.value.filter((asset) => !imageReferenceLookup.value.has(asset.url));
  return {
    usedCount: localAssets.value.length - unusedAssets.length,
    unusedCount: unusedAssets.length,
    unusedSize: unusedAssets.reduce((sum, asset) => sum + asset.size, 0),
    unusedAssets
  };
});
const migratableLocalAssets = computed(() => {
  const seen = new Set<string>();
  return localAssets.value.filter((asset) => {
    if (!isEmbeddedImageUrl(asset.url) || !imageReferenceLookup.value.has(asset.url) || seen.has(asset.url)) return false;
    seen.add(asset.url);
    return true;
  });
});
const migratableLocalAssetStats = computed(() => ({
  count: migratableLocalAssets.value.length,
  totalSize: migratableLocalAssets.value.reduce((sum, asset) => sum + asset.size, 0),
  referenceCount: migratableLocalAssets.value.reduce((sum, asset) => sum + getAssetReferences(asset.url).length, 0)
}));
const uploadedAssetReferenceStats = computed(() => {
  const unusedAssets = uploadedFiles.value.filter((asset) => !imageReferenceLookup.value.has(asset.url));
  return {
    usedCount: uploadedFiles.value.length - unusedAssets.length,
    unusedCount: unusedAssets.length,
    unusedSize: unusedAssets.reduce((sum, asset) => sum + asset.size, 0),
    unusedAssets
  };
});
const volatileImageIssues = computed(() => {
  const issues: ImageReferenceIssue[] = [];
  for (const diary of store.diaries) {
    if (isVolatileImageUrl(diary.cardImageUrl)) {
      issues.push({
        id: `${diary.id}:card`,
        diaryId: diary.id,
        diaryDate: diary.date,
        label: "卡片预览图",
        reason: "使用了临时图片链接，刷新或重启后可能失效",
        url: diary.cardImageUrl
      });
    }
    diary.stickers.forEach((sticker, index) => {
      [
        { key: "file", label: `贴纸 ${index + 1}` },
        { key: "source", label: `贴纸 ${index + 1} 原图` },
        { key: "original", label: `贴纸 ${index + 1} 抠图源` }
      ].forEach((item) => {
        const url = item.key === "file" ? sticker.fileUrl : item.key === "source" ? sticker.sourceImageUrl : sticker.originalFileUrl;
        if (!isVolatileImageUrl(url)) return;
        issues.push({
          id: `${diary.id}:${sticker.id}:${item.key}`,
          diaryId: diary.id,
          diaryDate: diary.date,
          label: item.label,
          reason: "使用了临时图片链接，刷新或重启后可能失效",
          url
        });
      });
    });
  }
  return issues;
});
const visibleVolatileImageIssues = computed(() => volatileImageIssues.value.slice(0, 4));
const visibleImageAccessIssues = computed(() => imageAccessIssues.value.slice(0, 4));
const checkableImageReferenceCount = computed(() => collectDiaryImageReferences(store.diaries).filter((reference) => isCheckableImageUrl(reference.url)).length);
const backupPreflightReport = computed(() => buildImportReport(store.diaries, localAssets.value, store.diaries.length));
const backupPreflightIssues = computed(() => [...backupPreflightReport.value.volatileReferences, ...backupPreflightReport.value.unmatchedReferences, ...backupPreflightReport.value.externalReferences].slice(0, 4));
const backupPreflightWarningCount = computed(
  () => backupPreflightReport.value.volatileReferences.length + backupPreflightReport.value.unmatchedReferences.length + backupPreflightReport.value.externalReferences.length
);
const importReportIssues = computed(() => (importReport.value ? [...importReport.value.volatileReferences, ...importReport.value.unmatchedReferences, ...importReport.value.externalReferences].slice(0, 4) : []));
const importReportWarningCount = computed(() =>
  importReport.value ? importReport.value.volatileReferences.length + importReport.value.unmatchedReferences.length + importReport.value.externalReferences.length : 0
);
const browserStoragePercent = computed(() => (browserStorage.value.quota ? Math.min(100, Math.round((browserStorage.value.usage / browserStorage.value.quota) * 100)) : 0));
const codeExpiresText = computed(() => {
  const seconds = Math.max(0, Math.ceil((auth.codeExpiresAt - nowTick.value) / 1000));
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
});
const syncQueueSummary = computed(() => {
  const summary = {
    diaryWrites: 0,
    diaryDeletes: 0,
    settingsChanges: 0,
    otherChanges: 0
  };
  for (const item of store.syncQueueItems) {
    if (item.type === "diary:delete") summary.diaryDeletes += 1;
    else if (item.type.startsWith("diary:")) summary.diaryWrites += 1;
    else if (item.type.startsWith("settings:")) summary.settingsChanges += 1;
    else summary.otherChanges += 1;
  }
  return summary;
});
const visibleSyncQueueItems = computed(() => store.syncQueueItems.slice(-5).reverse());

onMounted(async () => {
  await refreshAiStatus();
  await store.refreshPendingSyncCount();
  await refreshFileStats();
  await refreshBrowserStorage();
  await refreshLocalAssets();
  await refreshUploadedFiles();
  clockTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  window.clearInterval(clockTimer);
});

async function refreshAiStatus(showToast = false) {
  checkingAiStatus.value = true;
  try {
    const status = await getAiStatus();
    store.aiAvailable = status.available;
    aiMessage.value = status.message;
    if (showToast) {
      ui.showToast(status.available ? "AI 服务可用" : "AI 服务未配置", status.available ? "success" : "warning");
    }
  } catch {
    store.aiAvailable = false;
    aiMessage.value = "AI 服务暂时不可用";
    if (showToast) ui.showToast("AI 服务暂时不可用", "warning");
  } finally {
    checkingAiStatus.value = false;
  }
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function addImageReference(references: Map<string, ImageReference[]>, url: string | undefined, reference: ImageReference) {
  if (!url) return;
  const existing = references.get(url) ?? [];
  existing.push(reference);
  references.set(url, existing);
}

function getAssetReferences(url: string) {
  return imageReferenceLookup.value.get(url) ?? [];
}

function countReferencedDiaries(references: ImageReference[]) {
  return new Set(references.map((reference) => reference.diaryId)).size;
}

function formatAssetUsage(url: string) {
  const references = getAssetReferences(url);
  if (!references.length) return "未使用";
  const diaryCount = countReferencedDiaries(references);
  return diaryCount === 1 ? `使用中 · ${references.length} 处` : `使用中 · ${diaryCount} 篇`;
}

function openImageIssueInEditor(issue: ImageReferenceIssue) {
  const [, target, field] = issue.id.split(":");
  router.push({
    path: `/diaries/${issue.diaryId}/edit`,
    query: target === "card" ? { repair: "card", issue: issue.id } : { repair: "sticker", stickerId: target, field, issue: issue.id }
  });
}

function confirmAssetRemoval(filename: string, source: "本地" | "云端", references: ImageReference[]) {
  if (!references.length) return window.confirm(`确定移除这个${source}素材「${filename}」吗？`);
  const diaryCount = countReferencedDiaries(references);
  const preview = references
    .slice(0, 5)
    .map((reference) => `${reference.diaryDate} · ${reference.label}`)
    .join("\n");
  const more = references.length > 5 ? `\n还有 ${references.length - 5} 处引用未显示。` : "";
  return window.confirm(
    `这个${source}素材「${filename}」正在被 ${diaryCount} 篇日记的 ${references.length} 处使用：\n${preview}${more}\n\n移除后，对应日记里的图片可能无法显示。仍要移除吗？`
  );
}

function isVolatileImageUrl(url?: string): url is string {
  return Boolean(url?.startsWith("blob:"));
}

function isEmbeddedImageUrl(url?: string) {
  return Boolean(url?.startsWith("data:image/"));
}

function isExternalImageUrl(url?: string) {
  return Boolean(url && (/^https?:\/\//.test(url) || url.startsWith("/uploads/") || url.startsWith("uploads/")));
}

function isCheckableImageUrl(url?: string): url is string {
  return Boolean(url && !isVolatileImageUrl(url));
}

function normalizeImageUrlForCheck(url: string) {
  return url.startsWith("uploads/") ? `/${url}` : url;
}

function collectDiaryImageReferences(diaries: Diary[]) {
  const references: ImageReferenceIssue[] = [];
  for (const diary of diaries) {
    if (diary.cardImageUrl) {
      references.push({
        id: `${diary.id}:card`,
        diaryId: diary.id,
        diaryDate: diary.date,
        label: "卡片预览图",
        reason: "",
        url: diary.cardImageUrl
      });
    }
    diary.stickers.forEach((sticker, index) => {
      [
        { key: "file", label: `贴纸 ${index + 1}`, url: sticker.fileUrl },
        { key: "source", label: `贴纸 ${index + 1} 原图`, url: sticker.sourceImageUrl },
        { key: "original", label: `贴纸 ${index + 1} 抠图源`, url: sticker.originalFileUrl }
      ].forEach((item) => {
        if (!item.url) return;
        references.push({
          id: `${diary.id}:${sticker.id}:${item.key}`,
          diaryId: diary.id,
          diaryDate: diary.date,
          label: item.label,
          reason: "",
          url: item.url
        });
      });
    });
  }
  return references;
}

function buildImportReport(diaries: Diary[], assets: LocalAsset[], diaryCount: number): BackupImportReport {
  const assetUrls = new Set(assets.map((asset) => asset.url));
  const references = collectDiaryImageReferences(diaries);
  const embeddedReferences = references.filter((reference) => isEmbeddedImageUrl(reference.url));
  const restoredLocalReferences = references.filter((reference) => assetUrls.has(reference.url));
  const externalReferences = references.filter((reference) => isExternalImageUrl(reference.url));
  const volatileReferences = references.filter((reference) => isVolatileImageUrl(reference.url));
  const knownReferenceIds = new Set([...embeddedReferences, ...restoredLocalReferences, ...externalReferences, ...volatileReferences].map((reference) => reference.id));
  return {
    importedAt: new Date().toISOString(),
    diaryCount,
    restoredAssets: assets.length,
    totalReferences: references.length,
    embeddedReferences: embeddedReferences.length,
    restoredLocalReferences: restoredLocalReferences.length,
    externalReferences: externalReferences.map((reference) => ({
      ...reference,
      reason: "依赖云端或外部地址，不会随 JSON 备份一起离线保存"
    })),
    volatileReferences: volatileReferences.map((reference) => ({
      ...reference,
      reason: "使用浏览器临时链接，导入后可能无法继续显示"
    })),
    unmatchedReferences: references
      .filter((reference) => !knownReferenceIds.has(reference.id))
      .map((reference) => ({
        ...reference,
        reason: "没有命中本地素材库，也不是可识别的嵌入或云端图片"
      }))
  };
}

async function refreshFileStats() {
  if (!auth.token) {
    fileStats.value = { storage: "未登录", count: 0, totalSize: 0 };
    return;
  }
  try {
    fileStats.value = await getFileStats(auth.token);
  } catch {
    fileStats.value = { storage: "不可用", count: 0, totalSize: 0 };
  }
}

async function refreshUploadedFiles() {
  if (!auth.token) {
    uploadedFiles.value = [];
    return;
  }
  loadingFiles.value = true;
  try {
    const result = await listUploadedFiles(auth.token);
    uploadedFiles.value = result.items;
  } catch {
    uploadedFiles.value = [];
  } finally {
    loadingFiles.value = false;
  }
}

async function refreshLocalAssets() {
  localAssets.value = await listLocalAssets();
}

async function refreshBrowserStorage() {
  const storage = navigator.storage as BrowserStorageManager | undefined;
  if (!storage?.estimate) {
    browserStorage.value = {
      available: false,
      usage: 0,
      quota: 0,
      persisted: false,
      message: "当前浏览器暂不支持存储空间估算"
    };
    return;
  }
  try {
    const estimate = await storage.estimate();
    const persisted = typeof storage.persisted === "function" ? await storage.persisted() : false;
    browserStorage.value = {
      available: true,
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
      persisted,
      message: persisted ? "浏览器已尽量保留本地数据" : "系统空间紧张时，本地数据仍可能被清理"
    };
  } catch {
    browserStorage.value = {
      available: false,
      usage: 0,
      quota: 0,
      persisted: false,
      message: "存储空间估算失败"
    };
  }
}

async function requestPersistentStorage() {
  const storage = navigator.storage as BrowserStorageManager | undefined;
  if (!storage || typeof storage.persist !== "function") {
    ui.showToast("当前浏览器不支持持久保存请求", "warning");
    return;
  }
  const granted = await storage.persist();
  await refreshBrowserStorage();
  ui.showToast(granted ? "已请求浏览器持久保存本地数据" : "浏览器没有授予持久保存", granted ? "success" : "warning");
}

function canLoadImage(url: string, timeoutMs = 5000) {
  return new Promise<boolean>((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = normalizeImageUrlForCheck(url);
  });
}

async function checkImageAccessHealth() {
  const references = collectDiaryImageReferences(store.diaries).filter((reference) => isCheckableImageUrl(reference.url));
  if (!references.length) {
    imageAccessIssues.value = [];
    imageAccessCheckedAt.value = new Date().toISOString();
    ui.showToast("当前没有可检查的图片引用", "info");
    return;
  }

  const groupedReferences = new Map<string, ImageReferenceIssue[]>();
  for (const reference of references) {
    const url = normalizeImageUrlForCheck(reference.url);
    groupedReferences.set(url, [...(groupedReferences.get(url) ?? []), { ...reference, url }]);
  }

  checkingImageRefs.value = true;
  const failedReferences: ImageReferenceIssue[] = [];
  try {
    const entries = [...groupedReferences.entries()];
    for (let index = 0; index < entries.length; index += 6) {
      const results = await Promise.all(
        entries.slice(index, index + 6).map(async ([url, refs]) => ({
          ok: await canLoadImage(url),
          refs
        }))
      );
      for (const result of results) {
        if (result.ok) continue;
        failedReferences.push(
          ...result.refs.map((reference) => ({
            ...reference,
            reason: "图片地址无法加载，可能已被删除、过期，或当前网络不可用"
          }))
        );
      }
    }
    imageAccessIssues.value = failedReferences;
    imageAccessCheckedAt.value = new Date().toISOString();
    ui.showToast(failedReferences.length ? `发现 ${failedReferences.length} 处图片无法加载` : "图片可访问性检查通过", failedReferences.length ? "warning" : "success");
  } finally {
    checkingImageRefs.value = false;
  }
}

async function localAssetToFile(asset: LocalAsset) {
  const response = await fetch(asset.url);
  const blob = await response.blob();
  const mimeType = blob.type || asset.mimeType || "image/jpeg";
  const filename = asset.filename?.trim() || `local-asset-${asset.id}.jpg`;
  return new File([blob], filename, { type: mimeType, lastModified: Date.now() });
}

function replaceDiaryImageReferences(diary: Diary, replacements: Map<string, string>) {
  let changed = false;
  let changedReferenceCount = 0;
  const replaceUrl = (url?: string) => {
    const next = url ? replacements.get(url) : undefined;
    if (!next) return url;
    changed = true;
    changedReferenceCount += 1;
    return next;
  };
  const cardImageUrl = replaceUrl(diary.cardImageUrl);
  const stickers = diary.stickers.map((sticker) => {
    const fileUrl = replaceUrl(sticker.fileUrl) ?? sticker.fileUrl;
    const sourceImageUrl = replaceUrl(sticker.sourceImageUrl);
    const originalFileUrl = replaceUrl(sticker.originalFileUrl);
    if (fileUrl === sticker.fileUrl && sourceImageUrl === sticker.sourceImageUrl && originalFileUrl === sticker.originalFileUrl) return sticker;
    return {
      ...sticker,
      fileUrl,
      sourceImageUrl,
      originalFileUrl
    };
  });
  if (!changed) return null;
  return {
    patch: {
      cardImageUrl,
      stickers
    } satisfies Partial<Diary>,
    changedReferenceCount
  };
}

async function migrateLocalAssetsToCloud() {
  if (!auth.token) {
    ui.showToast("请先登录后再上云本地素材", "warning");
    return;
  }
  const assets = migratableLocalAssets.value;
  const { count, totalSize, referenceCount } = migratableLocalAssetStats.value;
  if (!assets.length) {
    ui.showToast("没有需要上云的使用中本地素材", "info");
    return;
  }
  const confirmed = window.confirm(`确定将 ${count} 个使用中的本地素材上传云端吗？预计上传 ${formatBytes(totalSize)}，并更新 ${referenceCount} 处日记图片引用。未使用素材不会上传。`);
  if (!confirmed) return;

  const token = auth.token;
  migratingLocalAssets.value = true;
  const replacements = new Map<string, string>();
  let failedCount = 0;
  let pushed = false;
  try {
    for (const asset of assets) {
      try {
        const file = await localAssetToFile(asset);
        const uploaded = await uploadImage(token, file);
        replacements.set(asset.url, uploaded.url);
      } catch {
        failedCount += 1;
      }
    }

    let changedDiaryCount = 0;
    let changedReferenceCount = 0;
    if (replacements.size) {
      for (const diary of [...store.diaries]) {
        const result = replaceDiaryImageReferences(diary, replacements);
        if (!result) continue;
        await store.updateDiary(diary.id, result.patch);
        changedDiaryCount += 1;
        changedReferenceCount += result.changedReferenceCount;
      }
    }

    if (changedDiaryCount) {
      try {
        await store.pushToCloud(token);
        pushed = true;
      } catch {
        store.syncState = "等待同步";
      }
    }

    await refreshFileStats();
    await refreshUploadedFiles();
    await refreshLocalAssets();
    await refreshBrowserStorage();

    if (!replacements.size) {
      ui.showToast("本地素材上云失败，请稍后再试", "warning");
      return;
    }
    const syncText = pushed ? "，已同步日记引用" : changedDiaryCount ? "，日记引用待同步" : "";
    const failedText = failedCount ? `，${failedCount} 个失败` : "";
    ui.showToast(`已上云 ${replacements.size} 个本地素材，更新 ${changedReferenceCount} 处引用${syncText}${failedText}`, failedCount || !pushed ? "warning" : "success");
  } finally {
    migratingLocalAssets.value = false;
  }
}

async function removeUploadedFile(id: string) {
  if (!auth.token) return;
  const file = uploadedFiles.value.find((item) => item.id === id);
  const confirmed = confirmAssetRemoval(file?.filename ?? "未命名素材", "云端", file ? getAssetReferences(file.url) : []);
  if (!confirmed) return;
  try {
    const result = await deleteUploadedFile(auth.token, id);
    await refreshFileStats();
    await refreshUploadedFiles();
    ui.showToast(result.deletedMetadata ? "素材已移除" : "没有找到素材记录", result.deletedMetadata ? "success" : "warning");
  } catch {
    ui.showToast("素材移除失败", "warning");
  }
}

async function removeUnusedUploadedFiles() {
  if (!auth.token) {
    ui.showToast("请先登录后再清理云端素材", "warning");
    return;
  }
  const { unusedAssets, unusedSize } = uploadedAssetReferenceStats.value;
  if (!unusedAssets.length) {
    ui.showToast("没有可清理的未使用云端素材", "info");
    return;
  }
  const confirmed = window.confirm(`确定清理 ${unusedAssets.length} 个未使用云端素材吗？预计释放 ${formatBytes(unusedSize)}。正在被日记引用的素材会保留。`);
  if (!confirmed) return;
  try {
    await Promise.all(unusedAssets.map((asset) => deleteUploadedFile(auth.token!, asset.id)));
    await refreshFileStats();
    await refreshUploadedFiles();
    ui.showToast(`已清理 ${unusedAssets.length} 个未使用云端素材`, "success");
  } catch {
    await refreshFileStats();
    await refreshUploadedFiles();
    ui.showToast("部分云端素材清理失败，请稍后再试", "warning");
  }
}

async function removeLocalAsset(id: string) {
  const asset = localAssets.value.find((item) => item.id === id);
  const confirmed = confirmAssetRemoval(asset?.filename ?? "未命名素材", "本地", asset ? getAssetReferences(asset.url) : []);
  if (!confirmed) return;
  await deleteLocalAsset(id);
  await refreshLocalAssets();
  await refreshBrowserStorage();
  ui.showToast("本地素材已移除", "success");
}

async function removeUnusedLocalAssets() {
  const { unusedAssets, unusedSize } = localAssetReferenceStats.value;
  if (!unusedAssets.length) {
    ui.showToast("没有可清理的未使用本地素材", "info");
    return;
  }
  const confirmed = window.confirm(`确定清理 ${unusedAssets.length} 个未使用本地素材吗？预计释放 ${formatBytes(unusedSize)}。正在被日记引用的素材会保留。`);
  if (!confirmed) return;
  await Promise.all(unusedAssets.map((asset) => deleteLocalAsset(asset.id)));
  await refreshLocalAssets();
  await refreshBrowserStorage();
  ui.showToast(`已清理 ${unusedAssets.length} 个未使用素材`, "success");
}

function normalizeBackupAssets(assets: unknown): LocalAsset[] {
  if (!Array.isArray(assets)) return [];
  return assets
    .map((asset) => asset as Partial<LocalAsset>)
    .filter((asset) => typeof asset.url === "string" && asset.url.length > 0)
    .map((asset) => ({
      id: typeof asset.id === "string" && asset.id ? asset.id : crypto.randomUUID(),
      filename: typeof asset.filename === "string" && asset.filename ? asset.filename : "photo.jpg",
      mimeType: typeof asset.mimeType === "string" && asset.mimeType ? asset.mimeType : "image/jpeg",
      size: typeof asset.size === "number" && Number.isFinite(asset.size) ? asset.size : 0,
      url: String(asset.url),
      createdAt: typeof asset.createdAt === "string" && asset.createdAt ? asset.createdAt : new Date().toISOString()
    }));
}

async function exportBackup() {
  const assets = await listLocalAssets();
  const report = buildImportReport(store.diaries, assets, store.diaries.length);
  const backup: DiaryBackup = {
    ...store.createBackup(),
    version: 3,
    assets
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `贴贴日记备份-${formatLocalDateKey()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  const warningCount = report.volatileReferences.length + report.unmatchedReferences.length + report.externalReferences.length;
  ui.showToast(warningCount ? `备份已导出，${warningCount} 处图片引用需确认` : "备份已导出，图片引用完整", warningCount ? "warning" : "success");
}

function readJsonFile(file: File) {
  return new Promise<DiaryBackup>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)) as DiaryBackup);
      } catch {
        reject(new Error("备份文件不是有效 JSON"));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importBackup(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const backup = await readJsonFile(file);
    const count = await store.importBackup(backup);
    const assets = normalizeBackupAssets(backup.assets);
    await Promise.all(assets.map((asset) => saveLocalAsset(asset)));
    await refreshLocalAssets();
    await refreshBrowserStorage();
    importReport.value = buildImportReport(backup.diaries, assets, count);
    const warningCount = importReport.value.volatileReferences.length + importReport.value.unmatchedReferences.length + importReport.value.externalReferences.length;
    ui.showToast(
      `已导入 ${count} 篇日记${assets.length ? `，恢复 ${assets.length} 个本地素材` : ""}${warningCount ? `，${warningCount} 处图片引用需确认` : ""}`,
      warningCount ? "warning" : "success"
    );
  } catch (error) {
    ui.showToast(error instanceof Error ? error.message : "导入失败", "warning");
  } finally {
    input.value = "";
  }
}

async function clearLocalData() {
  const confirmed = window.confirm("确定清空本地日记、素材和同步队列吗？这个操作不会清理已经导出的备份文件。");
  if (!confirmed) return;
  await store.clearAllLocalData();
  await clearLocalAssets();
  await refreshLocalAssets();
  await refreshBrowserStorage();
  importReport.value = null;
  ui.showToast("本地数据已清空", "warning");
}

function syncQueuePayload(item: SyncQueueItem) {
  return item.payload && typeof item.payload === "object" ? (item.payload as Record<string, unknown>) : {};
}

function syncQueueLabel(item: SyncQueueItem) {
  if (item.type === "diary:create") return "新日记";
  if (item.type === "diary:update") return "日记更新";
  if (item.type === "diary:delete") return "删除日记";
  if (item.type === "diary:restore") return "恢复日记";
  if (item.type === "diary:import") return "导入日记";
  if (item.type.startsWith("settings:")) return "设置更新";
  return item.type;
}

function syncPayloadStatusLabel(status: unknown) {
  const labels: Record<string, string> = {
    draft: "草稿",
    processing: "处理中",
    done: "已完成",
    syncing: "同步中",
    sync_failed: "同步失败"
  };
  return typeof status === "string" ? labels[status] ?? status : "";
}

function syncQueueDetail(item: SyncQueueItem) {
  const payload = syncQueuePayload(item);
  if (item.type.startsWith("settings:")) return "创作偏好";
  const date = typeof payload.date === "string" ? payload.date : "";
  const id = typeof payload.id === "string" ? payload.id.slice(0, 8) : "";
  const status = syncPayloadStatusLabel(payload.status);
  return [date, status, id].filter(Boolean).join(" · ") || "等待同步";
}

async function refreshSyncDiagnostics(showToast = false) {
  await store.refreshPendingSyncCount();
  if (showToast) ui.showToast("同步诊断已刷新", "success");
}

async function compactSyncDiagnostics() {
  await store.compactPendingSyncQueue();
  const compactedCount = store.lastSyncQueueCompactedCount;
  ui.showToast(compactedCount > 0 ? `已合并 ${compactedCount} 项重复同步` : "同步队列已经是最简状态", compactedCount > 0 ? "success" : "info");
}

async function sendLoginCode() {
  const ok = await auth.sendCode(email.value);
  if (auth.devCode) code.value = auth.devCode;
  ui.showToast(ok ? "验证码已发送" : "验证码发送失败", ok ? "success" : "warning");
}

async function loginAndSync() {
  const ok = await auth.verify(email.value, code.value);
  if (!ok || !auth.token) {
    ui.showToast("登录失败", "warning");
    return;
  }

  try {
    await store.syncWithCloud(auth.token);
    await refreshFileStats();
    await refreshUploadedFiles();
    await refreshSyncDiagnostics();
    ui.showToast("登录成功，已同步云端", "success");
  } catch {
    store.syncState = "等待同步";
    ui.showToast("登录成功，同步稍后再试", "warning");
  }
}

async function saveWritingStyle(value: string) {
  await settings.updateSettings({ defaultWritingStyle: value as (typeof writingStyles)[number] });
  await refreshSyncDiagnostics();
  ui.showToast("默认文字风格已保存", "success");
}

async function saveDiaryLength(value: string) {
  await settings.updateSettings({ defaultDiaryLength: value as (typeof diaryLengths)[number] });
  await refreshSyncDiagnostics();
  ui.showToast("默认日记长度已保存", "success");
}

async function saveBackground(value: string) {
  await settings.updateSettings({ defaultBackground: value as (typeof backgrounds)[number] });
  await refreshSyncDiagnostics();
  ui.showToast("默认背景已保存", "success");
}

async function resetPreferences() {
  await settings.resetSettings();
  await refreshSyncDiagnostics();
  ui.showToast("创作偏好已恢复默认", "success");
}

async function requireLoginSync(action: "push" | "pull" | "both") {
  if (!auth.token) {
    ui.showToast("请先登录邮箱账号", "warning");
    return;
  }
  try {
    if (action === "push") {
      await store.pushToCloud(auth.token);
      await refreshUploadedFiles();
      await refreshSyncDiagnostics();
      ui.showToast("已上传到云端", "success");
    } else if (action === "pull") {
      await store.pullFromCloud(auth.token);
      await refreshUploadedFiles();
      await refreshSyncDiagnostics();
      ui.showToast("已从云端拉取", "success");
    } else {
      await store.syncWithCloud(auth.token);
      await refreshUploadedFiles();
      await refreshSyncDiagnostics();
      ui.showToast("云同步完成", "success");
    }
  } catch {
    store.syncState = "同步失败";
    ui.showToast("同步失败，请稍后再试", "warning");
  }
}
</script>

<template>
  <section class="settings-page">
    <input ref="importInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importBackup" />

    <div class="page-title">
      <p class="eyebrow">Settings</p>
      <h1>设置</h1>
    </div>

    <section class="section-block">
      <div class="section-heading">
        <h2>账号</h2>
        <span>{{ auth.isLoggedIn ? "已登录" : "邮箱验证码" }}</span>
      </div>

      <div v-if="auth.isLoggedIn" class="account-box">
        <strong>{{ auth.user?.email }}</strong>
        <p>登录后会用于自动云端备份和多设备同步。</p>
        <button class="secondary-action" type="button" @click="auth.logout">退出登录</button>
      </div>

      <div v-else class="form-grid">
        <label>邮箱<input v-model="email" type="email" placeholder="you@example.com" /></label>
        <button class="secondary-action" type="button" :disabled="auth.sending || !email || resendSeconds > 0" @click="sendLoginCode">
          {{ auth.sending ? "发送中" : resendSeconds > 0 ? `${resendSeconds}s 后重发` : "发送验证码" }}
        </button>
        <label>验证码<input v-model="code" inputmode="numeric" placeholder="输入邮箱验证码" /></label>
        <p v-if="auth.devCode" class="dev-code-copy">本地开发验证码：{{ auth.devCode }}<span v-if="codeExpiresText"> · {{ codeExpiresText }} 后过期</span></p>
        <button class="primary-action" type="button" :disabled="auth.verifying || store.syncing || !email || !code" @click="loginAndSync">
          {{ auth.verifying || store.syncing ? "处理中" : "登录并同步" }}
        </button>
        <p class="subtle-copy">{{ auth.message || "开发环境会先走接口骨架，后续接真实邮件服务。" }}</p>
      </div>
    </section>

    <details class="section-block advanced-settings">
      <summary>本地数据</summary>
      <div class="section-heading">
        <h2>本地数据</h2>
        <span>{{ store.diaries.length }} 篇日记</span>
      </div>
      <div class="tool-grid small-tools">
        <button type="button" @click="exportBackup">导出备份</button>
        <button type="button" @click="importInput?.click()">导入备份</button>
        <button type="button" @click="clearLocalData">清空本地</button>
      </div>
      <p class="subtle-copy">备份会保存日记、贴纸、涂鸦和创作偏好。日常只需要在换手机或清理设备前导出一次。</p>
      <details class="advanced-settings">
        <summary>备份检查</summary>
      <div class="health-panel import-health-panel" :class="backupPreflightWarningCount ? 'warning-panel' : 'ok-panel'">
        <div>
          <strong>当前备份预检</strong>
          <p>
            将导出 {{ backupPreflightReport.diaryCount }} 篇日记和 {{ backupPreflightReport.restoredAssets }} 个本地素材；当前有
            {{ backupPreflightReport.totalReferences }} 处图片引用。
          </p>
        </div>
        <div class="integrity-stats">
          <span>嵌入图片：{{ backupPreflightReport.embeddedReferences }}</span>
          <span>素材库命中：{{ backupPreflightReport.restoredLocalReferences }}</span>
          <span>云端/外部：{{ backupPreflightReport.externalReferences.length }}</span>
          <span>临时/未知：{{ backupPreflightReport.volatileReferences.length + backupPreflightReport.unmatchedReferences.length }}</span>
        </div>
        <article v-for="issue in backupPreflightIssues" :key="issue.id" class="health-row">
          <div>
            <strong>{{ issue.diaryDate }} · {{ issue.label }}</strong>
            <span>{{ issue.reason }}</span>
          </div>
          <button type="button" class="secondary-action compact-action" @click="openImageIssueInEditor(issue)">打开检查</button>
        </article>
        <p v-if="backupPreflightWarningCount > backupPreflightIssues.length" class="subtle-copy">
          还有 {{ backupPreflightWarningCount - backupPreflightIssues.length }} 处图片引用未显示。
        </p>
      </div>
      <div v-if="importReport" class="health-panel import-health-panel" :class="importReportWarningCount ? 'warning-panel' : 'ok-panel'">
        <div>
          <strong>最近导入检查</strong>
          <p>
            已导入 {{ importReport.diaryCount }} 篇日记，恢复 {{ importReport.restoredAssets }} 个本地素材；检查到
            {{ importReport.totalReferences }} 处图片引用。
          </p>
        </div>
        <div class="integrity-stats">
          <span>嵌入图片：{{ importReport.embeddedReferences }}</span>
          <span>素材库命中：{{ importReport.restoredLocalReferences }}</span>
          <span>云端/外部：{{ importReport.externalReferences.length }}</span>
          <span>临时/未知：{{ importReport.volatileReferences.length + importReport.unmatchedReferences.length }}</span>
        </div>
        <article v-for="issue in importReportIssues" :key="issue.id" class="health-row">
          <div>
            <strong>{{ issue.diaryDate }} · {{ issue.label }}</strong>
            <span>{{ issue.reason }}</span>
          </div>
          <button type="button" class="secondary-action compact-action" @click="openImageIssueInEditor(issue)">打开检查</button>
        </article>
        <p v-if="importReportWarningCount > importReportIssues.length" class="subtle-copy">
          还有 {{ importReportWarningCount - importReportIssues.length }} 处图片引用未显示。
        </p>
      </div>
      </details>
    </details>

    <section class="section-block">
      <div class="section-heading">
        <h2>创作偏好</h2>
        <span>新草稿默认值</span>
      </div>
      <div class="form-grid">
        <label>
          默认文字风格
          <select :value="settings.values.defaultWritingStyle" @change="saveWritingStyle(($event.target as HTMLSelectElement).value)">
            <option v-for="style in writingStyles" :key="style">{{ style }}</option>
          </select>
        </label>
        <label>
          默认日记长度
          <select :value="settings.values.defaultDiaryLength" @change="saveDiaryLength(($event.target as HTMLSelectElement).value)">
            <option v-for="length in diaryLengths" :key="length">{{ length }}</option>
          </select>
        </label>
        <label>
          默认卡片背景
          <select :value="settings.values.defaultBackground" @change="saveBackground(($event.target as HTMLSelectElement).value)">
            <option v-for="background in backgrounds" :key="background">{{ background }}</option>
          </select>
        </label>
      </div>
      <div class="hero-actions compact">
        <button class="secondary-action" type="button" @click="resetPreferences">恢复默认</button>
      </div>
      <p class="subtle-copy">这些偏好会保存在本机，新建空白草稿或从照片开始时会自动套用。</p>
    </section>

    <details class="section-block advanced-settings">
      <summary>云同步</summary>
      <div class="section-heading">
        <h2>云同步</h2>
        <span>{{ store.syncing ? "同步中" : store.syncState }}</span>
      </div>
      <div class="tool-grid small-tools">
        <button type="button" :disabled="store.syncing || !auth.isLoggedIn" @click="requireLoginSync('push')">上传云端</button>
        <button type="button" :disabled="store.syncing || !auth.isLoggedIn" @click="requireLoginSync('pull')">拉取云端</button>
        <button type="button" :disabled="store.syncing || !auth.isLoggedIn" @click="requireLoginSync('both')">双向同步</button>
      </div>
      <p class="subtle-copy">登录后会自动备份到云端；离线时会先保存在本机，联网后继续同步。</p>
    </details>

    <details class="advanced-settings">
      <summary>同步诊断</summary>
    <div class="health-panel sync-diagnostics-panel" :class="store.pendingSyncCount ? 'warning-panel' : 'ok-panel'">
      <div>
        <strong>同步诊断</strong>
        <p>待同步 {{ store.pendingSyncCount }} 项。队列会自动合并同一篇日记的重复改动，离线编辑后可以在这里确认还剩什么。</p>
      </div>
      <div class="integrity-stats">
        <span>日记写入: {{ syncQueueSummary.diaryWrites }}</span>
        <span>日记删除: {{ syncQueueSummary.diaryDeletes }}</span>
        <span>设置更新: {{ syncQueueSummary.settingsChanges }}</span>
        <span>其他项目: {{ syncQueueSummary.otherChanges }}</span>
      </div>
      <div class="hero-actions compact">
        <button class="secondary-action" type="button" :disabled="store.syncing" @click="refreshSyncDiagnostics(true)">刷新诊断</button>
        <button class="secondary-action" type="button" :disabled="store.syncing || !store.pendingSyncCount" @click="compactSyncDiagnostics">整理队列</button>
        <button class="secondary-action" type="button" :disabled="store.syncing || !auth.isLoggedIn || !store.pendingSyncCount" @click="requireLoginSync('both')">重试同步</button>
      </div>
      <div v-if="visibleSyncQueueItems.length" class="sync-queue-list">
        <article v-for="item in visibleSyncQueueItems" :key="item.id" class="health-row">
          <div>
            <strong>{{ syncQueueLabel(item) }}</strong>
            <span>{{ syncQueueDetail(item) }}</span>
          </div>
          <span class="sync-item-type">{{ item.type }}</span>
        </article>
      </div>
      <span v-else>当前没有等待同步的本地改动。</span>
    </div>
    </details>

    <details class="section-block advanced-settings">
      <summary>照片存储与高级维护</summary>
      <div class="section-heading">
        <h2>图片素材</h2>
        <span>{{ auth.isLoggedIn ? fileStats.storage : "本地素材库" }}</span>
      </div>
      <div class="settings-list compact-settings">
        <article>
          <span>云端素材</span>
          <strong>{{ fileStats.count }} 个</strong>
        </article>
        <article>
          <span>云端空间</span>
          <strong>{{ formatBytes(fileStats.totalSize) }}</strong>
        </article>
        <article>
          <span>云端使用中</span>
          <strong>{{ uploadedAssetReferenceStats.usedCount }} 个</strong>
        </article>
        <article>
          <span>云端未使用</span>
          <strong>{{ uploadedAssetReferenceStats.unusedCount }} 个 · {{ formatBytes(uploadedAssetReferenceStats.unusedSize) }}</strong>
        </article>
        <article>
          <span>本地素材</span>
          <strong>{{ localAssetStats.count }} 个</strong>
        </article>
        <article>
          <span>本地空间</span>
          <strong>{{ formatBytes(localAssetStats.totalSize) }}</strong>
        </article>
        <article>
          <span>可上云</span>
          <strong>{{ migratableLocalAssetStats.count }} 个 · {{ formatBytes(migratableLocalAssetStats.totalSize) }}</strong>
        </article>
        <article>
          <span>使用中</span>
          <strong>{{ localAssetReferenceStats.usedCount }} 个</strong>
        </article>
        <article>
          <span>可清理</span>
          <strong>{{ localAssetReferenceStats.unusedCount }} 个 · {{ formatBytes(localAssetReferenceStats.unusedSize) }}</strong>
        </article>
        <article>
          <span>临时引用</span>
          <strong>{{ volatileImageIssues.length }} 个</strong>
        </article>
        <article>
          <span>失效引用</span>
          <strong>{{ imageAccessCheckedAt ? `${imageAccessIssues.length} / ${checkableImageReferenceCount}` : "未检查" }}</strong>
        </article>
        <article>
          <span>浏览器已用</span>
          <strong>{{ browserStorage.available ? formatBytes(browserStorage.usage) : "未知" }}</strong>
        </article>
        <article>
          <span>可用额度</span>
          <strong>{{ browserStorage.available && browserStorage.quota ? formatBytes(browserStorage.quota) : "未知" }}</strong>
        </article>
        <article>
          <span>持久保存</span>
          <strong>{{ browserStorage.persisted ? "已开启" : browserStorage.available ? "未开启" : "不支持" }}</strong>
        </article>
      </div>
      <div class="storage-meter" :class="{ warning: browserStorage.available && browserStoragePercent >= 75 }">
        <span><i :style="{ width: `${browserStoragePercent}%` }" /></span>
        <strong>{{ browserStorage.available ? `${browserStoragePercent}%` : "未知" }}</strong>
      </div>
      <div class="hero-actions">
        <button class="secondary-action" type="button" :disabled="loadingFiles || migratingLocalAssets" @click="refreshFileStats(); refreshBrowserStorage(); refreshLocalAssets(); refreshUploadedFiles()">
          {{ loadingFiles ? "刷新中" : "刷新素材" }}
        </button>
        <button class="secondary-action" type="button" :disabled="browserStorage.persisted || !browserStorage.available" @click="requestPersistentStorage">
          {{ browserStorage.persisted ? "已持久保存" : "请求持久保存" }}
        </button>
        <button class="secondary-action" type="button" :disabled="checkingImageRefs || !checkableImageReferenceCount" @click="checkImageAccessHealth">
          {{ checkingImageRefs ? "检查中" : "检查图片可用性" }}
        </button>
        <button class="secondary-action" type="button" :disabled="migratingLocalAssets || !auth.isLoggedIn || !migratableLocalAssetStats.count" @click="migrateLocalAssetsToCloud">
          {{ migratingLocalAssets ? "上云中" : "本地素材上云" }}
        </button>
        <button class="secondary-action" type="button" :disabled="!auth.isLoggedIn || !uploadedAssetReferenceStats.unusedCount" @click="removeUnusedUploadedFiles">
          清理未使用云端
        </button>
        <button class="secondary-action" type="button" :disabled="!localAssetReferenceStats.unusedCount" @click="removeUnusedLocalAssets">
          清理未使用素材
        </button>
      </div>
      <div v-if="volatileImageIssues.length" class="health-panel warning-panel">
        <div>
          <strong>发现 {{ volatileImageIssues.length }} 个容易失效的图片引用</strong>
          <p>这些链接来自浏览器临时对象，刷新或重启后可能无法显示。打开对应日记后重新添加照片即可修复。</p>
        </div>
        <article v-for="issue in visibleVolatileImageIssues" :key="issue.id" class="health-row">
          <div>
            <strong>{{ issue.diaryDate }} · {{ issue.label }}</strong>
            <span>{{ issue.reason }}</span>
          </div>
          <button type="button" class="secondary-action compact-action" @click="openImageIssueInEditor(issue)">打开修复</button>
        </article>
        <p v-if="volatileImageIssues.length > visibleVolatileImageIssues.length" class="subtle-copy">
          还有 {{ volatileImageIssues.length - visibleVolatileImageIssues.length }} 个临时引用未显示。
        </p>
      </div>
      <div v-if="imageAccessCheckedAt && imageAccessIssues.length" class="health-panel warning-panel">
        <div>
          <strong>发现 {{ imageAccessIssues.length }} 处无法加载的图片引用</strong>
          <p>这些图片地址已经实际加载失败，建议打开对应日记替换照片，或先确认后端文件服务和网络是否正常。</p>
        </div>
        <article v-for="issue in visibleImageAccessIssues" :key="issue.id" class="health-row">
          <div>
            <strong>{{ issue.diaryDate }} · {{ issue.label }}</strong>
            <span>{{ issue.reason }}</span>
          </div>
          <button type="button" class="secondary-action compact-action" @click="openImageIssueInEditor(issue)">打开修复</button>
        </article>
        <p v-if="imageAccessIssues.length > visibleImageAccessIssues.length" class="subtle-copy">
          还有 {{ imageAccessIssues.length - visibleImageAccessIssues.length }} 处失效引用未显示。
        </p>
      </div>
      <div v-else-if="imageAccessCheckedAt" class="health-panel ok-panel">
        <strong>图片可访问性检查通过</strong>
        <span>已检查 {{ checkableImageReferenceCount }} 处非临时图片引用，没有发现加载失败。</span>
      </div>
      <div v-if="!volatileImageIssues.length && !imageAccessCheckedAt" class="health-panel ok-panel">
        <strong>图片引用健康</strong>
        <span>没有发现刷新后容易失效的临时图片链接；可继续手动检查云端和本地图片是否仍可加载。</span>
      </div>
      <div v-if="localAssets.length" class="asset-list">
        <article v-for="file in localAssets" :key="file.id" class="asset-row">
          <img :src="file.url" :alt="file.filename" />
          <div>
            <strong>{{ file.filename }}</strong>
            <span>本地 · {{ formatBytes(file.size) }} · {{ new Date(file.createdAt).toLocaleDateString() }} · {{ formatAssetUsage(file.url) }}</span>
          </div>
          <button type="button" class="text-danger" @click="removeLocalAsset(file.id)">移除</button>
        </article>
      </div>
      <div v-if="uploadedFiles.length" class="asset-list">
        <article v-for="file in uploadedFiles" :key="file.id" class="asset-row">
          <img :src="file.url" :alt="file.filename" />
          <div>
            <strong>{{ file.filename }}</strong>
            <span>云端 · {{ formatBytes(file.size) }} · {{ new Date(file.createdAt).toLocaleDateString() }} · {{ formatAssetUsage(file.url) }}</span>
          </div>
          <button type="button" class="text-danger" @click="removeUploadedFile(file.id)">移除</button>
        </article>
      </div>
      <p class="subtle-copy">{{ browserStorage.message }}。未登录或上传失败时，照片会进入本地素材库；登录后可将使用中的本地素材上云并自动更新日记引用。移除素材不会自动修改已经写好的日记。</p>
    </details>

    <section class="section-block quiet-settings">
      <div class="section-heading">
        <h2>隐私与智能功能</h2>
        <span>{{ checkingAiStatus ? "检查中" : store.aiAvailable ? "可用" : "未配置" }}</span>
      </div>
      <p class="subtle-copy">日记会先保存在这台设备；登录后才会同步到云端。AI 未配置时，生成日记和抠图会使用本地兜底体验。</p>
      <p class="subtle-copy">{{ aiMessage }}</p>
      <div class="hero-actions compact">
        <button class="secondary-action" type="button" :disabled="checkingAiStatus" @click="refreshAiStatus(true)">
          {{ checkingAiStatus ? "检查中" : "重新检查 AI 状态" }}
        </button>
      </div>
    </section>

    <section class="section-block quiet-settings">
      <div class="section-heading">
        <h2>关于贴贴日记</h2>
        <span>PWA</span>
      </div>
      <div class="settings-list">
        <article>
          <strong>隐私说明</strong>
          <span>本地草稿、素材和偏好优先保存在当前设备；登录同步、图片上传和 AI 处理只在你主动使用相关功能时发生。</span>
        </article>
        <article>
          <strong>AI 服务</strong>
          <span>前端只显示服务状态，不展示也不保存 API Key；密钥只应配置在后端环境变量中。</span>
        </article>
        <article>
          <strong>版本范围</strong>
          <span>当前版本聚焦照片日记、贴纸生成、手账编辑、回看、导出和同步，不包含公开社区和关注互动。</span>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { backgrounds, defaultTags, diaryLengths, moods, stickerVariants, writingStyles } from "@tietie/shared";
import type { Background, BoxSelection, Decoration, DecorationKind, Diary, DiaryLength, DoodleStroke, Mood, Sticker, StickerVariant, SubjectSelection, SubjectSelectionMode, WritingStyle } from "@tietie/shared";
import { computed, reactive, ref, watch, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deleteUploadedFile, generateDiary, listUploadedFiles, segmentSubject, stylizeSticker, uploadImage } from "../lib/api";
import { canvasToBlob, fileToDataUrl, preparePhotoFile } from "../lib/imageTools";
import { deleteLocalAsset, listLocalAssets, saveLocalAsset } from "../lib/localDb";
import { useAuthStore } from "../stores/authStore";
import { useDiaryStore } from "../stores/diaryStore";
import { useUiStore } from "../stores/uiStore";

interface AssetLibraryItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
  source: "local" | "cloud";
}

interface PreparedImageSource {
  url: string;
  localUrl: string;
  uploaded: boolean;
  compressed: boolean;
  filename: string;
  mimeType: string;
  size: number;
}

const route = useRoute();
const router = useRouter();
const store = useDiaryStore();
const auth = useAuthStore();
const ui = useUiStore();

const fileInput = ref<HTMLInputElement | null>(null);
const cameraInput = ref<HTMLInputElement | null>(null);
const canvasRef = ref<HTMLDivElement | null>(null);
const sourceFrameRef = ref<HTMLDivElement | null>(null);
const sourceImageRef = ref<HTMLImageElement | null>(null);
const selectedStickerId = ref<string | null>(null);
const selectedDecorationId = ref<string | null>(null);
const prompt = ref("");
const tagText = ref("");
const textDecoration = ref("今日份快乐");
const drawMode = ref(false);
const brushColor = ref("#ff7a85");
const brushSize = ref(5);
const selectionMode = ref<SubjectSelectionMode>("point");
const dragStart = ref<{ x: number; y: number } | null>(null);
const draftBox = ref<BoxSelection | null>(null);
const stickerDrag = ref<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(null);
const decorationDrag = ref<{ id: string; offsetX: number; offsetY: number; moved: boolean } | null>(null);
const activeStroke = ref<DoodleStroke | null>(null);
const aiNotice = ref("先添加照片，再点选或框选主体。登录后由后端生成贴纸，离线时会用本地效果。");
const autosaveState = ref("已保存到本地");
const generatingText = ref(false);
const assetPanelOpen = ref(false);
const assetLoading = ref(false);
const assetItems = ref<AssetLibraryItem[]>([]);
const brokenStickerIds = ref(new Set<string>());
const repairTargetStickerId = ref<string | null>(null);
const repairingCardImage = ref(false);
const brokenCardImage = ref(false);
const handledRepairRequest = ref("");
const savingDiary = ref(false);
let autosaveTimer = 0;

const diary = computed(() => store.getDiary(String(route.params.id)));
const selectedSticker = computed(() => diary.value?.stickers.find((sticker) => sticker.id === selectedStickerId.value));
const selectedDecoration = computed(() => (diary.value?.decorations ?? []).find((decoration) => decoration.id === selectedDecorationId.value));
const repairTargetSticker = computed(() => diary.value?.stickers.find((sticker) => sticker.id === repairTargetStickerId.value));
const isBusy = computed(() => selectedSticker.value?.status === "processing");
const hasSelection = computed(() => Boolean(selectedSticker.value?.selection));
const hasProcessedSubject = computed(() => {
  const sticker = selectedSticker.value;
  if (!sticker?.selection) return false;
  return Boolean(sticker.fileUrl && sticker.fileUrl !== (sticker.sourceImageUrl ?? sticker.originalFileUrl));
});
const canvasClass = computed(() => `bg-${form.background}`);
const cardImageNeedsRepair = computed(() => Boolean(diary.value?.cardImageUrl && (brokenCardImage.value || isVolatileImageUrl(diary.value.cardImageUrl))));
const isRepairing = computed(() => Boolean(repairTargetSticker.value || repairingCardImage.value));
const stickerHealthIssues = computed(() => {
  if (!diary.value) return [];
  return diary.value.stickers
    .map((sticker, index) => {
      const reasons = [];
      if (brokenStickerIds.value.has(sticker.id) || sticker.status === "failed") reasons.push("图片加载失败");
      if (stickerHasVolatileUrl(sticker)) reasons.push("使用临时图片链接");
      if (!reasons.length) return null;
      return {
        id: sticker.id,
        stickerId: sticker.id,
        label: `贴纸 ${index + 1}`,
        reason: reasons.join("，")
      };
    })
    .filter((issue): issue is { id: string; stickerId: string; label: string; reason: string } => Boolean(issue));
});
const selectedStickerNeedsRepair = computed(() => Boolean(selectedSticker.value && stickerNeedsRepair(selectedSticker.value)));
const currentStep = computed(() => {
  if (!diary.value?.stickers.length) return 1;
  if (!hasProcessedSubject.value) return 2;
  if (!form.body) return 5;
  return 5;
});
const activeEditorStep = ref(1);
const editorSteps = [
  { id: 1, label: "加照片" },
  { id: 2, label: "选主体" },
  { id: 3, label: "选风格" },
  { id: 4, label: "排版" },
  { id: 5, label: "保存" }
];
const activeStepTitle = computed(() => editorSteps.find((step) => step.id === activeEditorStep.value)?.label ?? "编辑");
const canGoNextStep = computed(() => {
  if (activeEditorStep.value === 1) return Boolean(diary.value?.stickers.length);
  if (activeEditorStep.value === 2) return hasProcessedSubject.value;
  if (activeEditorStep.value === 3) return Boolean(selectedSticker.value?.variant);
  if (activeEditorStep.value === 4) return true;
  return false;
});

const form = reactive({
  date: "",
  location: "",
  mood: "开心" as Mood,
  writingStyle: "可爱活泼" as WritingStyle,
  length: "一小段" as DiaryLength,
  background: "横线纸" as Background,
  body: ""
});

function readQueryValue(value: unknown) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

watchEffect(() => {
  if (!diary.value) return;
  form.date = diary.value.date;
  form.location = diary.value.location ?? "";
  form.mood = diary.value.mood;
  form.writingStyle = diary.value.writingStyle;
  form.length = diary.value.length;
  form.background = diary.value.background;
  form.body = diary.value.body;
  tagText.value = diary.value.tags.join(" ");
  selectedStickerId.value ??= diary.value.stickers[0]?.id ?? null;
});

watch(
  () => diary.value?.stickers.map((sticker) => sticker.id).join("|") ?? "",
  () => {
    const liveIds = new Set(diary.value?.stickers.map((sticker) => sticker.id) ?? []);
    brokenStickerIds.value = new Set([...brokenStickerIds.value].filter((id) => liveIds.has(id)));
    if (repairTargetStickerId.value && !liveIds.has(repairTargetStickerId.value)) repairTargetStickerId.value = null;
  },
  { immediate: true }
);

watch(
  () => diary.value?.cardImageUrl ?? "",
  (url) => {
    brokenCardImage.value = false;
    if (!url) repairingCardImage.value = false;
  },
  { immediate: true }
);

watch(
  () => ({
    diaryId: diary.value?.id ?? "",
    stickerIds: diary.value?.stickers.map((sticker) => sticker.id).join("|") ?? "",
    repair: readQueryValue(route.query.repair),
    stickerId: readQueryValue(route.query.stickerId),
    issue: readQueryValue(route.query.issue)
  }),
  async (request) => {
    if (!diary.value || !request.repair) return;
    const requestKey = `${request.diaryId}:${request.repair}:${request.stickerId}:${request.issue}`;
    if (handledRepairRequest.value === requestKey) return;
    handledRepairRequest.value = requestKey;

    if (request.repair === "card") {
      brokenCardImage.value = Boolean(diary.value.cardImageUrl);
      await startCardImageRepair();
      ui.showToast("已定位到卡片预览图修复", "info");
      return;
    }

    if (request.repair === "sticker" && request.stickerId) {
      const target = diary.value.stickers.find((sticker) => sticker.id === request.stickerId);
      if (!target) {
        ui.showToast("没有找到需要修复的贴纸", "warning");
        return;
      }
      const next = new Set(brokenStickerIds.value);
      next.add(target.id);
      brokenStickerIds.value = next;
      await startStickerRepair(target.id);
      ui.showToast("已定位到问题贴纸", "info");
    }
  },
  { immediate: true }
);

watch(
  () => ({ ...form, tags: tagText.value }),
  () => {
    if (!diary.value || !store.hydrated) return;
    autosaveState.value = "正在自动保存";
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(async () => {
      if (!diary.value) return;
      const tags = tagText.value
        .split(/[，,\s#]+/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      await store.updateDiary(diary.value.id, {
        date: form.date,
        location: form.location,
        mood: form.mood,
        writingStyle: form.writingStyle,
        length: form.length,
        background: form.background,
        body: form.body,
        tags
      });
      autosaveState.value = "已保存到本地";
    }, 700);
  },
  { deep: true }
);

function loadImageFromUrl(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = src;
  });
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function normalizeCrop(selection: SubjectSelection) {
  if (selection.mode === "box") {
    const pad = 5;
    const x = clampPercent(selection.x - pad);
    const y = clampPercent(selection.y - pad);
    return {
      x,
      y,
      width: Math.min(100 - x, Math.max(8, selection.width + pad * 2)),
      height: Math.min(100 - y, Math.max(8, selection.height + pad * 2))
    };
  }

  const size = 56;
  const x = clampPercent(selection.x - size / 2);
  const y = clampPercent(selection.y - size / 2);
  return {
    x,
    y,
    width: Math.min(size, 100 - x),
    height: Math.min(size, 100 - y)
  };
}

function colorDistance(a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number) {
  const dr = a[ai] - b[bi];
  const dg = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function removeConnectedBorderBackground(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  const { width, height } = canvas;
  const imageData = context.getImageData(0, 0, width, height);
  const data = imageData.data;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let head = 0;
  const threshold = 42;

  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < queue.length) {
    const index = queue[head];
    head += 1;
    const pixelIndex = index * 4;
    const x = index % width;
    const y = Math.floor(index / width);
    data[pixelIndex + 3] = 0;

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1
    ];

    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue;
      const nextPixelIndex = next * 4;
      if (data[nextPixelIndex + 3] < 20 || colorDistance(data, pixelIndex, data, nextPixelIndex) < threshold) {
        visited[next] = 1;
        queue.push(next);
      }
    }
  }

  context.putImageData(imageData, 0, 0);
}

function drawStickerSilhouette(context: CanvasRenderingContext2D, image: HTMLCanvasElement, padding: number, shadow = true) {
  const outlineSteps = [
    { offset: 16, color: "#ffffff" },
    { offset: 10, color: "#ffffff" },
    { offset: 5, color: "#ffffff" }
  ];

  context.save();
  if (shadow) {
    context.shadowColor = "rgba(38, 52, 71, 0.24)";
    context.shadowBlur = 10;
    context.shadowOffsetX = 8;
    context.shadowOffsetY = 12;
  }
  for (const step of outlineSteps) {
    context.filter = `drop-shadow(${step.offset}px 0 0 ${step.color}) drop-shadow(${-step.offset}px 0 0 ${step.color}) drop-shadow(0 ${step.offset}px 0 ${step.color}) drop-shadow(0 ${-step.offset}px 0 ${step.color})`;
    context.drawImage(image, padding, padding);
  }
  context.restore();

  context.drawImage(image, padding, padding);
}

async function createLocalSelectionSticker(sourceUrl: string, selection: SubjectSelection) {
  const image = await loadImageFromUrl(sourceUrl);
  const crop = normalizeCrop(selection);
  const sx = Math.round((crop.x / 100) * image.naturalWidth);
  const sy = Math.round((crop.y / 100) * image.naturalHeight);
  const sw = Math.max(1, Math.round((crop.width / 100) * image.naturalWidth));
  const sh = Math.max(1, Math.round((crop.height / 100) * image.naturalHeight));
  const scale = Math.min(1, 900 / Math.max(sw, sh));
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(sw * scale));
  cropCanvas.height = Math.max(1, Math.round(sh * scale));
  const cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
  if (!cropContext) throw new Error("画布创建失败");
  cropContext.drawImage(image, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
  removeConnectedBorderBackground(cropCanvas);

  const padding = 42;
  const canvas = document.createElement("canvas");
  canvas.width = cropCanvas.width + padding * 2;
  canvas.height = cropCanvas.height + padding * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画布创建失败");
  drawStickerSilhouette(context, cropCanvas, padding);
  return canvas.toDataURL("image/png");
}

function localVariantFilter(variant: StickerVariant) {
  const filters: Record<StickerVariant, string> = {
    白边原图贴纸: "saturate(1.08) contrast(1.04)",
    旅行插画风: "saturate(1.35) contrast(1.22) brightness(1.08)",
    像素风格: "saturate(1.35) contrast(1.18) brightness(1.05)",
    线条手绘风: "grayscale(1) contrast(1.65) brightness(1.12)",
    可爱漫画风: "saturate(1.65) contrast(1.22) brightness(1.06)",
    复古邮票风: "sepia(0.38) saturate(0.88) contrast(1.08) brightness(1.08)"
  };
  return filters[variant];
}

function drawLocalVariantDecoration(context: CanvasRenderingContext2D, width: number, height: number, variant: StickerVariant) {
  if (variant === "旅行插画风") {
    context.save();
    context.globalCompositeOperation = "source-atop";
    context.fillStyle = "rgba(25, 141, 232, 0.08)";
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  if (variant === "可爱漫画风") {
    context.save();
    context.globalCompositeOperation = "source-atop";
    context.fillStyle = "rgba(255, 207, 86, 0.12)";
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  if (variant === "像素风格") {
    context.save();
    context.globalCompositeOperation = "source-atop";
    context.fillStyle = "rgba(112, 191, 255, 0.12)";
    context.fillRect(0, 0, width, height);
    context.restore();
  }

  if (variant === "线条手绘风") {
    context.save();
    context.globalAlpha = 0.08;
    context.strokeStyle = "#2f6ea3";
    context.lineWidth = 2;
    for (let x = -height; x < width; x += 22) {
      context.beginPath();
      context.moveTo(x, height);
      context.lineTo(x + height, 0);
      context.stroke();
    }
    context.restore();
  }

  if (variant === "复古邮票风") {
    context.save();
    context.globalAlpha = 0.1;
    context.fillStyle = "#7a532e";
    for (let x = 0; x < width; x += 18) {
      for (let y = 0; y < height; y += 18) {
        context.fillRect(x, y, 2, 2);
      }
    }
    context.restore();
  }
}

async function createLocalVariantSticker(sourceUrl: string, variant: StickerVariant) {
  const image = await loadImageFromUrl(sourceUrl);
  const maxSide = 900;
  const padding = variant === "白边原图贴纸" || variant === "旅行插画风" || variant === "复古邮票风" ? 58 : 38;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const imageWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const imageHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const styledImage = document.createElement("canvas");
  styledImage.width = imageWidth;
  styledImage.height = imageHeight;
  const styledContext = styledImage.getContext("2d");
  if (!styledContext) throw new Error("画布创建失败");
  styledContext.filter = localVariantFilter(variant);
  if (variant === "像素风格") {
    const pixelCanvas = document.createElement("canvas");
    const pixelSide = Math.max(24, Math.round(Math.max(imageWidth, imageHeight) / 14));
    pixelCanvas.width = Math.max(1, Math.round((imageWidth / Math.max(imageWidth, imageHeight)) * pixelSide));
    pixelCanvas.height = Math.max(1, Math.round((imageHeight / Math.max(imageWidth, imageHeight)) * pixelSide));
    const pixelContext = pixelCanvas.getContext("2d");
    if (!pixelContext) throw new Error("画布创建失败");
    pixelContext.imageSmoothingEnabled = false;
    pixelContext.drawImage(image, 0, 0, pixelCanvas.width, pixelCanvas.height);
    styledContext.imageSmoothingEnabled = false;
    styledContext.drawImage(pixelCanvas, 0, 0, imageWidth, imageHeight);
    styledContext.imageSmoothingEnabled = true;
  } else {
    styledContext.drawImage(image, 0, 0, imageWidth, imageHeight);
  }
  styledContext.filter = "none";
  drawLocalVariantDecoration(styledContext, imageWidth, imageHeight, variant);

  const canvas = document.createElement("canvas");
  canvas.width = imageWidth + padding * 2;
  canvas.height = imageHeight + padding * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画布创建失败");

  drawStickerSilhouette(context, styledImage, padding);

  if (variant === "旅行插画风" || variant === "像素风格" || variant === "线条手绘风" || variant === "可爱漫画风" || variant === "复古邮票风") {
    context.save();
    context.globalCompositeOperation = "source-atop";
    context.strokeStyle = variant === "线条手绘风" ? "rgba(0, 0, 0, 0.34)" : "rgba(24, 50, 72, 0.28)";
    context.lineWidth = variant === "线条手绘风" ? 4 : 6;
    const gap = 18;
    for (let x = -imageHeight; x < canvas.width; x += gap) {
      context.beginPath();
      context.moveTo(x, canvas.height);
      context.lineTo(x + imageHeight, 0);
      context.stroke();
    }
    context.restore();
  }

  return canvas.toDataURL("image/png");
}

async function imageSourceFor(file: File): Promise<PreparedImageSource> {
  const prepared = await preparePhotoFile(file);
  const localUrl = await fileToDataUrl(prepared.file);
  if (!auth.token) {
    return {
      url: localUrl,
      localUrl,
      uploaded: false,
      compressed: prepared.compressed,
      filename: prepared.file.name,
      mimeType: prepared.file.type || file.type || "image/jpeg",
      size: prepared.file.size
    };
  }
  try {
    const uploaded = await uploadImage(auth.token, prepared.file);
    return {
      url: uploaded.url,
      localUrl,
      uploaded: true,
      compressed: prepared.compressed,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      size: uploaded.size
    };
  } catch {
    ui.showToast("图片上传失败，已改用本地保存", "warning");
    return {
      url: localUrl,
      localUrl,
      uploaded: false,
      compressed: prepared.compressed,
      filename: prepared.file.name,
      mimeType: prepared.file.type || file.type || "image/jpeg",
      size: prepared.file.size
    };
  }
}

async function saveImageSourceLocally(source: PreparedImageSource) {
  await saveLocalAsset({
    id: crypto.randomUUID(),
    filename: source.filename || "photo.jpg",
    mimeType: source.mimeType || "image/jpeg",
    size: source.size,
    url: source.localUrl,
    createdAt: new Date().toISOString()
  });
}

function relativePoint(event: PointerEvent | MouseEvent) {
  const rect = sourceFrameRef.value?.getBoundingClientRect() ?? sourceImageRef.value?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
  };
}

function relativeCanvasPoint(event: PointerEvent | MouseEvent) {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
  };
}

function strokePoints(points: Array<{ x: number; y: number }>) {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isVolatileImageUrl(url?: string) {
  return Boolean(url?.startsWith("blob:"));
}

function stickerHasVolatileUrl(sticker: Sticker) {
  return [sticker.fileUrl, sticker.sourceImageUrl, sticker.originalFileUrl].some(isVolatileImageUrl);
}

function stickerNeedsRepair(sticker: Sticker) {
  return brokenStickerIds.value.has(sticker.id) || sticker.status === "failed" || stickerHasVolatileUrl(sticker);
}

function markStickerImageLoaded(id: string) {
  if (!brokenStickerIds.value.has(id)) return;
  const next = new Set(brokenStickerIds.value);
  next.delete(id);
  brokenStickerIds.value = next;
}

function markStickerImageFailed(sticker: Sticker) {
  const next = new Set(brokenStickerIds.value);
  next.add(sticker.id);
  brokenStickerIds.value = next;
  if (!selectedStickerId.value) selectedStickerId.value = sticker.id;
}

function markCardImageLoaded() {
  brokenCardImage.value = false;
}

function markCardImageFailed() {
  brokenCardImage.value = true;
}

async function startCardImageRepair() {
  repairingCardImage.value = true;
  repairTargetStickerId.value = null;
  selectedDecorationId.value = null;
  assetPanelOpen.value = true;
  aiNotice.value = "选择一张素材来替换卡片预览图，日记里的贴纸排版不会改变。";
  await refreshAssetLibrary(true);
}

async function startStickerRepair(stickerId: string) {
  selectedStickerId.value = stickerId;
  selectedDecorationId.value = null;
  repairTargetStickerId.value = stickerId;
  repairingCardImage.value = false;
  assetPanelOpen.value = true;
  aiNotice.value = "选择一张素材来替换当前问题贴纸，原来的排版位置会保留。";
  await refreshAssetLibrary(true);
}

function cancelRepairMode() {
  repairTargetStickerId.value = null;
  repairingCardImage.value = false;
  aiNotice.value = "已退出修复模式，可以继续添加新贴纸。";
}

async function refreshAssetLibrary(showEmptyToast = false) {
  assetLoading.value = true;
  try {
    const localAssets = (await listLocalAssets()).map((asset) => ({
      ...asset,
      source: "local" as const
    }));
    let cloudAssets: AssetLibraryItem[] = [];
    if (auth.token) {
      try {
        const result = await listUploadedFiles(auth.token);
        cloudAssets = result.items.map((asset) => ({
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          size: asset.size,
          url: asset.url,
          createdAt: asset.createdAt,
          source: "cloud" as const
        }));
      } catch {
        ui.showToast("云端素材加载失败，已显示本地素材", "warning");
      }
    }
    assetItems.value = [...cloudAssets, ...localAssets].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 24);
    if (showEmptyToast && !assetItems.value.length) ui.showToast("素材库还没有照片", "info");
  } catch {
    assetItems.value = [];
    ui.showToast("素材库加载失败", "warning");
  } finally {
    assetLoading.value = false;
  }
}

async function toggleAssetLibrary() {
  assetPanelOpen.value = !assetPanelOpen.value;
  if (assetPanelOpen.value && !assetItems.value.length) {
    await refreshAssetLibrary(true);
  }
}

async function addAssetSticker(asset: AssetLibraryItem) {
  if (!diary.value || isBusy.value) return;
  const sticker = await store.addSticker(diary.value.id, asset.url, "白边原图贴纸");
  selectedStickerId.value = sticker?.id ?? selectedStickerId.value;
  selectedDecorationId.value = null;
  ui.showToast("已从素材库添加贴纸", "success");
}

async function replaceCardImage(url: string) {
  if (!diary.value) return false;
  await store.updateDiary(diary.value.id, {
    cardImageUrl: url,
    cardImageSignature: undefined
  });
  brokenCardImage.value = false;
  repairingCardImage.value = false;
  assetPanelOpen.value = false;
  aiNotice.value = "已替换卡片预览图，日记排版保持不变。";
  return true;
}

async function useAssetFromLibrary(asset: AssetLibraryItem) {
  if (!diary.value || isBusy.value) return;
  if (repairingCardImage.value) {
    await replaceCardImage(asset.url);
    ui.showToast("已替换卡片预览图", "success");
    return;
  }
  const target = repairTargetSticker.value ?? (selectedSticker.value && selectedStickerNeedsRepair.value ? selectedSticker.value : null);
  if (!target) {
    await addAssetSticker(asset);
    return;
  }

  await store.updateSticker(diary.value.id, target.id, {
    fileUrl: asset.url,
    sourceImageUrl: asset.url,
    originalFileUrl: asset.url,
    status: "ready",
    errorMessage: undefined
  });
  markStickerImageLoaded(target.id);
  selectedStickerId.value = target.id;
  selectedDecorationId.value = null;
  repairTargetStickerId.value = null;
  assetPanelOpen.value = false;
  aiNotice.value = "已替换问题贴纸，保留了原来的位置和缩放。";
  ui.showToast("已替换问题贴纸", "success");
}

async function replaceRepairTargetWithSource(source: PreparedImageSource) {
  if (repairingCardImage.value) {
    await saveImageSourceLocally(source);
    return replaceCardImage(source.localUrl);
  }
  if (!diary.value || !repairTargetSticker.value) return false;
  await saveImageSourceLocally(source);
  const targetId = repairTargetSticker.value.id;
  await store.updateSticker(diary.value.id, targetId, {
    fileUrl: source.localUrl,
    sourceImageUrl: source.localUrl,
    originalFileUrl: source.localUrl,
    status: "ready",
    errorMessage: undefined
  });
  markStickerImageLoaded(targetId);
  selectedStickerId.value = targetId;
  selectedDecorationId.value = null;
  repairTargetStickerId.value = null;
  assetPanelOpen.value = false;
  aiNotice.value = "已用新照片替换问题贴纸，原来的排版位置已保留。";
  return true;
}

async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!diary.value || !input.files?.length) return;
  const repairMode = isRepairing.value;
  const files = Array.from(input.files).slice(0, repairMode ? 1 : 8);
  let uploadedCount = 0;
  let compressedCount = 0;
  for (const file of files) {
    const source = await imageSourceFor(file);
    if (source.uploaded) uploadedCount += 1;
    if (source.compressed) compressedCount += 1;
    const wasRepairingCard = repairingCardImage.value;
    if (repairMode && (await replaceRepairTargetWithSource(source))) {
      input.value = "";
      const compressText = compressedCount ? "，已压缩大图" : "";
      const targetName = wasRepairingCard ? "卡片预览图" : "贴纸";
      ui.showToast(auth.token ? `已用新照片替换${targetName}${compressText}` : `已用本地照片替换${targetName}${compressText}`, "success");
      if (assetPanelOpen.value) await refreshAssetLibrary();
      return;
    }
    await saveImageSourceLocally(source);
    const sticker = await store.addSticker(diary.value.id, source.localUrl, "白边原图贴纸");
    selectedStickerId.value = sticker?.id ?? selectedStickerId.value;
  }
  input.value = "";
  const compressText = compressedCount ? `，已压缩 ${compressedCount} 张大图` : "";
  ui.showToast(auth.token ? `已添加 ${files.length} 个贴纸，上传 ${uploadedCount} 张${compressText}` : `已添加 ${files.length} 个本地贴纸${compressText}`, "success");
  if (assetPanelOpen.value) await refreshAssetLibrary();
}

async function patchSticker(patch: Partial<Sticker>) {
  if (!diary.value || !selectedSticker.value || isBusy.value) return;
  await store.updateSticker(diary.value.id, selectedSticker.value.id, patch);
}

function beginStickerDrag(event: PointerEvent, sticker: Sticker) {
  if (isBusy.value || drawMode.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  selectedStickerId.value = sticker.id;
  stickerDrag.value = {
    id: sticker.id,
    offsetX: point.x - sticker.x,
    offsetY: point.y - sticker.y,
    moved: false
  };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function moveStickerDrag(event: PointerEvent) {
  if (!diary.value || !stickerDrag.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  const sticker = diary.value.stickers.find((item) => item.id === stickerDrag.value?.id);
  if (!sticker) return;
  sticker.x = Math.min(96, Math.max(4, point.x - stickerDrag.value.offsetX));
  sticker.y = Math.min(88, Math.max(8, point.y - stickerDrag.value.offsetY));
  stickerDrag.value.moved = true;
}

async function endStickerDrag() {
  if (!diary.value || !stickerDrag.value) return;
  const drag = stickerDrag.value;
  stickerDrag.value = null;
  const sticker = diary.value.stickers.find((item) => item.id === drag.id);
  if (!sticker || !drag.moved) return;
  await store.updateSticker(diary.value.id, sticker.id, {
    x: sticker.x,
    y: sticker.y
  });
}

async function addDecoration(kind: DecorationKind, text: string, color: string) {
  if (!diary.value) return;
  const decoration = await store.addDecoration(diary.value.id, kind, text, color);
  selectedDecorationId.value = decoration?.id ?? selectedDecorationId.value;
  selectedStickerId.value = null;
  ui.showToast("已添加装饰贴纸", "success");
}

async function patchDecoration(patch: Partial<Decoration>) {
  if (!diary.value || !selectedDecoration.value) return;
  await store.updateDecoration(diary.value.id, selectedDecoration.value.id, patch);
}

function beginDecorationDrag(event: PointerEvent, decoration: Decoration) {
  if (drawMode.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  selectedDecorationId.value = decoration.id;
  selectedStickerId.value = null;
  decorationDrag.value = {
    id: decoration.id,
    offsetX: point.x - decoration.x,
    offsetY: point.y - decoration.y,
    moved: false
  };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function beginDoodle(event: PointerEvent) {
  if (!drawMode.value || !canvasRef.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  activeStroke.value = {
    id: crypto.randomUUID(),
    color: brushColor.value,
    size: brushSize.value,
    points: [point]
  };
  canvasRef.value.setPointerCapture?.(event.pointerId);
}

function moveDoodle(event: PointerEvent) {
  if (!drawMode.value || !activeStroke.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  activeStroke.value.points.push(point);
}

async function endDoodle() {
  if (!diary.value || !activeStroke.value) return;
  const stroke = activeStroke.value;
  activeStroke.value = null;
  if (stroke.points.length < 2) return;
  await store.addDoodleStroke(diary.value.id, stroke);
  ui.showToast("涂鸦已保存", "success");
}

function moveDecorationDrag(event: PointerEvent) {
  if (!diary.value || !decorationDrag.value) return;
  const point = relativeCanvasPoint(event);
  if (!point) return;
  const decoration = (diary.value.decorations ?? []).find((item) => item.id === decorationDrag.value?.id);
  if (!decoration) return;
  decoration.x = Math.min(96, Math.max(4, point.x - decorationDrag.value.offsetX));
  decoration.y = Math.min(88, Math.max(8, point.y - decorationDrag.value.offsetY));
  decorationDrag.value.moved = true;
}

async function endDecorationDrag() {
  if (!diary.value || !decorationDrag.value) return;
  const drag = decorationDrag.value;
  decorationDrag.value = null;
  const decoration = (diary.value.decorations ?? []).find((item) => item.id === drag.id);
  if (!decoration || !drag.moved) return;
  await store.updateDecoration(diary.value.id, decoration.id, {
    x: decoration.x,
    y: decoration.y
  });
}

function nextEditorStep() {
  if (activeEditorStep.value === 1 && !diary.value?.stickers.length) {
    ui.showToast("先添加一张照片", "warning");
    return;
  }
  if (activeEditorStep.value === 2 && !hasProcessedSubject.value) {
    ui.showToast(hasSelection.value ? "先生成抠图" : "先选择主体", "warning");
    return;
  }
  if (activeEditorStep.value < editorSteps.length) {
    activeEditorStep.value += 1;
  }
}

function previousEditorStep() {
  activeEditorStep.value = Math.max(1, activeEditorStep.value - 1);
}

async function setVariant(variant: StickerVariant) {
  if (!diary.value || !selectedSticker.value || isBusy.value) return;
  const stickerId = selectedSticker.value.id;
  const selection = selectedSticker.value.selection;
  const sourceUrl = selection ? selectedSticker.value.sourceImageUrl ?? selectedSticker.value.originalFileUrl ?? selectedSticker.value.fileUrl : selectedSticker.value.originalFileUrl ?? selectedSticker.value.fileUrl;
  await store.updateSticker(diary.value.id, stickerId, { variant, status: "processing", errorMessage: undefined });
  try {
    let nextUrl = "";
    let message = "";
    if (auth.token) {
      const result = await stylizeSticker(auth.token, { imageUrl: sourceUrl, variant, selection });
      nextUrl = result.stickerUrl;
      message = result.message;
    } else {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      nextUrl = await createLocalVariantSticker(sourceUrl, variant);
      message = `已在本地生成「${variant}」。`;
    }
    await store.updateSticker(diary.value.id, stickerId, { fileUrl: nextUrl, variant, status: "ready" });
    aiNotice.value = message;
    ui.showToast(auth.token ? "后端已生成风格贴纸" : "已生成本地风格贴纸", "success");
  } catch {
    try {
      const nextUrl = await createLocalVariantSticker(sourceUrl, variant);
      await store.updateSticker(String(route.params.id), stickerId, {
        fileUrl: nextUrl,
        variant,
        status: "ready",
        errorMessage: "本地风格化已使用备用效果完成。"
      });
      aiNotice.value = auth.token ? `后端生成失败，已使用本地备用效果生成「${variant}」。` : `已使用本地备用效果生成「${variant}」。`;
      ui.showToast("已使用本地风格", "warning");
    } catch {
      await store.updateSticker(String(route.params.id), stickerId, {
        fileUrl: sourceUrl,
        status: "ready",
        errorMessage: "这次风格化没有处理好，已恢复原贴纸，可以稍后再试。"
      });
      ui.showToast("已恢复贴纸", "warning");
    }
  }
}

async function handlePreviewClick(event: MouseEvent) {
  if (selectionMode.value !== "point" || !diary.value || !selectedSticker.value || isBusy.value) return;
  const point = relativePoint(event);
  if (!point) return;
  await store.setStickerSelection(diary.value.id, selectedSticker.value.id, { mode: "point", x: point.x, y: point.y });
  ui.showToast("已标记主体位置", "success");
}

function startBox(event: PointerEvent) {
  if (selectionMode.value !== "box" || isBusy.value) return;
  const point = relativePoint(event);
  if (!point) return;
  dragStart.value = point;
  draftBox.value = { mode: "box", x: point.x, y: point.y, width: 1, height: 1 };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function moveBox(event: PointerEvent) {
  if (selectionMode.value !== "box" || !dragStart.value) return;
  const point = relativePoint(event);
  if (!point) return;
  const x = Math.min(dragStart.value.x, point.x);
  const y = Math.min(dragStart.value.y, point.y);
  draftBox.value = { mode: "box", x, y, width: Math.abs(point.x - dragStart.value.x), height: Math.abs(point.y - dragStart.value.y) };
}

async function endBox() {
  if (!diary.value || !selectedSticker.value || !draftBox.value) return;
  const box = { ...draftBox.value, width: Math.max(4, draftBox.value.width), height: Math.max(4, draftBox.value.height) };
  dragStart.value = null;
  draftBox.value = null;
  await store.setStickerSelection(diary.value.id, selectedSticker.value.id, box);
  ui.showToast("已框选主体区域", "success");
}

async function processSubject() {
  if (!diary.value || !selectedSticker.value) return;
  if (!selectedSticker.value.selection) {
    aiNotice.value = "先在原图上点一下，或者框出要保留的主体。";
    ui.showToast("请先选择主体", "warning");
    return;
  }
  const stickerId = selectedSticker.value.id;
  const selection = selectedSticker.value.selection;
  const fallbackUrl = selectedSticker.value.sourceImageUrl ?? selectedSticker.value.fileUrl;
  await store.updateSticker(diary.value.id, stickerId, { status: "processing", errorMessage: undefined });
  try {
    let stickerUrl = "";
    let message = "";
    if (auth.token) {
      const result = await segmentSubject(auth.token, { imageUrl: fallbackUrl, selection });
      stickerUrl = result.stickerUrl;
      message = result.message;
    } else {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
      stickerUrl = await createLocalSelectionSticker(fallbackUrl, selection);
      message = selection.mode === "box" ? "已用本地算法清理边缘背景并生成贴纸。" : "已围绕点选位置生成本地贴纸。";
    }
    await store.updateSticker(diary.value.id, stickerId, { fileUrl: stickerUrl, originalFileUrl: stickerUrl, status: "ready" });
    aiNotice.value = message;
    ui.showToast(auth.token ? "后端已生成贴纸" : "已生成本地贴纸", "success");
  } catch {
    try {
      const localUrl = await createLocalSelectionSticker(fallbackUrl, selection);
      await store.updateSticker(String(route.params.id), stickerId, {
        fileUrl: localUrl,
        originalFileUrl: localUrl,
        status: "ready",
        errorMessage: "本地抠图已使用备用裁切结果。"
      });
      aiNotice.value = "本地边缘清理没有完成，已先使用备用裁切贴纸。";
      ui.showToast("已使用本地裁切", "warning");
    } catch {
      await store.updateSticker(String(route.params.id), stickerId, {
        fileUrl: fallbackUrl,
        status: "ready",
        errorMessage: "这次没有处理好，内容已经帮你保存，可以稍后再试。"
      });
      aiNotice.value = "抠图请求没有完成，已自动恢复原图贴纸。";
      ui.showToast("已恢复原图贴纸", "warning");
    }
  }
}

async function recoverSelectedSticker() {
  if (!diary.value || !selectedSticker.value) return;
  const restoredUrl = selectedSticker.value.sourceImageUrl ?? selectedSticker.value.fileUrl;
  await store.updateSticker(diary.value.id, selectedSticker.value.id, {
    fileUrl: restoredUrl,
    originalFileUrl: restoredUrl,
    status: "ready",
    errorMessage: undefined
  });
  ui.showToast("已恢复贴纸", "success");
}

async function removeSelectedSticker() {
  if (!diary.value || !selectedSticker.value || isBusy.value) return;
  const next = diary.value.stickers.filter((sticker) => sticker.id !== selectedSticker.value?.id);
  selectedStickerId.value = next[0]?.id ?? null;
  await store.updateDiary(diary.value.id, { stickers: next });
  ui.showToast("已删除贴纸", "info");
}

async function autoLayout(mode: "scatter" | "polaroid" | "comic") {
  if (!diary.value || isBusy.value) return;
  const layouts = diary.value.stickers.map((sticker, index) => {
    if (mode === "polaroid") return { ...sticker, x: 50, y: 30 + index * 12, scale: index === 0 ? 1.24 : 0.82, rotation: index % 2 === 0 ? -3 : 4, zIndex: index + 1 };
    if (mode === "comic") {
      const cols = diary.value!.stickers.length > 2 ? 2 : 1;
      return { ...sticker, x: cols === 1 ? 50 : index % 2 === 0 ? 32 : 68, y: 24 + Math.floor(index / cols) * 24, scale: 0.84, rotation: 0, zIndex: index + 1 };
    }
    const positions = [[34, 32, -8], [66, 36, 7], [42, 56, 4], [70, 62, -6], [28, 68, 9]];
    const [x, y, rotation] = positions[index % positions.length];
    return { ...sticker, x, y, scale: index === 0 ? 1.05 : 0.88, rotation, zIndex: index + 1 };
  });
  await store.updateDiary(diary.value.id, { stickers: layouts });
  ui.showToast("已自动排版", "success");
}

function drawWrappedCoverText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const chars = Array.from(text);
  let line = "";
  let lineCount = 0;
  for (const char of chars) {
    const next = line + char;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(lineCount === maxLines - 1 ? `${line.slice(0, Math.max(0, line.length - 1))}…` : line, x, y + lineCount * lineHeight);
      line = char;
      lineCount += 1;
      if (lineCount >= maxLines) return;
    } else {
      line = next;
    }
  }
  if (line && lineCount < maxLines) context.fillText(line, x, y + lineCount * lineHeight);
}

function stableNumber(value: number) {
  return Math.round(value * 100) / 100;
}

function buildCoverSignature(cover: Diary) {
  return JSON.stringify({
    version: 1,
    date: cover.date,
    mood: cover.mood,
    body: cover.body,
    background: cover.background,
    stickers: cover.stickers.map((sticker) => ({
      id: sticker.id,
      fileUrl: sticker.fileUrl,
      x: stableNumber(sticker.x),
      y: stableNumber(sticker.y),
      scale: stableNumber(sticker.scale),
      rotation: stableNumber(sticker.rotation),
      zIndex: sticker.zIndex,
      status: sticker.status
    })),
    decorations: (cover.decorations ?? []).map((decoration) => ({
      id: decoration.id,
      kind: decoration.kind,
      text: decoration.text,
      color: decoration.color,
      x: stableNumber(decoration.x),
      y: stableNumber(decoration.y),
      scale: stableNumber(decoration.scale),
      rotation: stableNumber(decoration.rotation),
      zIndex: decoration.zIndex
    })),
    doodles: (cover.doodles ?? []).map((stroke) => ({
      id: stroke.id,
      color: stroke.color,
      size: stableNumber(stroke.size),
      points: stroke.points.map((point) => ({
        x: stableNumber(point.x),
        y: stableNumber(point.y)
      }))
    }))
  });
}

function drawCoverBackground(context: CanvasRenderingContext2D, cover: Diary, width: number, height: number) {
  const backgroundMap: Record<string, string> = {
    牛皮纸: "#e8c68e",
    横线纸: "#fffdf4",
    拍立得: "#ffffff",
    柔和纯色: "#dff3ff",
    透明: "#ffffff"
  };
  context.fillStyle = backgroundMap[cover.background] ?? "#fffdf4";
  context.fillRect(0, 0, width, height);
  if (cover.background === "横线纸") {
    context.strokeStyle = "rgba(47, 110, 163, 0.18)";
    context.lineWidth = 2;
    for (let y = 56; y < height - 130; y += 38) {
      context.beginPath();
      context.moveTo(34, y);
      context.lineTo(width - 34, y);
      context.stroke();
    }
  }
}

function drawCoverMissingSticker(context: CanvasRenderingContext2D, sticker: Sticker, width: number, artHeight: number) {
  const size = 112 * sticker.scale;
  const x = (sticker.x / 100) * width;
  const y = (sticker.y / 100) * artHeight;
  context.save();
  context.translate(x, y);
  context.rotate((sticker.rotation * Math.PI) / 180);
  context.fillStyle = "#fff5f1";
  context.strokeStyle = "#b7424c";
  context.lineWidth = 4;
  context.fillRect(-size / 2 - 10, -size / 2 - 10, size + 20, size + 30);
  context.strokeRect(-size / 2 - 10, -size / 2 - 10, size + 20, size + 30);
  context.fillStyle = "#b7424c";
  context.font = "700 18px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("需修复", 0, 0);
  context.restore();
}

async function renderDiaryCoverCanvas(cover: Diary) {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("封面画布创建失败");

  const artHeight = 520;
  drawCoverBackground(context, cover, canvas.width, canvas.height);

  if (!cover.stickers.length) {
    context.save();
    context.fillStyle = "#ffcf56";
    context.strokeStyle = "#2f6ea3";
    context.lineWidth = 5;
    context.roundRect(220, 150, 280, 180, 24);
    context.fill();
    context.stroke();
    context.fillStyle = "#263447";
    context.font = "800 42px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(cover.mood, 360, 240);
    context.restore();
  }

  for (const sticker of cover.stickers) {
    try {
      const image = await loadImageFromUrl(sticker.fileUrl);
      const size = 132 * sticker.scale;
      const x = (sticker.x / 100) * canvas.width;
      const y = (sticker.y / 100) * artHeight;
      context.save();
      context.translate(x, y);
      context.rotate((sticker.rotation * Math.PI) / 180);
      context.fillStyle = "#ffffff";
      context.shadowColor = "rgba(38, 52, 71, 0.16)";
      context.shadowBlur = 0;
      context.shadowOffsetY = 8;
      context.fillRect(-size / 2 - 12, -size / 2 - 12, size + 24, size + 32);
      context.shadowColor = "transparent";
      context.drawImage(image, -size / 2, -size / 2, size, size);
      context.restore();
    } catch {
      drawCoverMissingSticker(context, sticker, canvas.width, artHeight);
    }
  }

  for (const decoration of cover.decorations ?? []) {
    const x = (decoration.x / 100) * canvas.width;
    const y = (decoration.y / 100) * artHeight;
    context.save();
    context.translate(x, y);
    context.rotate((decoration.rotation * Math.PI) / 180);
    context.scale(decoration.scale, decoration.scale);
    context.fillStyle = decoration.color;
    context.strokeStyle = "#2f6ea3";
    context.lineWidth = 3;
    context.roundRect(-48, -20, 96, 40, decoration.kind === "emoji" ? 22 : 10);
    context.fill();
    context.stroke();
    context.fillStyle = "#263447";
    context.font = decoration.kind === "emoji" ? "700 26px sans-serif" : "700 18px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(decoration.text, 0, 1);
    context.restore();
  }

  for (const stroke of cover.doodles ?? []) {
    if (stroke.points.length < 2) continue;
    context.save();
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.size * 1.4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = (point.x / 100) * canvas.width;
      const y = (point.y / 100) * artHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.restore();
  }

  context.save();
  context.fillStyle = "rgba(255,255,255,0.94)";
  context.strokeStyle = "#2f6ea3";
  context.lineWidth = 4;
  context.roundRect(34, 540, 652, 136, 18);
  context.fill();
  context.stroke();
  context.fillStyle = "#263447";
  context.font = "800 25px sans-serif";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(`${cover.mood} · ${cover.date}`, 58, 588);
  context.font = "24px sans-serif";
  drawWrappedCoverText(context, cover.body || "这篇日记还在路上。", 58, 630, 604, 32, 2);
  context.restore();

  return canvas;
}

async function persistGeneratedCover(cover: Diary) {
  const canvas = await renderDiaryCoverCanvas(cover);
  const blob = await canvasToBlob(canvas, "image/png", 0.92);
  if (!blob) throw new Error("封面生成失败");
  const file = new File([blob], `cover-${cover.id}-${Date.now()}.png`, { type: "image/png", lastModified: Date.now() });

  if (auth.token) {
    try {
      const uploaded = await uploadImage(auth.token, file);
      return uploaded.url;
    } catch {
      ui.showToast("封面上传失败，已改用本地保存", "warning");
    }
  }

  const url = await fileToDataUrl(file);
  await saveLocalAsset({
    id: crypto.randomUUID(),
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    url,
    createdAt: new Date().toISOString()
  });
  return url;
}

function isGeneratedCoverFilename(filename: string, diaryId: string) {
  return filename.startsWith(`cover-${diaryId}-`) && filename.endsWith(".png");
}

function isImageUrlStillReferenced(url: string) {
  return store.diaries.some((item) => {
    if (item.cardImageUrl === url) return true;
    return item.stickers.some((sticker) => sticker.fileUrl === url || sticker.sourceImageUrl === url || sticker.originalFileUrl === url);
  });
}

async function cleanupPreviousGeneratedCover(diaryId: string, previousUrl?: string, nextUrl?: string) {
  if (!previousUrl || previousUrl === nextUrl || isImageUrlStillReferenced(previousUrl)) return false;
  const localAsset = (await listLocalAssets()).find((asset) => asset.url === previousUrl && isGeneratedCoverFilename(asset.filename, diaryId));
  if (localAsset) {
    await deleteLocalAsset(localAsset.id);
    return true;
  }

  if (!auth.token) return false;
  const uploaded = await listUploadedFiles(auth.token);
  const cloudAsset = uploaded.items.find((asset) => asset.url === previousUrl && isGeneratedCoverFilename(asset.filename, diaryId));
  if (!cloudAsset) return false;
  await deleteUploadedFile(auth.token, cloudAsset.id);
  return true;
}

function buildLocalDiaryText() {
  const place = form.location || "今天";
  const hint = prompt.value || "这个小片刻";
  const styleMap: Record<WritingStyle, string> = {
    可爱活泼: `${place}的快乐被我贴进了这一页。${hint}，像给普通日子加了一点甜甜的能量，连心情都轻轻翘起来。`,
    文艺感: `${place}留下了一个很小却清楚的瞬间。${hint}，像纸页边缘的一点光，把今天温柔地固定下来。`,
    吐槽幽默: `${place}这一天本来平平无奇，结果${hint}成功抢镜。钱包和理智先不评价，快乐已经盖章通过。`
  };
  return styleMap[form.writingStyle];
}

async function generateText() {
  if (generatingText.value) return;
  generatingText.value = true;
  try {
    if (auth.token && diary.value) {
      const tags = tagText.value
        .split(/[，,\s#]+/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      const result = await generateDiary(auth.token, {
        prompt: prompt.value,
        location: form.location,
        mood: form.mood,
        writingStyle: form.writingStyle,
        length: form.length,
        tags,
        stickerCount: diary.value.stickers.length
      });
      form.body = result.text;
      ui.showToast(result.model === "local-template" ? "已用本地模板生成" : "已生成日记文字", "success");
    } else {
      form.body = buildLocalDiaryText();
      ui.showToast("已用本地模板生成", "success");
    }
  } catch {
    form.body = buildLocalDiaryText();
    ui.showToast("生成服务暂不可用，已用本地模板", "warning");
  } finally {
    generatingText.value = false;
  }
}

async function save(status: "draft" | "done" = "draft") {
  if (!diary.value || savingDiary.value) return;
  savingDiary.value = true;
  const diaryId = diary.value.id;
  const previousCardImageUrl = diary.value.cardImageUrl;
  const tags = tagText.value.split(/[，,\s#]+/).map((tag) => tag.trim()).filter(Boolean);
  const basePatch: Partial<Diary> = {
    status,
    date: form.date,
    location: form.location,
    mood: form.mood,
    writingStyle: form.writingStyle,
    length: form.length,
    background: form.background,
    body: form.body,
    tags
  };
  let coverSaved = false;
  let coverFailed = false;
  let oldCoverCleaned = false;
  try {
    window.clearTimeout(autosaveTimer);
    const coverDraft: Diary = {
      ...diary.value,
      ...basePatch
    };
    const coverSignature = buildCoverSignature(coverDraft);
    const shouldUpdateCover = !coverDraft.cardImageUrl || coverDraft.cardImageSignature !== coverSignature || isVolatileImageUrl(coverDraft.cardImageUrl) || brokenCardImage.value;
    let nextCardImageUrl = coverDraft.cardImageUrl;

    if (shouldUpdateCover) {
      try {
        nextCardImageUrl = await persistGeneratedCover(coverDraft);
        basePatch.cardImageUrl = nextCardImageUrl;
        basePatch.cardImageSignature = coverSignature;
        coverSaved = true;
      } catch {
        coverFailed = true;
      }
    }

    await store.updateDiary(diaryId, basePatch);
    if (coverSaved) {
      brokenCardImage.value = false;
      try {
        oldCoverCleaned = await cleanupPreviousGeneratedCover(diaryId, previousCardImageUrl, nextCardImageUrl);
      } catch {
        oldCoverCleaned = false;
      }
    }

    ui.showToast(
      coverFailed
        ? status === "done"
          ? "日记已保存，封面稍后再试"
          : "草稿已保存，封面稍后再试"
        : status === "done"
          ? `日记已保存${coverSaved ? "，封面已更新" : ""}${oldCoverCleaned ? "，旧封面已清理" : ""}`
          : `草稿已保存${coverSaved ? "，封面已更新" : ""}${oldCoverCleaned ? "，旧封面已清理" : ""}`,
      coverFailed ? "warning" : "success"
    );
    if (status === "done") router.push(`/diaries/${diaryId}`);
  } finally {
    savingDiary.value = false;
  }
}
</script>

<template>
  <section v-if="diary" class="editor-page">
    <input ref="fileInput" class="visually-hidden" type="file" accept="image/*" multiple @change="addFiles" />
    <input ref="cameraInput" class="visually-hidden" type="file" accept="image/*" capture="environment" @change="addFiles" />

    <div class="page-title editor-title-row">
      <div>
        <p class="eyebrow">创作中</p>
        <h1>贴一篇小日记</h1>
        <p class="save-state">{{ autosaveState }} · {{ store.syncState }}</p>
      </div>
      <button class="secondary-action" type="button" @click="router.push(`/diaries/${diary.id}`)">预览</button>
    </div>

    <div class="step-strip">
      <button v-for="step in editorSteps" :key="step.id" type="button" :class="{ active: activeEditorStep === step.id, done: currentStep > step.id }" @click="activeEditorStep = step.id">
        {{ step.id }} {{ step.label }}
      </button>
    </div>

    <section class="editor-layout">
      <div class="canvas-panel">
        <div
          ref="canvasRef"
          class="diary-canvas"
          :class="[canvasClass, { drawing: drawMode }]"
          @pointerdown="beginDoodle"
          @pointermove="
            moveStickerDrag($event);
            moveDecorationDrag($event);
            moveDoodle($event);
          "
          @pointerup="
            endStickerDrag();
            endDecorationDrag();
            endDoodle();
          "
          @pointerleave="
            endStickerDrag();
            endDecorationDrag();
            endDoodle();
          "
        >
          <svg class="doodle-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              v-for="stroke in diary.doodles ?? []"
              :key="stroke.id"
              :points="strokePoints(stroke.points)"
              :stroke="stroke.color"
              :stroke-width="stroke.size / 5"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <polyline
              v-if="activeStroke"
              :points="strokePoints(activeStroke.points)"
              :stroke="activeStroke.color"
              :stroke-width="activeStroke.size / 5"
              fill="none"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>

          <button
            v-for="sticker in diary.stickers"
            :key="sticker.id"
            class="canvas-sticker"
            :class="{ selected: sticker.id === selectedStickerId, processing: sticker.status === 'processing', failed: sticker.status === 'failed', broken: stickerNeedsRepair(sticker) }"
            :style="{ left: `${sticker.x}%`, top: `${sticker.y}%`, transform: `translate(-50%, -50%) rotate(${sticker.rotation}deg) scale(${sticker.scale})`, zIndex: sticker.zIndex }"
            type="button"
            @pointerdown.stop="beginStickerDrag($event, sticker)"
            @click="
              selectedStickerId = sticker.id;
              selectedDecorationId = null;
            "
          >
            <img :src="sticker.fileUrl" :alt="sticker.variant" @load="markStickerImageLoaded(sticker.id)" @error="markStickerImageFailed(sticker)" />
            <strong v-if="stickerNeedsRepair(sticker)" class="sticker-warning-badge">{{ brokenStickerIds.has(sticker.id) || sticker.status === "failed" ? "失效" : "临时" }}</strong>
            <span>{{ sticker.status === "processing" ? "处理中" : sticker.variant }}</span>
          </button>

          <button
            v-for="decoration in diary.decorations ?? []"
            :key="decoration.id"
            class="canvas-decoration"
            :class="[`decoration-${decoration.kind}`, { selected: decoration.id === selectedDecorationId }]"
            :style="{
              left: `${decoration.x}%`,
              top: `${decoration.y}%`,
              transform: `translate(-50%, -50%) rotate(${decoration.rotation}deg) scale(${decoration.scale})`,
              zIndex: decoration.zIndex,
              backgroundColor: decoration.color
            }"
            type="button"
            @pointerdown.stop="beginDecorationDrag($event, decoration)"
            @click="
              selectedDecorationId = decoration.id;
              selectedStickerId = null;
            "
          >
            {{ decoration.text }}
          </button>

          <div v-if="!diary.stickers.length" class="empty-canvas">
            <strong>还没有贴纸</strong>
            <span>先添加照片，再点选或框选主体。</span>
          </div>

          <div class="canvas-copy">
            <strong>{{ form.mood }} · {{ form.date }}</strong>
            <p>{{ form.body || "生成或写下一小段日记，文字会出现在这里。" }}</p>
          </div>
        </div>
      </div>

      <div class="editor-tools">
        <div class="wizard-head">
          <span>第 {{ activeEditorStep }} 步</span>
          <strong>{{ activeStepTitle }}</strong>
        </div>

        <section v-if="activeEditorStep === 1" class="section-block compact-block">
          <div class="section-heading">
            <h2>照片贴纸</h2>
            <span>{{ diary.stickers.length }} 个</span>
          </div>
          <div class="photo-actions">
            <button class="primary-action" type="button" :disabled="isBusy" @click="cameraInput?.click()">{{ isRepairing ? "拍照替换" : "拍照" }}</button>
            <button class="secondary-action" type="button" :disabled="isBusy" @click="fileInput?.click()">{{ isRepairing ? "相册替换" : "从相册选" }}</button>
            <button class="secondary-action" type="button" :disabled="isBusy || assetLoading" @click="toggleAssetLibrary">
              {{ assetPanelOpen ? "收起素材库" : assetLoading ? "加载中" : "素材库" }}
            </button>
          </div>
          <div v-if="diary.cardImageUrl" class="asset-row editor-cover-row" :class="{ broken: cardImageNeedsRepair }">
            <img :src="diary.cardImageUrl" alt="卡片预览图" @load="markCardImageLoaded" @error="markCardImageFailed" />
            <div>
              <strong>卡片预览图</strong>
              <span>{{ cardImageNeedsRepair ? "图片失效或使用临时链接" : "详情页和备份检查会引用这张图" }}</span>
            </div>
            <button type="button" class="secondary-action compact-action" :disabled="assetLoading" @click="startCardImageRepair">
              {{ cardImageNeedsRepair ? "修复" : "替换" }}
            </button>
          </div>
          <div v-if="cardImageNeedsRepair" class="health-panel warning-panel editor-health-panel">
            <div>
              <strong>卡片预览图需要修复</strong>
              <p>这张图会影响时间线、备份和图片健康检查；换一张素材即可保留当前日记内容。</p>
            </div>
            <article class="health-row">
              <div>
                <strong>卡片预览图</strong>
                <span>{{ brokenCardImage ? "图片加载失败" : "使用临时图片链接" }}</span>
              </div>
              <button type="button" class="secondary-action compact-action" :disabled="assetLoading" @click="startCardImageRepair">
                修复
              </button>
            </article>
          </div>
          <div v-if="stickerHealthIssues.length" class="health-panel warning-panel editor-health-panel">
            <div>
              <strong>{{ stickerHealthIssues.length }} 个贴纸需要检查</strong>
              <p>图片加载失败或使用临时链接时，换一张素材即可保留原位置继续编辑。</p>
            </div>
            <article v-for="issue in stickerHealthIssues" :key="issue.id" class="health-row">
              <div>
                <strong>{{ issue.label }}</strong>
                <span>{{ issue.reason }}</span>
              </div>
              <button type="button" class="secondary-action compact-action" :disabled="assetLoading" @click="startStickerRepair(issue.stickerId)">
                修复
              </button>
            </article>
          </div>
          <div v-if="assetPanelOpen" class="asset-picker">
            <div class="asset-picker-head">
              <span>{{ repairingCardImage ? `正在修复卡片预览图 · ${assetItems.length} 个素材` : repairTargetSticker ? `正在修复选中贴纸 · ${assetItems.length} 个素材` : `最近 ${assetItems.length} 个素材` }}</span>
              <div class="asset-picker-actions">
                <button v-if="isRepairing" class="text-danger" type="button" @click="cancelRepairMode">取消修复</button>
                <button class="text-danger" type="button" :disabled="assetLoading" @click="refreshAssetLibrary(true)">
                  {{ assetLoading ? "刷新中" : "刷新" }}
                </button>
              </div>
            </div>
            <div v-if="assetItems.length" class="asset-picker-list">
              <button v-for="asset in assetItems" :key="asset.id" class="asset-picker-card" type="button" :disabled="isBusy" @click="useAssetFromLibrary(asset)">
                <img :src="asset.url" :alt="asset.filename" />
                <span>{{ isRepairing ? "替换为这张" : formatBytes(asset.size) }}</span>
                <b>{{ asset.source === "cloud" ? "云端" : "本地" }}</b>
              </button>
            </div>
            <div v-else class="empty-list compact-empty">
              <strong>暂无可复用素材</strong>
              <span>拍照或从相册上传后，这里会出现本地素材；登录后也会合并云端素材。</span>
            </div>
          </div>
          <p class="subtle-copy">{{ aiNotice }}</p>
        </section>

        <section v-if="activeEditorStep === 2" class="section-block compact-block">
          <div class="section-heading">
            <h2>选择主体</h2>
            <span>{{ selectedSticker?.selection?.mode === "point" ? "点选" : selectedSticker?.selection?.mode === "box" ? "框选" : "未选择" }}</span>
          </div>

          <div class="segmented two">
            <button type="button" :class="{ active: selectionMode === 'point' }" :disabled="isBusy" @click="selectionMode = 'point'">点选主体</button>
            <button type="button" :class="{ active: selectionMode === 'box' }" :disabled="isBusy" @click="selectionMode = 'box'">框选主体</button>
          </div>

          <div class="source-preview">
            <div
              v-if="selectedSticker"
              ref="sourceFrameRef"
              class="source-image-frame"
              @click="handlePreviewClick"
              @pointerdown="startBox"
              @pointermove="moveBox"
              @pointerup="endBox"
              @pointerleave="endBox"
            >
              <img ref="sourceImageRef" :src="selectedSticker.sourceImageUrl ?? selectedSticker.fileUrl" alt="原图预览" @load="markStickerImageLoaded(selectedSticker.id)" @error="markStickerImageFailed(selectedSticker)" />
              <span v-if="selectedSticker.selection?.mode === 'point'" class="selection-point" :style="{ left: `${selectedSticker.selection.x}%`, top: `${selectedSticker.selection.y}%` }" />
              <span v-if="selectedSticker.selection?.mode === 'box'" class="selection-box" :style="{ left: `${selectedSticker.selection.x}%`, top: `${selectedSticker.selection.y}%`, width: `${selectedSticker.selection.width}%`, height: `${selectedSticker.selection.height}%` }" />
              <span v-if="draftBox" class="selection-box drafting" :style="{ left: `${draftBox.x}%`, top: `${draftBox.y}%`, width: `${draftBox.width}%`, height: `${draftBox.height}%` }" />
              <div v-if="isBusy" class="busy-overlay">处理中，请稍等</div>
              <div v-else-if="selectedStickerNeedsRepair" class="busy-overlay repair-overlay">这张贴纸需要重新选择图片</div>
            </div>
            <div v-else class="empty-canvas"><span>先选择一个贴纸</span></div>
          </div>

          <div class="hero-actions">
            <button class="secondary-action" type="button" :disabled="isBusy || !selectedSticker" @click="processSubject">{{ isBusy ? "处理中" : "生成抠图" }}</button>
            <button class="secondary-action" type="button" :disabled="isBusy || !selectedSticker" @click="setVariant(selectedSticker?.variant ?? '白边原图贴纸')">再来一版</button>
            <button v-if="selectedSticker?.status === 'processing' || selectedSticker?.status === 'failed'" class="secondary-action" type="button" @click="recoverSelectedSticker">恢复贴纸</button>
          </div>
          <p v-if="selectedSticker?.errorMessage" class="error-copy">{{ selectedSticker.errorMessage }}</p>
        </section>

        <section v-if="activeEditorStep === 3" class="section-block compact-block">
          <div class="section-heading">
            <h2>贴纸版本</h2>
            <span>{{ selectedSticker?.variant ?? "未选择" }}</span>
          </div>
          <div class="chip-group compact">
            <button v-for="variant in stickerVariants" :key="variant" class="chip button-chip" :class="{ active: selectedSticker?.variant === variant }" type="button" :disabled="isBusy || !selectedSticker" @click="setVariant(variant)">
              {{ variant }}
            </button>
          </div>
        </section>

        <section v-if="activeEditorStep === 4" class="section-block compact-block">
          <div class="section-heading">
            <h2>自动排版</h2>
            <span>一键整理</span>
          </div>
          <div class="tool-grid small-tools">
            <button type="button" :disabled="isBusy" @click="autoLayout('scatter')">手账散落</button>
            <button type="button" :disabled="isBusy" @click="autoLayout('polaroid')">拍立得</button>
            <button type="button" :disabled="isBusy" @click="autoLayout('comic')">漫画分镜</button>
          </div>
        </section>

        <section v-if="activeEditorStep === 4" class="section-block compact-block">
          <div class="section-heading">
            <h2>装饰贴纸</h2>
            <span>{{ (diary.decorations ?? []).length }} 个</span>
          </div>
          <div class="form-grid">
            <label>文字贴纸<input v-model="textDecoration" placeholder="比如：今日份快乐" /></label>
          </div>
          <div class="tool-grid small-tools">
            <button type="button" @click="addDecoration('text', textDecoration || '今日份快乐', '#ffffff')">文字</button>
            <button type="button" @click="addDecoration('emoji', '★', '#ffcf56')">星星</button>
            <button type="button" @click="addDecoration('emoji', '♡', '#ffe2df')">爱心</button>
            <button type="button" @click="addDecoration('tape', '胶带', '#89cff0')">胶带</button>
            <button type="button" @click="addDecoration('bubble', '哇！', '#ffffff')">气泡</button>
            <button type="button" @click="addDecoration('label', 'DATE', '#fff8df')">标签</button>
          </div>
          <div v-if="selectedDecoration" class="tool-grid small-tools">
            <button type="button" @click="patchDecoration({ scale: Math.max(selectedDecoration.scale - 0.1, 0.5) })">缩小</button>
            <button type="button" @click="patchDecoration({ scale: Math.min(selectedDecoration.scale + 0.1, 2.2) })">放大</button>
            <button type="button" @click="patchDecoration({ rotation: selectedDecoration.rotation - 8 })">左旋</button>
            <button type="button" @click="patchDecoration({ rotation: selectedDecoration.rotation + 8 })">右旋</button>
            <button type="button" @click="patchDecoration({ zIndex: selectedDecoration.zIndex + 1 })">置顶</button>
            <button type="button" @click="store.removeDecoration(diary.id, selectedDecoration.id); selectedDecorationId = null">删除</button>
          </div>
        </section>

        <section v-if="activeEditorStep === 4" class="section-block compact-block">
          <div class="section-heading">
            <h2>画笔涂鸦</h2>
            <span>{{ diary.doodles?.length ?? 0 }} 笔</span>
          </div>
          <div class="segmented two">
            <button type="button" :class="{ active: !drawMode }" @click="drawMode = false">编辑贴纸</button>
            <button type="button" :class="{ active: drawMode }" @click="drawMode = true">画笔模式</button>
          </div>
          <div class="brush-row">
            <button type="button" class="color-dot coral" :class="{ active: brushColor === '#ff7a85' }" @click="brushColor = '#ff7a85'" />
            <button type="button" class="color-dot blue" :class="{ active: brushColor === '#2f6ea3' }" @click="brushColor = '#2f6ea3'" />
            <button type="button" class="color-dot yellow" :class="{ active: brushColor === '#ffcf56' }" @click="brushColor = '#ffcf56'" />
            <button type="button" class="color-dot ink" :class="{ active: brushColor === '#263447' }" @click="brushColor = '#263447'" />
            <label>粗细<input v-model.number="brushSize" type="range" min="3" max="12" /></label>
          </div>
          <div class="tool-grid small-tools">
            <button type="button" @click="store.undoDoodleStroke(diary.id)">撤销一笔</button>
            <button type="button" @click="store.clearDoodles(diary.id)">清空涂鸦</button>
          </div>
        </section>

        <section v-if="activeEditorStep === 4" class="section-block compact-block">
          <div class="section-heading">
            <h2>调整贴纸</h2>
            <span>{{ selectedSticker ? "已选中" : "未选择" }}</span>
          </div>
          <div class="nudge-grid">
            <button type="button" :disabled="isBusy" @click="patchSticker({ y: (selectedSticker?.y ?? 50) - 4 })">上</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ x: (selectedSticker?.x ?? 50) - 4 })">左</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ x: (selectedSticker?.x ?? 50) + 4 })">右</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ y: (selectedSticker?.y ?? 50) + 4 })">下</button>
          </div>
          <div class="tool-grid small-tools">
            <button type="button" :disabled="isBusy" @click="patchSticker({ scale: Math.max((selectedSticker?.scale ?? 1) - 0.1, 0.3) })">缩小</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ scale: Math.min((selectedSticker?.scale ?? 1) + 0.1, 2.4) })">放大</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ rotation: (selectedSticker?.rotation ?? 0) - 8 })">左旋</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ rotation: (selectedSticker?.rotation ?? 0) + 8 })">右旋</button>
            <button type="button" :disabled="isBusy" @click="patchSticker({ zIndex: (selectedSticker?.zIndex ?? 1) + 1 })">置顶</button>
            <button type="button" :disabled="isBusy" @click="removeSelectedSticker">删除</button>
          </div>
        </section>

        <section v-if="activeEditorStep === 5" class="section-block compact-block">
          <div class="section-heading">
            <h2>日记信息</h2>
            <span>轻微润色</span>
          </div>
          <div class="form-grid">
            <label>日期<input v-model="form.date" type="date" /></label>
            <label>地点<input v-model="form.location" placeholder="比如：街角奶茶店" /></label>
            <label>一句提示<input v-model="prompt" placeholder="今天发生了什么？" /></label>
            <label>标签<input v-model="tagText" placeholder="美食 朋友 自我照顾" /></label>
            <label>心情<select v-model="form.mood"><option v-for="mood in moods" :key="mood">{{ mood }}</option></select></label>
            <label>文字风格<select v-model="form.writingStyle"><option v-for="style in writingStyles" :key="style">{{ style }}</option></select></label>
            <label>长度<select v-model="form.length"><option v-for="length in diaryLengths" :key="length">{{ length }}</option></select></label>
            <label>背景<select v-model="form.background"><option v-for="background in backgrounds" :key="background">{{ background }}</option></select></label>
          </div>
          <div class="chip-group compact">
            <button v-for="tag in defaultTags.slice(0, 6)" :key="tag" class="tag-pill button-chip" type="button" @click="tagText = `${tagText} ${tag}`.trim()">#{{ tag }}</button>
          </div>
          <textarea v-model="form.body" rows="5" placeholder="生成后可以继续修改文字。" />
          <div class="hero-actions">
            <button class="secondary-action" type="button" :disabled="generatingText" @click="generateText">{{ generatingText ? "生成中" : "生成日记" }}</button>
            <button class="secondary-action" type="button" :disabled="savingDiary" @click="save('draft')">{{ savingDiary ? "保存中" : "保存草稿" }}</button>
            <button class="primary-action" type="button" :disabled="savingDiary" @click="save('done')">{{ savingDiary ? "保存中" : "完成保存" }}</button>
          </div>
        </section>

        <div class="wizard-actions">
          <button class="secondary-action" type="button" :disabled="activeEditorStep === 1" @click="previousEditorStep">上一步</button>
          <button v-if="activeEditorStep < editorSteps.length" class="primary-action" type="button" :disabled="isBusy || !canGoNextStep" @click="nextEditorStep">下一步</button>
          <button v-else class="primary-action" type="button" :disabled="savingDiary" @click="save('done')">{{ savingDiary ? "保存中" : "完成保存" }}</button>
        </div>
      </div>
    </section>
  </section>
</template>

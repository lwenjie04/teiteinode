<script setup lang="ts">
import type { Sticker } from "@tietie/shared";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDiaryStore } from "../stores/diaryStore";
import { useUiStore } from "../stores/uiStore";

const route = useRoute();
const router = useRouter();
const store = useDiaryStore();
const ui = useUiStore();
const diary = computed(() => store.diaries.find((item) => item.id === route.params.id) ?? store.latest);
const renderingImage = ref(false);
const brokenStickerIds = ref(new Set<string>());
const brokenCardImage = ref(false);

const pendingSyncDiaryIds = computed(() => {
  const ids = new Set<string>();
  for (const item of store.syncQueueItems) {
    if (!item.type.startsWith("diary:")) continue;
    const payload = item.payload;
    if (!payload || typeof payload !== "object") continue;
    const id = (payload as { id?: unknown }).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
});
const diaryHasPendingSync = computed(() => Boolean(diary.value && pendingSyncDiaryIds.value.has(diary.value.id)));
const cardImageNeedsRepair = computed(() => Boolean(diary.value?.cardImageUrl && (brokenCardImage.value || isVolatileImageUrl(diary.value.cardImageUrl))));
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
const originalPhotoItems = computed(() => {
  if (!diary.value) return [];
  const sources = new Map<string, number>();
  for (const sticker of diary.value.stickers) {
    const sourceUrl = sticker.sourceImageUrl ?? sticker.remoteImageUrl;
    if (!sourceUrl) continue;
    sources.set(sourceUrl, (sources.get(sourceUrl) ?? 0) + 1);
  }
  return [...sources.entries()].map(([url, count], index) => ({ id: `${index}:${url}`, url, count }));
});
const stickerMaterialItems = computed(() =>
  diary.value?.stickers.map((sticker, index) => ({
    id: sticker.id,
    url: sticker.fileUrl,
    title: `贴纸 ${index + 1}`,
    subtitle: sticker.variant
  })) ?? []
);

watch(
  () => diary.value?.cardImageUrl ?? "",
  () => {
    brokenCardImage.value = false;
  },
  { immediate: true }
);

async function copyText() {
  if (!diary.value?.body) return;
  await navigator.clipboard.writeText(diary.value.body);
  ui.showToast("日记文字已复制", "success");
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
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
}

function markCardImageLoaded() {
  brokenCardImage.value = false;
}

function markCardImageFailed() {
  brokenCardImage.value = true;
}

function openCardImageRepair() {
  if (!diary.value) return;
  router.push({
    path: `/diaries/${diary.value.id}/edit`,
    query: {
      repair: "card",
      issue: `${diary.value.id}:card`
    }
  });
}

function openStickerRepair(stickerId: string) {
  if (!diary.value) return;
  router.push({
    path: `/diaries/${diary.value.id}/edit`,
    query: {
      repair: "sticker",
      stickerId,
      issue: `${diary.value.id}:${stickerId}:file`
    }
  });
}

function drawWrappedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const chars = Array.from(text);
  let line = "";
  let cursorY = y;
  for (const char of chars) {
    const next = line + char;
    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, x, cursorY);
      line = char;
      cursorY += lineHeight;
    } else {
      line = next;
    }
  }
  if (line) context.fillText(line, x, cursorY);
}

function drawMissingStickerPlaceholder(context: CanvasRenderingContext2D, sticker: Sticker) {
  const size = 230 * sticker.scale;
  const x = (sticker.x / 100) * 1200;
  const y = (sticker.y / 100) * 1120;
  context.save();
  context.translate(x, y);
  context.rotate((sticker.rotation * Math.PI) / 180);
  context.fillStyle = "#fff5f1";
  context.strokeStyle = "#b7424c";
  context.lineWidth = 6;
  context.fillRect(-size / 2 - 18, -size / 2 - 18, size + 36, size + 54);
  context.strokeRect(-size / 2 - 18, -size / 2 - 18, size + 36, size + 54);
  context.fillStyle = "#b7424c";
  context.font = "700 30px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("图片需修复", 0, 0);
  context.restore();
}

async function renderDiaryImageCanvas() {
  if (!diary.value) throw new Error("日记不存在");
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 1600;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("画布创建失败");

  const backgroundMap: Record<string, string> = {
    牛皮纸: "#e8c68e",
    横线纸: "#fffdf4",
    拍立得: "#ffffff",
    柔和纯色: "#dff3ff",
    透明: "#ffffff"
  };
  context.fillStyle = backgroundMap[diary.value.background] ?? "#fffdf4";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (diary.value.background === "横线纸") {
    context.strokeStyle = "rgba(47, 110, 163, 0.18)";
    context.lineWidth = 3;
    for (let y = 120; y < 1280; y += 62) {
      context.beginPath();
      context.moveTo(80, y);
      context.lineTo(1120, y);
      context.stroke();
    }
  }

  let skippedStickers = 0;
  for (const sticker of diary.value.stickers) {
    try {
      const image = await loadImage(sticker.fileUrl);
      const size = 230 * sticker.scale;
      const x = (sticker.x / 100) * canvas.width;
      const y = (sticker.y / 100) * 1120;
      context.save();
      context.translate(x, y);
      context.rotate((sticker.rotation * Math.PI) / 180);
      context.fillStyle = "#ffffff";
      context.fillRect(-size / 2 - 18, -size / 2 - 18, size + 36, size + 54);
      context.drawImage(image, -size / 2, -size / 2, size, size);
      context.restore();
    } catch {
      skippedStickers += 1;
      drawMissingStickerPlaceholder(context, sticker);
    }
  }

  for (const decoration of diary.value.decorations ?? []) {
    const x = (decoration.x / 100) * canvas.width;
    const y = (decoration.y / 100) * 1120;
    context.save();
    context.translate(x, y);
    context.rotate((decoration.rotation * Math.PI) / 180);
    context.scale(decoration.scale, decoration.scale);
    context.fillStyle = decoration.color;
    context.strokeStyle = "#2f6ea3";
    context.lineWidth = 5;
    context.roundRect(-80, -32, 160, 64, decoration.kind === "emoji" ? 32 : 14);
    context.fill();
    context.stroke();
    context.fillStyle = "#263447";
    context.font = decoration.kind === "emoji" ? "700 40px sans-serif" : "700 28px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(decoration.text, 0, 2);
    context.restore();
  }

  for (const stroke of diary.value.doodles ?? []) {
    if (stroke.points.length < 2) continue;
    context.save();
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.size * 2.4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    stroke.points.forEach((point, index) => {
      const x = (point.x / 100) * canvas.width;
      const y = (point.y / 100) * 1120;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
    context.restore();
  }

  context.fillStyle = "rgba(255,255,255,0.94)";
  context.strokeStyle = "#2f6ea3";
  context.lineWidth = 6;
  context.roundRect(70, 1180, 1060, 300, 24);
  context.fill();
  context.stroke();

  context.fillStyle = "#263447";
  context.font = "700 42px sans-serif";
  context.textAlign = "left";
  context.fillText(`${diary.value.mood} · ${diary.value.date}`, 110, 1260);
  context.font = "36px sans-serif";
  drawWrappedText(context, diary.value.body || "这篇日记还在路上。", 110, 1330, 980, 52);

  return {
    canvas,
    skippedStickers
  };
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片生成失败"));
    }, "image/png");
  });
}

function downloadImageBlob(blob: Blob) {
  if (!diary.value) return;
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.download = `贴贴日记-${diary.value.date}.png`;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportImage() {
  if (renderingImage.value) return;
  renderingImage.value = true;
  try {
    const { canvas, skippedStickers } = await renderDiaryImageCanvas();
    const blob = await canvasToPngBlob(canvas);
    downloadImageBlob(blob);
    ui.showToast(skippedStickers ? `图片已导出，${skippedStickers} 张贴纸需要回编辑器修复` : "图片已导出", skippedStickers ? "warning" : "success");
  } catch {
    ui.showToast("图片导出失败，请稍后再试", "warning");
  } finally {
    renderingImage.value = false;
  }
}

async function shareImage() {
  if (!diary.value || renderingImage.value) return;
  renderingImage.value = true;
  try {
    const { canvas, skippedStickers } = await renderDiaryImageCanvas();
    const blob = await canvasToPngBlob(canvas);
    const file = new File([blob], `贴贴日记-${diary.value.date}.png`, { type: "image/png" });
    const payload = {
      files: [file],
      title: "贴贴日记",
      text: diary.value.body || "我的照片小日记"
    };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      await navigator.share(payload);
      ui.showToast(skippedStickers ? `已打开分享，${skippedStickers} 张贴纸显示为修复占位` : "已打开分享", skippedStickers ? "warning" : "success");
    } else {
      downloadImageBlob(blob);
      ui.showToast(skippedStickers ? `已导出图片，${skippedStickers} 张贴纸显示为修复占位` : "当前浏览器不支持直接分享，已导出图片", "warning");
    }
  } catch {
    ui.showToast("分享失败，请稍后再试", "warning");
  } finally {
    renderingImage.value = false;
  }
}

async function deleteCurrentDiary() {
  if (!diary.value) return;
  const confirmed = window.confirm("确定删除这篇日记吗？删除后会在下次同步时从云端移除。");
  if (!confirmed) return;
  await store.removeDiary(diary.value.id);
  ui.showToast("日记已删除", "warning");
  router.push("/timeline");
}
</script>

<template>
  <section v-if="diary" class="detail-page">
    <div class="page-title">
      <p class="eyebrow">{{ diary.date }}</p>
      <h1>{{ diary.status === "draft" ? "未完成草稿" : "日记详情" }}</h1>
    </div>

    <section v-if="diary.cardImageUrl" class="detail-cover-panel" :class="{ broken: cardImageNeedsRepair }">
      <div class="detail-cover-frame">
        <img v-if="!brokenCardImage" :src="diary.cardImageUrl" alt="卡片预览图" @load="markCardImageLoaded" @error="markCardImageFailed" />
        <span v-else>{{ diary.mood }}</span>
        <strong v-if="cardImageNeedsRepair" class="thumb-warning-badge">{{ brokenCardImage ? "失效" : "临时" }}</strong>
      </div>
      <div>
        <strong>卡片预览图</strong>
        <p>{{ cardImageNeedsRepair ? "这张预览图需要修复，时间线和备份检查会标记它。" : "时间线会优先显示这张预览图。" }}</p>
      </div>
      <button type="button" class="secondary-action compact-action" @click="openCardImageRepair">
        {{ cardImageNeedsRepair ? "修复预览图" : "替换预览图" }}
      </button>
    </section>

    <article class="detail-card">
      <div class="detail-art" :class="`bg-${diary.background}`">
        <svg class="doodle-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline
            v-for="stroke in diary.doodles ?? []"
            :key="stroke.id"
            :points="stroke.points.map((point) => `${point.x},${point.y}`).join(' ')"
            :stroke="stroke.color"
            :stroke-width="stroke.size / 5"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        <div
          v-for="sticker in diary.stickers"
          :key="sticker.id"
          class="canvas-sticker readonly"
          :class="{ broken: stickerNeedsRepair(sticker) }"
          :style="{
            left: `${sticker.x}%`,
            top: `${sticker.y}%`,
            transform: `translate(-50%, -50%) rotate(${sticker.rotation}deg) scale(${sticker.scale})`,
            zIndex: sticker.zIndex
          }"
        >
          <img :src="sticker.fileUrl" :alt="sticker.variant" @load="markStickerImageLoaded(sticker.id)" @error="markStickerImageFailed(sticker)" />
          <strong v-if="stickerNeedsRepair(sticker)" class="sticker-warning-badge">{{ brokenStickerIds.has(sticker.id) || sticker.status === "failed" ? "失效" : "临时" }}</strong>
          <span>{{ sticker.variant }}</span>
        </div>

        <div
          v-for="decoration in diary.decorations ?? []"
          :key="decoration.id"
          class="canvas-decoration readonly"
          :class="`decoration-${decoration.kind}`"
          :style="{
            left: `${decoration.x}%`,
            top: `${decoration.y}%`,
            transform: `translate(-50%, -50%) rotate(${decoration.rotation}deg) scale(${decoration.scale})`,
            zIndex: decoration.zIndex,
            backgroundColor: decoration.color
          }"
        >
          {{ decoration.text }}
        </div>

        <div v-if="!diary.stickers.length" class="mock-sticker sticker-a">{{ diary.mood }}</div>
        <div class="mock-caption">{{ diary.location || "今天的小片刻" }}</div>
      </div>
      <p>{{ diary.body || "这篇还没有生成正文，可以继续编辑。" }}</p>
    </article>

    <div v-if="stickerHealthIssues.length" class="health-panel warning-panel detail-health-panel">
      <div>
        <strong>{{ stickerHealthIssues.length }} 个贴纸需要修复</strong>
        <p>导出和分享时会用占位图标出问题贴纸。进入编辑页后，可以用素材库替换并保留原排版。</p>
      </div>
      <article v-for="issue in stickerHealthIssues" :key="issue.id" class="health-row">
        <div>
          <strong>{{ issue.label }}</strong>
          <span>{{ issue.reason }}</span>
        </div>
        <button type="button" class="secondary-action compact-action" @click="openStickerRepair(issue.stickerId)">打开修复</button>
      </article>
    </div>

    <div class="detail-meta">
      <span>心情：{{ diary.mood }}</span>
      <span>风格：{{ diary.writingStyle }}</span>
      <span>长度：{{ diary.length }}</span>
      <span>背景：{{ diary.background }}</span>
      <span v-if="diaryHasPendingSync">待同步</span>
      <span>同步：{{ store.syncState }}</span>
    </div>

    <div class="chip-group compact">
      <span v-for="tag in diary.tags" :key="tag" class="tag-pill">#{{ tag }}</span>
    </div>

    <section v-if="originalPhotoItems.length || stickerMaterialItems.length" class="section-block compact-block detail-material-panel">
      <div class="section-heading">
        <h2>素材回看</h2>
        <span>{{ originalPhotoItems.length }} 张原图 · {{ stickerMaterialItems.length }} 个贴纸</span>
      </div>
      <div v-if="originalPhotoItems.length" class="detail-material-grid">
        <article v-for="item in originalPhotoItems" :key="item.id" class="detail-material-card">
          <img :src="item.url" alt="原始照片" />
          <div>
            <strong>原始照片</strong>
            <span>{{ item.count }} 个主体来源</span>
          </div>
        </article>
      </div>
      <div v-if="stickerMaterialItems.length" class="detail-material-grid">
        <article v-for="item in stickerMaterialItems" :key="item.id" class="detail-material-card">
          <img :src="item.url" alt="贴纸素材" />
          <div>
            <strong>{{ item.title }}</strong>
            <span>{{ item.subtitle }}</span>
          </div>
        </article>
      </div>
    </section>

    <div class="footer-actions">
      <button class="primary-action" type="button" @click="router.push(`/diaries/${diary.id}/edit`)">继续编辑</button>
      <button class="secondary-action" type="button" :disabled="renderingImage" @click="shareImage">{{ renderingImage ? "生成中" : "分享图片" }}</button>
      <button class="secondary-action" type="button" :disabled="renderingImage" @click="exportImage">导出图片</button>
      <button class="secondary-action" type="button" @click="copyText">复制文字</button>
      <button class="secondary-action danger-action" type="button" @click="deleteCurrentDiary">删除</button>
    </div>
  </section>
</template>

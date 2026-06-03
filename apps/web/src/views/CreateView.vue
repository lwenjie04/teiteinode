<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { uploadImage } from "../lib/api";
import { formatLocalDateKey } from "../lib/dateTools";
import { fileToDataUrl, preparePhotoFile } from "../lib/imageTools";
import { saveLocalAsset } from "../lib/localDb";
import { useAuthStore } from "../stores/authStore";
import { useDiaryStore } from "../stores/diaryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

const store = useDiaryStore();
const settings = useSettingsStore();
const auth = useAuthStore();
const ui = useUiStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const cameraInput = ref<HTMLInputElement | null>(null);
const todayKey = formatLocalDateKey();
const todayDiaries = computed(() => store.diaries.filter((diary) => diary.date === todayKey));
const visibleDrafts = computed(() => store.drafts.slice(0, 1));
const latestDiary = computed(() => store.doneDiaries[0]);
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

interface DraftImageSource {
  url: string;
  uploaded: boolean;
  filename: string;
  mimeType: string;
  size: number;
  compressed: boolean;
}

async function imageSourceFor(file: File): Promise<DraftImageSource> {
  const prepared = await preparePhotoFile(file);
  if (!auth.token) {
    return {
      url: await fileToDataUrl(prepared.file),
      uploaded: false,
      filename: prepared.file.name || file.name || "photo.jpg",
      mimeType: prepared.file.type || file.type || "image/jpeg",
      size: prepared.file.size,
      compressed: prepared.compressed
    };
  }
  try {
    const uploaded = await uploadImage(auth.token, prepared.file);
    return {
      url: uploaded.url,
      uploaded: true,
      filename: uploaded.filename,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      compressed: prepared.compressed
    };
  } catch {
    ui.showToast("图片上传失败，已改用本地保存", "warning");
    return {
      url: await fileToDataUrl(prepared.file),
      uploaded: false,
      filename: prepared.file.name || file.name || "photo.jpg",
      mimeType: prepared.file.type || file.type || "image/jpeg",
      size: prepared.file.size,
      compressed: prepared.compressed
    };
  }
}

async function startDraft(files?: FileList | null) {
  const draft = await store.createDraft({
    writingStyle: settings.values.defaultWritingStyle,
    length: settings.values.defaultDiaryLength,
    background: settings.values.defaultBackground
  });
  if (files?.length) {
    let compressedCount = 0;
    for (const file of Array.from(files).slice(0, 6)) {
      const source = await imageSourceFor(file);
      if (source.compressed) compressedCount += 1;
      if (!source.uploaded) {
        await saveLocalAsset({
          id: crypto.randomUUID(),
          filename: source.filename,
          mimeType: source.mimeType,
          size: source.size,
          url: source.url,
          createdAt: new Date().toISOString()
        });
      }
      await store.addSticker(draft.id, source.url);
    }
    const compressText = compressedCount ? `，已压缩 ${compressedCount} 张大图` : "";
    ui.showToast(auth.token ? `照片已添加，并尝试上传素材${compressText}` : `照片已添加到本地草稿${compressText}`, "success");
  }
  router.push(`/diaries/${draft.id}/edit`);
}

async function handleFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  await startDraft(input.files);
  input.value = "";
}

function openDiary(id: string, edit = false) {
  router.push(edit ? `/diaries/${id}/edit` : `/diaries/${id}`);
}

function diaryHasPendingSync(id: string) {
  return pendingSyncDiaryIds.value.has(id);
}
</script>

<template>
  <section class="home-page">
    <input ref="fileInput" class="visually-hidden" type="file" accept="image/*" multiple @change="handleFiles" />
    <input ref="cameraInput" class="visually-hidden" type="file" accept="image/*" capture="environment" @change="handleFiles" />

    <div class="paper-hero">
      <p class="eyebrow">{{ todayKey }}</p>
      <h1>贴贴日记</h1>
      <p class="hero-copy">{{ todayDiaries.length ? `今天已有 ${todayDiaries.length} 篇记录。` : "拍一张照片，写一点今天。" }}</p>
      <div class="hero-actions hero-primary-row">
        <button class="primary-action hero-main-action" type="button" @click="cameraInput?.click()">拍一张，开始记录</button>
      </div>
      <div class="hero-link-row">
        <button class="link-action" type="button" @click="fileInput?.click()">从相册选</button>
      </div>
    </div>

    <section v-if="visibleDrafts.length" class="section-block">
      <div class="section-heading">
        <h2>继续草稿</h2>
        <span>{{ store.drafts.length }} 篇未完成</span>
      </div>
      <article v-for="draft in visibleDrafts" :key="draft.id" class="home-diary-card" @click="openDiary(draft.id, true)">
        <div class="diary-thumb draft">
          <img v-if="draft.cardImageUrl" :src="draft.cardImageUrl" alt="" />
          <span v-else class="thumb-fallback">草稿</span>
        </div>
        <div>
          <strong>{{ draft.date }}</strong>
          <p>{{ draft.body || "还没有写正文，点这里继续补上。" }}</p>
          <span>{{ draft.stickers.length }} 张贴纸 · {{ draft.mood }}{{ diaryHasPendingSync(draft.id) ? " · 待同步" : "" }}</span>
        </div>
      </article>
    </section>

    <section class="section-block">
      <div class="section-heading">
        <h2>最近记录</h2>
        <span>{{ store.doneDiaries.length }} 篇完成</span>
      </div>
      <div v-if="latestDiary" class="latest-diary-card" @click="openDiary(latestDiary.id)">
        <div class="diary-thumb">
          <img v-if="latestDiary.cardImageUrl" :src="latestDiary.cardImageUrl" alt="" />
          <span v-else class="thumb-fallback">{{ latestDiary.mood }}</span>
        </div>
        <div>
          <strong>{{ latestDiary.date }} · {{ latestDiary.mood }}</strong>
          <p>{{ latestDiary.body || "这篇日记还没有正文。" }}</p>
          <span v-if="diaryHasPendingSync(latestDiary.id)">待同步</span>
          <div class="tag-line">
            <span v-for="tag in latestDiary.tags.slice(0, 3)" :key="tag">#{{ tag }}</span>
          </div>
        </div>
      </div>
      <div v-if="!latestDiary" class="empty-list compact-empty">
        <strong>还没有完成的日记</strong>
        <span>从拍照或相册开始，第一篇会出现在这里。</span>
      </div>
    </section>
  </section>
</template>

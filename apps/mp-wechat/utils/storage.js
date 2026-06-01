const diaryKey = "tietie.diaries";

const moods = ["开心", "平静", "疲惫", "感动", "焦虑", "期待", "治愈", "生气", "孤独", "松弛"];
const stickerVariants = ["白边原图贴纸", "旅行插画风", "像素风格", "线条手绘风", "可爱漫画风", "复古邮票风"];
const defaultDiarySettings = {
  writingStyle: "可爱活泼",
  length: "一小段",
  background: "横线纸"
};

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTimestamp(diary) {
  if (!diary) return "";
  return diary.lastModifiedAt || diary.updatedAt || diary.createdAt || "";
}

function uniq(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function normalizeMood(mood) {
  return moods.includes(mood) ? mood : "开心";
}

function normalizeVariant(variant) {
  return stickerVariants.includes(variant) ? variant : "白边原图贴纸";
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSticker(sticker, diaryId, index) {
  const fileUrl = sticker.fileUrl || sticker.sourceImageUrl || sticker.originalFileUrl || "";
  return {
    id: sticker.id || `${diaryId}-sticker-${index}`,
    diaryId,
    fileUrl,
    sourceImageUrl: sticker.sourceImageUrl || fileUrl,
    originalFileUrl: sticker.originalFileUrl || sticker.sourceImageUrl || fileUrl,
    variant: normalizeVariant(sticker.variant),
    status: sticker.status || "ready",
    x: toNumber(sticker.x, 30 + index * 12),
    y: toNumber(sticker.y, 30 + index * 10),
    scale: toNumber(sticker.scale, 1),
    rotation: toNumber(sticker.rotation, index % 2 === 0 ? -6 : 7),
    zIndex: toNumber(sticker.zIndex, index + 1),
    selection: sticker.selection,
    errorMessage: sticker.errorMessage || ""
  };
}

function normalizeDiary(diary) {
  const createdAt = diary.createdAt || nowIso();
  const updatedAt = diary.updatedAt || diary.lastModifiedAt || createdAt;
  const id = diary.id;
  return {
    id,
    localId: diary.localId || id,
    status: diary.status || "draft",
    date: diary.date || todayKey(),
    mood: normalizeMood(diary.mood),
    body: diary.body || "",
    tags: uniq(diary.tags),
    photos: uniq(diary.photos),
    writingStyle: diary.writingStyle || defaultDiarySettings.writingStyle,
    length: diary.length || defaultDiarySettings.length,
    background: diary.background || defaultDiarySettings.background,
    cardImageUrl: diary.cardImageUrl || "",
    stickers: (diary.stickers || []).filter((sticker) => sticker.fileUrl || sticker.sourceImageUrl).map((sticker, index) => normalizeSticker(sticker, id, index)),
    decorations: diary.decorations || [],
    doodles: diary.doodles || [],
    createdAt,
    updatedAt,
    lastModifiedAt: diary.lastModifiedAt || updatedAt
  };
}

function listDiaries() {
  return (wx.getStorageSync(diaryKey) || []).map(normalizeDiary).sort((a, b) => getTimestamp(b).localeCompare(getTimestamp(a)));
}

function saveDiaries(diaries) {
  wx.setStorageSync(diaryKey, diaries.map(normalizeDiary).sort((a, b) => getTimestamp(b).localeCompare(getTimestamp(a))));
}

function getDiary(id) {
  return listDiaries().find((diary) => diary.id === id);
}

function upsertDiary(diary) {
  const normalized = normalizeDiary(diary);
  const diaries = listDiaries();
  const index = diaries.findIndex((item) => item.id === normalized.id);
  if (index >= 0) diaries.splice(index, 1, normalized);
  else diaries.unshift(normalized);
  saveDiaries(diaries);
  return normalized;
}

function createDiary(input = {}) {
  const createdAt = nowIso();
  return upsertDiary({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    localId: "",
    status: "draft",
    date: todayKey(),
    mood: "开心",
    body: "",
    tags: [],
    photos: [],
    stickers: [],
    createdAt,
    updatedAt: createdAt,
    lastModifiedAt: createdAt,
    ...defaultDiarySettings,
    ...input
  });
}

function removeDiary(id) {
  saveDiaries(listDiaries().filter((diary) => diary.id !== id));
}

function toCloudDiary(diary) {
  const normalized = normalizeDiary(diary);
  const photos = uniq(normalized.photos);
  const cardImageUrl = normalized.cardImageUrl || photos[0] || "";
  const stickerUrls = new Set(normalized.stickers.map((sticker) => sticker.fileUrl));
  const photoStickers = photos.filter((url) => !stickerUrls.has(url)).map((url, index) => ({
    id: `${normalized.id}-photo-${index}`,
    diaryId: normalized.id,
    fileUrl: url,
    sourceImageUrl: url,
    originalFileUrl: url,
    variant: "白边原图贴纸",
    status: "ready",
    x: 32 + index * 18,
    y: 36 + index * 14,
    scale: 1,
    rotation: index % 2 === 0 ? -6 : 7,
    zIndex: index + 1
  }));
  const stickers = [...normalized.stickers, ...photoStickers].map((sticker, index) => ({
    ...normalizeSticker(sticker, normalized.id, index),
    zIndex: index + 1
  }));

  return {
    id: normalized.id,
    localId: normalized.localId || normalized.id,
    status: normalized.status,
    body: normalized.body,
    date: normalized.date,
    mood: normalized.mood,
    tags: normalized.tags,
    writingStyle: normalized.writingStyle,
    length: normalized.length,
    background: normalized.background,
    cardImageUrl,
    stickers,
    decorations: normalized.decorations,
    doodles: normalized.doodles,
    lastModifiedAt: normalized.lastModifiedAt || normalized.updatedAt,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt
  };
}

function fromCloudDiary(cloudDiary) {
  const stickerPhotos = (cloudDiary.stickers || []).map((sticker) => sticker.fileUrl || sticker.sourceImageUrl).filter(Boolean);
  const photos = uniq([...(cloudDiary.cardImageUrl ? [cloudDiary.cardImageUrl] : []), ...stickerPhotos]);
  return normalizeDiary({
    id: cloudDiary.id,
    localId: cloudDiary.localId || cloudDiary.id,
    status: cloudDiary.status,
    body: cloudDiary.body,
    date: cloudDiary.date,
    mood: cloudDiary.mood,
    tags: cloudDiary.tags,
    photos,
    writingStyle: cloudDiary.writingStyle,
    length: cloudDiary.length,
    background: cloudDiary.background,
    cardImageUrl: cloudDiary.cardImageUrl || photos[0] || "",
    stickers: cloudDiary.stickers || [],
    decorations: cloudDiary.decorations || [],
    doodles: cloudDiary.doodles || [],
    createdAt: cloudDiary.createdAt,
    updatedAt: cloudDiary.updatedAt,
    lastModifiedAt: cloudDiary.lastModifiedAt || cloudDiary.updatedAt
  });
}

function mergeCloudDiaries(cloudDiaries = []) {
  const local = new Map(listDiaries().map((diary) => [diary.id, diary]));
  for (const cloudDiary of cloudDiaries) {
    const incoming = fromCloudDiary(cloudDiary);
    const existing = local.get(incoming.id);
    if (!existing || getTimestamp(incoming) >= getTimestamp(existing)) {
      local.set(incoming.id, incoming);
    }
  }
  const merged = [...local.values()];
  saveDiaries(merged);
  return listDiaries();
}

module.exports = {
  createDiary,
  defaultDiarySettings,
  fromCloudDiary,
  getDiary,
  listDiaries,
  mergeCloudDiaries,
  moods,
  nowIso,
  removeDiary,
  saveDiaries,
  stickerVariants,
  todayKey,
  toCloudDiary,
  upsertDiary
};

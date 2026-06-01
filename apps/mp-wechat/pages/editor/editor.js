const api = require("../../utils/api");
const { defaultDiarySettings, getDiary, moods, nowIso, upsertDiary } = require("../../utils/storage");

const writingStyles = ["可爱活泼", "文艺感", "吐槽幽默"];
const diaryLengths = ["一句话", "一小段", "两三段"];
const stickerVariants = ["白边原图贴纸", "旅行插画风", "像素风格", "线条手绘风", "可爱漫画风", "复古邮票风"];
const selectionModes = ["点选主体", "框选主体"];
const selectionPresets = [
  {
    name: "中心主体",
    selection: { mode: "point", x: 50, y: 50 }
  },
  {
    name: "上方主体",
    selection: { mode: "box", x: 20, y: 8, width: 60, height: 58 }
  },
  {
    name: "整张主体",
    selection: { mode: "box", x: 5, y: 5, width: 90, height: 90 }
  },
  {
    name: "左侧主体",
    selection: { mode: "point", x: 28, y: 52 }
  },
  {
    name: "右侧主体",
    selection: { mode: "point", x: 72, y: 52 }
  }
];

function isRemotePhoto(url) {
  if (!url) return true;
  if (url.startsWith("/uploads/") || url.startsWith("data:image/")) return true;
  if (/^https?:\/\/(tmp|usr)\//.test(url)) return false;
  return /^https?:\/\//.test(url);
}

function toast(title, icon = "none") {
  wx.showToast({ title, icon });
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function getPhotoAt(diary, index) {
  const photos = diary && diary.photos ? diary.photos : [];
  return photos[index] || photos[0] || "";
}

function getPointStyle(selection) {
  return `left: ${selection.x}%; top: ${selection.y}%;`;
}

function getBoxStyle(selection) {
  return `left: ${selection.x}%; top: ${selection.y}%; width: ${selection.width}%; height: ${selection.height}%;`;
}

function getStickerStyle(sticker) {
  const size = Math.round(150 * (sticker.scale || 1));
  return `left: ${sticker.x}%; top: ${sticker.y}%; width: ${size}rpx; height: ${size}rpx; transform: translate(-50%, -50%) rotate(${sticker.rotation || 0}deg); z-index: ${sticker.zIndex || 1};`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wrapText(text, lineLength, maxLines) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return ["今天的小日记，还在等我慢慢补上。"];
  const lines = [];
  for (let index = 0; index < source.length && lines.length < maxLines; index += lineLength) {
    lines.push(source.slice(index, index + lineLength));
  }
  if (source.length > lineLength * maxLines && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, lineLength - 1))}...`;
  }
  return lines;
}

Page({
  data: {
    aiMessage: "",
    body: "",
    cardImagePath: "",
    customSelectionEnabled: false,
    diary: null,
    diaryLengthIndex: 1,
    diaryLengths,
    exportingCard: false,
    generatingDiary: false,
    id: "",
    moodIndex: 0,
    moods,
    processingSticker: false,
    selectedPhotoIndex: 0,
    selectedPhotoUrl: "",
    selectedStickerId: "",
    selectionModeIndex: 0,
    selectionModes,
    selectionPresetIndex: 0,
    selectionPresets,
    subjectBoxStyle: "left: 20%; top: 20%; width: 60%; height: 60%;",
    subjectPointStyle: "left: 50%; top: 50%;",
    subjectSelection: { mode: "point", x: 50, y: 50 },
    stickerVariantIndex: 1,
    stickerVariants,
    hasStickers: false,
    selectedStickerText: "",
    stickerItems: [],
    writingStyleIndex: 0,
    writingStyles,
    tagsText: ""
  },
  onLoad(options) {
    const diary = getDiary(options.id);
    if (!diary) {
      wx.navigateBack();
      return;
    }
    this.setData({
      id: diary.id,
      ...this.getDiaryViewState(diary, ""),
      diaryLengthIndex: Math.max(0, diaryLengths.indexOf(diary.length || defaultDiarySettings.length)),
      moodIndex: Math.max(0, moods.indexOf(diary.mood)),
      body: diary.body,
      stickerVariantIndex: 1,
      selectedPhotoUrl: getPhotoAt(diary, 0),
      tagsText: (diary.tags || []).join(" "),
      writingStyleIndex: Math.max(0, writingStyles.indexOf(diary.writingStyle || defaultDiarySettings.writingStyle))
    });
  },
  getDiaryViewState(diary, preferredStickerId) {
    const stickers = diary.stickers || [];
    const selectedSticker = stickers.find((sticker) => sticker.id === preferredStickerId) || stickers[0] || null;
    const selectedStickerId = selectedSticker ? selectedSticker.id : "";
    return {
      diary,
      hasStickers: Boolean(stickers.length),
      selectedStickerId,
      selectedStickerText: selectedSticker ? `${selectedSticker.variant} · ${Math.round((selectedSticker.scale || 1) * 100)}%` : "",
      stickerItems: stickers.map((sticker) => ({
        ...sticker,
        boardStyle: getStickerStyle(sticker)
      }))
    };
  },
  resolveAssetUrl(url) {
    if (!url || url.startsWith("data:image/")) return "";
    if (url.startsWith("/uploads/")) {
      return `${api.getApiBase().replace(/\/api$/, "")}${url}`;
    }
    return url;
  },
  prepareCanvasImage(url) {
    const source = this.resolveAssetUrl(url);
    if (!source) return Promise.resolve("");
    if (!/^https?:\/\//.test(source)) return Promise.resolve(source);
    return new Promise((resolve) => {
      wx.downloadFile({
        url: source,
        success: (result) => {
          resolve(result.statusCode >= 200 && result.statusCode < 300 ? result.tempFilePath : "");
        },
        fail: () => resolve("")
      });
    });
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 6,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const photos = result.tempFiles.map((file) => file.tempFilePath);
        const nextPhotos = [...(this.data.diary.photos || []), ...photos];
        const diary = this.buildDiary("draft", {
          photos: nextPhotos,
          cardImageUrl: nextPhotos[0] || this.data.diary.cardImageUrl || ""
        });
        upsertDiary(diary);
        this.setData({
          ...this.getDiaryViewState(diary, this.data.selectedStickerId),
          selectedPhotoIndex: Math.max(0, nextPhotos.length - photos.length),
          selectedPhotoUrl: getPhotoAt(diary, Math.max(0, nextPhotos.length - photos.length))
        });
      }
    });
  },
  selectPhoto(event) {
    const selectedPhotoIndex = Number(event.currentTarget.dataset.index);
    this.setData({
      selectedPhotoIndex,
      selectedPhotoUrl: getPhotoAt(this.data.diary, selectedPhotoIndex),
      customSelectionEnabled: false,
      selectionModeIndex: 0,
      subjectPointStyle: "left: 50%; top: 50%;",
      subjectSelection: { mode: "point", x: 50, y: 50 }
    });
  },
  onMoodChange(event) {
    this.setData({ moodIndex: Number(event.detail.value) });
  },
  onWritingStyleChange(event) {
    const writingStyleIndex = Number(event.detail.value);
    this.setData({ writingStyleIndex });
    this.persistDraft({ writingStyle: writingStyles[writingStyleIndex] });
  },
  onDiaryLengthChange(event) {
    const diaryLengthIndex = Number(event.detail.value);
    this.setData({ diaryLengthIndex });
    this.persistDraft({ length: diaryLengths[diaryLengthIndex] });
  },
  onStickerVariantChange(event) {
    this.setData({ stickerVariantIndex: Number(event.detail.value) });
  },
  onSelectionPresetChange(event) {
    this.setData({
      customSelectionEnabled: false,
      selectionModeIndex: 0,
      selectionPresetIndex: Number(event.detail.value),
      subjectPointStyle: "left: 50%; top: 50%;",
      subjectSelection: { mode: "point", x: 50, y: 50 }
    });
  },
  onSelectionModeChange(event) {
    const selectionModeIndex = Number(event.detail.value);
    if (selectionModeIndex === 1) {
      const selection = { mode: "box", x: 20, y: 20, width: 60, height: 60 };
      this.setData({
        customSelectionEnabled: true,
        selectionModeIndex,
        selectionPresetIndex: 0,
        subjectBoxStyle: getBoxStyle(selection),
        subjectSelection: selection
      });
      return;
    }
    const selection = { mode: "point", x: 50, y: 50 };
    this.setData({
      customSelectionEnabled: false,
      selectionModeIndex,
      selectionPresetIndex: 0,
      subjectPointStyle: getPointStyle(selection),
      subjectSelection: selection
    });
  },
  onTagsInput(event) {
    this.setData({ tagsText: event.detail.value });
  },
  onBodyInput(event) {
    this.setData({ body: event.detail.value });
  },
  buildDiary(status, overrides = {}) {
    const updatedAt = nowIso();
    return {
      ...this.data.diary,
      status: status || this.data.diary.status || "draft",
      mood: moods[this.data.moodIndex],
      body: this.data.body,
      tags: this.getTags(),
      writingStyle: writingStyles[this.data.writingStyleIndex],
      length: diaryLengths[this.data.diaryLengthIndex],
      updatedAt,
      lastModifiedAt: updatedAt,
      ...overrides
    };
  },
  persistDraft(overrides = {}) {
    const diary = this.buildDiary("draft", overrides);
    upsertDiary(diary);
    this.setData({
      ...this.getDiaryViewState(diary, this.data.selectedStickerId),
      selectedPhotoUrl: getPhotoAt(diary, this.data.selectedPhotoIndex)
    });
    return diary;
  },
  setStickerList(stickers, selectedStickerId, persist) {
    const diary = this.buildDiary("draft", { stickers });
    if (persist) upsertDiary(diary);
    this.setData({
      ...this.getDiaryViewState(diary, selectedStickerId),
      selectedPhotoUrl: getPhotoAt(diary, this.data.selectedPhotoIndex)
    });
    return diary;
  },
  selectSticker(event) {
    const selectedStickerId = event.currentTarget.dataset.id;
    this.setData(this.getDiaryViewState(this.data.diary, selectedStickerId));
  },
  updateStickerById(stickerId, patch, persist = true) {
    if (!stickerId) return;
    const stickers = (this.data.diary.stickers || []).map((sticker) => {
      if (sticker.id !== stickerId) return sticker;
      return {
        ...sticker,
        ...patch(sticker)
      };
    });
    this.setStickerList(stickers, stickerId, persist);
  },
  updateSelectedSticker(patch) {
    this.updateStickerById(this.data.selectedStickerId, patch, true);
  },
  nudgeSticker(event) {
    const dx = Number(event.currentTarget.dataset.dx || 0);
    const dy = Number(event.currentTarget.dataset.dy || 0);
    this.updateSelectedSticker((sticker) => ({
      x: clampPercent((sticker.x || 50) + dx),
      y: clampPercent((sticker.y || 50) + dy)
    }));
  },
  scaleSticker(event) {
    const delta = Number(event.currentTarget.dataset.delta || 0);
    this.updateSelectedSticker((sticker) => ({
      scale: Math.min(1.8, Math.max(0.45, Number(((sticker.scale || 1) + delta).toFixed(2))))
    }));
  },
  rotateSticker(event) {
    const delta = Number(event.currentTarget.dataset.delta || 0);
    this.updateSelectedSticker((sticker) => ({
      rotation: Math.max(-45, Math.min(45, (sticker.rotation || 0) + delta))
    }));
  },
  bringStickerForward() {
    const stickers = [...(this.data.diary.stickers || [])];
    const selected = stickers.find((sticker) => sticker.id === this.data.selectedStickerId);
    if (!selected) return;
    const maxZ = stickers.reduce((max, sticker) => Math.max(max, sticker.zIndex || 1), 1);
    this.persistDraft({
      stickers: stickers.map((sticker) => (sticker.id === selected.id ? { ...sticker, zIndex: maxZ + 1 } : sticker))
    });
  },
  removeSticker() {
    const selected = (this.data.diary.stickers || []).find((sticker) => sticker.id === this.data.selectedStickerId);
    if (!selected) return;
    const stickers = (this.data.diary.stickers || []).filter((sticker) => sticker.id !== selected.id);
    const photos = (this.data.diary.photos || []).filter((photo) => photo !== selected.fileUrl);
    const diary = this.buildDiary("draft", {
      stickers,
      photos,
      cardImageUrl: photos[0] || ""
    });
    upsertDiary(diary);
    this.setData({
      ...this.getDiaryViewState(diary, ""),
      selectedPhotoIndex: 0,
      selectedPhotoUrl: getPhotoAt(diary, 0)
    });
  },
  readBoardPoint(event, callback) {
    const touch = (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]);
    if (!touch) return;
    wx.createSelectorQuery()
      .in(this)
      .select("#stickerBoard")
      .boundingClientRect((rect) => {
        if (!rect || !rect.width || !rect.height) return;
        const clientX = touch.clientX === undefined ? touch.pageX : touch.clientX;
        const clientY = touch.clientY === undefined ? touch.pageY : touch.clientY;
        const x = clampPercent(((clientX - rect.left) / rect.width) * 100);
        const y = clampPercent(((clientY - rect.top) / rect.height) * 100);
        callback({ x, y });
      })
      .exec();
  },
  startStickerDrag(event) {
    const stickerId = event.currentTarget.dataset.id;
    this.boardDragStickerId = stickerId;
    this.setData(this.getDiaryViewState(this.data.diary, stickerId));
    this.readBoardPoint(event, (point) => {
      this.updateStickerById(stickerId, () => point, false);
    });
  },
  moveStickerDrag(event) {
    if (!this.boardDragStickerId) return;
    this.readBoardPoint(event, (point) => {
      this.updateStickerById(this.boardDragStickerId, () => point, false);
    });
  },
  endStickerDrag(event) {
    const stickerId = this.boardDragStickerId;
    if (!stickerId) return;
    this.readBoardPoint(event, (point) => {
      this.updateStickerById(stickerId, () => point, true);
      this.boardDragStickerId = "";
    });
  },
  readPreviewPoint(event, callback) {
    const touch = (event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]);
    if (!touch) return;
    wx.createSelectorQuery()
      .in(this)
      .select("#subjectPreviewWrap")
      .boundingClientRect((rect) => {
        if (!rect || !rect.width || !rect.height) return;
        const clientX = touch.clientX === undefined ? touch.pageX : touch.clientX;
        const clientY = touch.clientY === undefined ? touch.pageY : touch.clientY;
        const x = clampPercent(((clientX - rect.left) / rect.width) * 100);
        const y = clampPercent(((clientY - rect.top) / rect.height) * 100);
        callback({ x, y });
      })
      .exec();
  },
  applyPointSelection(point) {
    const selection = { mode: "point", x: point.x, y: point.y };
    this.setData({
      customSelectionEnabled: true,
      selectionModeIndex: 0,
      selectionPresetIndex: 0,
      subjectSelection: selection,
      subjectPointStyle: getPointStyle(selection)
    });
  },
  applyBoxSelection(start, end) {
    const width = Math.max(4, Math.abs(end.x - start.x));
    const height = Math.max(4, Math.abs(end.y - start.y));
    const selection = {
      mode: "box",
      x: Math.min(100 - width, Math.min(start.x, end.x)),
      y: Math.min(100 - height, Math.min(start.y, end.y)),
      width,
      height
    };
    this.setData({
      customSelectionEnabled: true,
      selectionModeIndex: 1,
      selectionPresetIndex: 0,
      subjectBoxStyle: getBoxStyle(selection),
      subjectSelection: selection
    });
  },
  startSubjectSelection(event) {
    this.readPreviewPoint(event, (point) => {
      this.subjectDragStart = point;
      if (this.data.selectionModeIndex === 0) {
        this.applyPointSelection(point);
        return;
      }
      this.applyBoxSelection(point, point);
    });
  },
  moveSubjectSelection(event) {
    if (this.data.selectionModeIndex !== 1 || !this.subjectDragStart) return;
    this.readPreviewPoint(event, (point) => {
      this.applyBoxSelection(this.subjectDragStart, point);
    });
  },
  endSubjectSelection(event) {
    this.readPreviewPoint(event, (point) => {
      if (this.data.selectionModeIndex === 0) {
        this.applyPointSelection(point);
        return;
      }
      this.applyBoxSelection(this.subjectDragStart || point, point);
      this.subjectDragStart = null;
    });
  },
  ensureLogin() {
    if (api.getAuth().token) return true;
    this.setData({ aiMessage: "请先到设置页登录，再使用 AI 能力。" });
    toast("请先登录");
    return false;
  },
  getTags() {
    return this.data.tagsText.split(/\s+/).filter(Boolean);
  },
  async ensureRemotePhoto(index) {
    const photos = [...(this.data.diary.photos || [])];
    const photo = photos[index];
    if (!photo) throw new Error("请先添加一张照片");
    if (isRemotePhoto(photo)) return photo;

    const uploaded = await api.uploadImage(photo);
    const remoteUrl = uploaded.url || uploaded.relativeUrl || photo;
    photos[index] = remoteUrl;
    this.persistDraft({
      photos,
      cardImageUrl: photos[0] || this.data.diary.cardImageUrl || ""
    });
    return remoteUrl;
  },
  async generateDiary() {
    if (!this.ensureLogin()) return;
    this.setData({ generatingDiary: true, aiMessage: "正在根据照片和标签写一段小日记..." });
    try {
      const result = await api.generateDiary({
        prompt: this.data.body || "根据今天的照片和标签写一段自然的小日记",
        mood: moods[this.data.moodIndex],
        tags: this.getTags(),
        writingStyle: writingStyles[this.data.writingStyleIndex],
        length: diaryLengths[this.data.diaryLengthIndex],
        stickerCount: (this.data.diary.photos || []).length
      });
      const diary = this.buildDiary("draft", { body: result.text });
      upsertDiary(diary);
      this.setData({
        diary,
        body: result.text,
        aiMessage: `已生成正文：${result.policy || "轻微润色，不编造重大事件"}`
      });
      toast("已生成", "success");
    } catch (error) {
      this.setData({ aiMessage: error.message });
      toast(error.message);
    } finally {
      this.setData({ generatingDiary: false });
    }
  },
  async generateSticker() {
    if (!this.ensureLogin()) return;
    const index = this.data.selectedPhotoIndex || 0;
    const variant = stickerVariants[this.data.stickerVariantIndex];
    const preset = selectionPresets[this.data.selectionPresetIndex];
    const selection = this.data.customSelectionEnabled ? this.data.subjectSelection : preset.selection;
    const selectionLabel = this.data.customSelectionEnabled
      ? selection.mode === "box"
        ? `框选 ${selection.x}%, ${selection.y}%`
        : `点选 ${selection.x}%, ${selection.y}%`
      : preset.name;
    this.setData({ processingSticker: true, aiMessage: `正在按「${selectionLabel}」生成「${variant}」...` });
    try {
      const imageUrl = await this.ensureRemotePhoto(index);
      const segmented = await api.segmentSubject({
        imageUrl,
        selection
      });
      const stylized = await api.stylizeSticker({
        imageUrl: segmented.stickerUrl,
        variant
      });
      const stickerUrl = stylized.stickerUrl || segmented.stickerUrl || imageUrl;
      const photos = [...(this.data.diary.photos || [])];
      if (!photos.includes(stickerUrl)) photos.unshift(stickerUrl);
      const stickers = [...(this.data.diary.stickers || [])];
      const sticker = {
        id: `${this.data.diary.id}-sticker-${Date.now()}`,
        diaryId: this.data.diary.id,
        fileUrl: stickerUrl,
        sourceImageUrl: imageUrl,
        originalFileUrl: imageUrl,
        variant,
        status: "ready",
        selection,
        x: 50,
        y: 46,
        scale: 1,
        rotation: stickers.length % 2 === 0 ? -4 : 5,
        zIndex: stickers.length + 1
      };
      const diary = this.buildDiary("draft", {
        photos,
        stickers: [...stickers, sticker],
        cardImageUrl: photos[0] || ""
      });
      upsertDiary(diary);
      this.setData({
        ...this.getDiaryViewState(diary, sticker.id),
        selectedPhotoIndex: 0,
        selectedPhotoUrl: getPhotoAt(diary, 0),
        customSelectionEnabled: false,
        selectionModeIndex: 0,
        subjectPointStyle: "left: 50%; top: 50%;",
        subjectSelection: { mode: "point", x: 50, y: 50 },
        aiMessage: stylized.message || segmented.message || "贴纸已生成。"
      });
      toast("贴纸已生成", "success");
    } catch (error) {
      this.setData({ aiMessage: error.message });
      toast(error.message);
    } finally {
      this.setData({ processingSticker: false });
    }
  },
  drawCardText(ctx, diary) {
    ctx.setFillStyle("#263447");
    ctx.setFontSize(34);
    ctx.fillText("贴贴日记", 54, 72);
    ctx.setFillStyle("#667789");
    ctx.setFontSize(22);
    ctx.fillText(`${diary.date} · ${diary.mood}`, 54, 108);

    ctx.setFillStyle("#2f6ea3");
    ctx.setFontSize(22);
    const tags = (diary.tags || []).slice(0, 4).map((tag) => `#${tag}`).join(" ");
    if (tags) ctx.fillText(tags, 54, 132);

    ctx.setFillStyle("#263447");
    ctx.setFontSize(28);
    wrapText(this.data.body || diary.body, 18, 7).forEach((line, index) => {
      ctx.fillText(line, 54, 660 + index * 42);
    });
  },
  async drawCardStickers(ctx, diary) {
    const stickers = [...(diary.stickers || [])].sort((a, b) => (a.zIndex || 1) - (b.zIndex || 1));
    if (!stickers.length) {
      const cover = getPhotoAt(diary, 0);
      const coverPath = await this.prepareCanvasImage(cover);
      if (coverPath) ctx.drawImage(coverPath, 92, 176, 516, 344);
      return;
    }

    for (const sticker of stickers) {
      const path = await this.prepareCanvasImage(sticker.fileUrl);
      if (!path) continue;
      const size = 172 * (sticker.scale || 1);
      const x = 90 + ((sticker.x || 50) / 100) * 520;
      const y = 168 + ((sticker.y || 50) / 100) * 380;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((sticker.rotation || 0) * Math.PI) / 180);
      ctx.drawImage(path, -size / 2, -size / 2, size, size);
      ctx.restore();
    }
  },
  async exportCardImage() {
    const diary = this.buildDiary("draft");
    this.setData({ exportingCard: true, aiMessage: "正在生成卡片图片..." });
    try {
      const ctx = wx.createCanvasContext("diaryCardCanvas", this);
      ctx.setFillStyle("#fff8df");
      ctx.fillRect(0, 0, 700, 980);
      ctx.setFillStyle("#fffdf4");
      ctx.fillRect(28, 28, 644, 924);
      ctx.setStrokeStyle("#2f6ea3");
      ctx.setLineWidth(6);
      ctx.strokeRect(28, 28, 644, 924);
      ctx.setFillStyle("#ffffff");
      ctx.fillRect(54, 158, 592, 424);
      ctx.setStrokeStyle("rgba(47, 110, 163, 0.35)");
      ctx.setLineWidth(4);
      ctx.strokeRect(54, 158, 592, 424);

      this.drawCardText(ctx, diary);
      await this.drawCardStickers(ctx, diary);

      const tempFilePath = await new Promise((resolve, reject) => {
        ctx.draw(false, async () => {
          await sleep(80);
          wx.canvasToTempFilePath(
            {
              canvasId: "diaryCardCanvas",
              width: 700,
              height: 980,
              destWidth: 1400,
              destHeight: 1960,
              success: (result) => resolve(result.tempFilePath),
              fail: reject
            },
            this
          );
        });
      });
      this.setData({ cardImagePath: tempFilePath, aiMessage: "卡片图片已生成，可以保存到相册。" });
      toast("已生成", "success");
    } catch (error) {
      this.setData({ aiMessage: error.message || "卡片生成失败" });
      toast("生成失败");
    } finally {
      this.setData({ exportingCard: false });
    }
  },
  saveCardToAlbum() {
    if (!this.data.cardImagePath) {
      toast("请先生成卡片");
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: this.data.cardImagePath,
      success: () => toast("已保存", "success"),
      fail: () => toast("保存失败，请检查相册权限")
    });
  },
  saveDraft() {
    this.save("draft");
  },
  finishDiary() {
    this.save("done");
  },
  save(status) {
    const diary = this.buildDiary(status);
    upsertDiary(diary);
    wx.showToast({ title: status === "done" ? "已完成" : "已保存", icon: "success" });
    wx.switchTab({ url: "/pages/timeline/timeline" });
  }
});

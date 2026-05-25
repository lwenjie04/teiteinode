const { createDiary, listDiaries, todayKey } = require("../../utils/storage");

Page({
  data: {
    today: todayKey(),
    drafts: [],
    latest: null
  },
  onShow() {
    const diaries = listDiaries();
    this.setData({
      drafts: diaries.filter((diary) => diary.status === "draft").slice(0, 2),
      latest: diaries.find((diary) => diary.status === "done") || null
    });
  },
  startBlank() {
    const diary = createDiary();
    wx.navigateTo({ url: `/pages/editor/editor?id=${diary.id}` });
  },
  choosePhoto() {
    wx.chooseMedia({
      count: 6,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: (result) => {
        const photos = result.tempFiles.map((file) => file.tempFilePath);
        const diary = createDiary({ photos });
        wx.navigateTo({ url: `/pages/editor/editor?id=${diary.id}` });
      }
    });
  },
  openDraft(event) {
    wx.navigateTo({ url: `/pages/editor/editor?id=${event.currentTarget.dataset.id}` });
  },
  openTimeline() {
    wx.switchTab({ url: "/pages/timeline/timeline" });
  }
});

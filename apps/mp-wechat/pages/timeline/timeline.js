const { listDiaries, removeDiary } = require("../../utils/storage");

Page({
  data: {
    diaries: []
  },
  onShow() {
    this.setData({ diaries: listDiaries() });
  },
  openDiary(event) {
    wx.navigateTo({ url: `/pages/editor/editor?id=${event.currentTarget.dataset.id}` });
  },
  deleteDiary(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "删除日记",
      content: "确定删除这篇日记吗？",
      success: (result) => {
        if (!result.confirm) return;
        removeDiary(id);
        this.setData({ diaries: listDiaries() });
      }
    });
  }
});

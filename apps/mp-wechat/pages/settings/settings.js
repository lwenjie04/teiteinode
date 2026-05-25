const api = require("../../utils/api");
const {
  defaultDiarySettings,
  listDiaries,
  mergeCloudDiaries,
  saveDiaries,
  toCloudDiary
} = require("../../utils/storage");

function getDefaultSyncSettings() {
  return {
    defaultWritingStyle: defaultDiarySettings.writingStyle,
    defaultDiaryLength: defaultDiarySettings.length,
    defaultBackground: defaultDiarySettings.background
  };
}

function isRemotePhoto(url) {
  if (!url) return true;
  if (url.startsWith("/uploads/") || url.startsWith("data:image/")) return true;
  if (/^https?:\/\/(tmp|usr)\//.test(url)) return false;
  return /^https?:\/\//.test(url);
}

function toCloudSafeDiary(diary) {
  const remotePhotos = (diary.photos || []).filter(isRemotePhoto);
  return toCloudDiary({
    ...diary,
    photos: remotePhotos,
    cardImageUrl: isRemotePhoto(diary.cardImageUrl) ? diary.cardImageUrl : remotePhotos[0] || ""
  });
}

function toast(title, icon = "none") {
  wx.showToast({ title, icon });
}

Page({
  data: {
    apiBase: api.getApiBase(),
    auth: api.getAuth(),
    code: "",
    count: 0,
    devCode: "",
    email: "",
    loggedIn: false,
    message: "",
    syncing: false,
    userEmail: ""
  },
  onShow() {
    this.refreshState();
  },
  refreshState(extra = {}) {
    const auth = api.getAuth();
    this.setData({
      apiBase: api.getApiBase(),
      auth,
      count: listDiaries().length,
      loggedIn: Boolean(auth.token),
      userEmail: auth.user && auth.user.email ? auth.user.email : "",
      ...extra
    });
  },
  onApiBaseInput(event) {
    this.setData({ apiBase: event.detail.value });
  },
  saveApiBase() {
    const apiBase = api.setApiBase(this.data.apiBase);
    this.refreshState({ apiBase, message: "后端地址已保存。" });
    toast("已保存", "success");
  },
  onEmailInput(event) {
    this.setData({ email: event.detail.value.trim() });
  },
  onCodeInput(event) {
    this.setData({ code: event.detail.value.trim() });
  },
  async sendCode() {
    if (!this.data.email) {
      toast("请先输入邮箱");
      return;
    }
    this.setData({ syncing: true, message: "正在发送验证码..." });
    try {
      const result = await api.sendEmailCode(this.data.email);
      this.setData({
        code: result.devCode || this.data.code,
        devCode: result.devCode || "",
        message: result.devCode ? `开发验证码：${result.devCode}` : result.message || "验证码已发送。"
      });
      toast("验证码已发送", "success");
    } catch (error) {
      this.setData({ message: error.message });
      toast(error.message);
    } finally {
      this.setData({ syncing: false });
    }
  },
  async login() {
    if (!this.data.email || !this.data.code) {
      toast("请输入邮箱和验证码");
      return;
    }
    this.setData({ syncing: true, message: "正在登录..." });
    try {
      const auth = await api.verifyEmailCode(this.data.email, this.data.code);
      api.saveAuth(auth);
      this.refreshState({ code: "", devCode: "", message: "账号已登录，可以同步日记了。" });
      toast("已登录", "success");
    } catch (error) {
      this.setData({ message: error.message });
      toast(error.message);
    } finally {
      this.setData({ syncing: false });
    }
  },
  logout() {
    api.clearAuth();
    this.refreshState({ message: "已退出账号。", code: "", devCode: "" });
    toast("已退出", "success");
  },
  async prepareDiariesForSync() {
    const diaries = listDiaries();
    const nextDiaries = [];
    let failedCount = 0;
    let uploadedCount = 0;

    for (const diary of diaries) {
      const photos = [];
      for (const photo of diary.photos || []) {
        if (isRemotePhoto(photo)) {
          photos.push(photo);
          continue;
        }
        try {
          const uploaded = await api.uploadImage(photo);
          photos.push(uploaded.url || uploaded.relativeUrl || photo);
          uploadedCount += 1;
        } catch (error) {
          photos.push(photo);
          failedCount += 1;
        }
      }
      nextDiaries.push({
        ...diary,
        photos,
        cardImageUrl: photos[0] || diary.cardImageUrl || "",
        updatedAt: diary.updatedAt,
        lastModifiedAt: diary.lastModifiedAt || diary.updatedAt
      });
    }

    saveDiaries(nextDiaries);
    return {
      failedCount,
      uploadedCount,
      diaries: listDiaries().map(toCloudSafeDiary)
    };
  },
  ensureLogin() {
    if (api.getAuth().token) return true;
    this.setData({ message: "请先用邮箱验证码登录，再同步日记。" });
    toast("请先登录");
    return false;
  },
  async syncPush() {
    if (!this.ensureLogin()) return;
    this.setData({ syncing: true, message: "正在上传本地日记..." });
    try {
      const prepared = await this.prepareDiariesForSync();
      const result = await api.pushDiaries(prepared.diaries, getDefaultSyncSettings());
      mergeCloudDiaries(result.diaries || []);
      this.refreshState({
        message: `已上传 ${prepared.diaries.length} 篇日记，照片上传 ${prepared.uploadedCount} 张${prepared.failedCount ? `，${prepared.failedCount} 张稍后重试` : ""}。`
      });
      toast("上传完成", "success");
    } catch (error) {
      this.setData({ message: error.message });
      toast(error.message);
    } finally {
      this.setData({ syncing: false });
    }
  },
  async syncPull() {
    if (!this.ensureLogin()) return;
    this.setData({ syncing: true, message: "正在拉取云端日记..." });
    try {
      const result = await api.pullDiaries();
      const merged = mergeCloudDiaries(result.diaries || []);
      this.refreshState({ message: `已拉取云端日记，本地现在 ${merged.length} 篇。` });
      toast("拉取完成", "success");
    } catch (error) {
      this.setData({ message: error.message });
      toast(error.message);
    } finally {
      this.setData({ syncing: false });
    }
  },
  async syncBoth() {
    if (!this.ensureLogin()) return;
    this.setData({ syncing: true, message: "正在双向同步..." });
    try {
      const pulled = await api.pullDiaries();
      mergeCloudDiaries(pulled.diaries || []);
      const prepared = await this.prepareDiariesForSync();
      const pushed = await api.pushDiaries(prepared.diaries, getDefaultSyncSettings());
      const merged = mergeCloudDiaries(pushed.diaries || []);
      this.refreshState({
        message: `双向同步完成：本地 ${merged.length} 篇，照片上传 ${prepared.uploadedCount} 张${prepared.failedCount ? `，${prepared.failedCount} 张稍后重试` : ""}。`
      });
      toast("同步完成", "success");
    } catch (error) {
      this.setData({ message: error.message });
      toast(error.message);
    } finally {
      this.setData({ syncing: false });
    }
  },
  clearLocal() {
    wx.showModal({
      title: "清空本地",
      content: "确定清空小程序本地日记吗？云端数据不会被删除。",
      success: (result) => {
        if (!result.confirm) return;
        wx.removeStorageSync("tietie.diaries");
        this.refreshState({ message: "本地日记已清空。" });
        toast("已清空", "success");
      }
    });
  }
});

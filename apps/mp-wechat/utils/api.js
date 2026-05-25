const apiBaseKey = "tietie.apiBase";
const tokenKey = "tietie.auth.token";
const userKey = "tietie.auth.user";

const defaultApiBase = "http://127.0.0.1:4000/api";

function normalizeApiBase(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  return trimmed || defaultApiBase;
}

function getApiBase() {
  return normalizeApiBase(wx.getStorageSync(apiBaseKey) || defaultApiBase);
}

function setApiBase(value) {
  const next = normalizeApiBase(value);
  wx.setStorageSync(apiBaseKey, next);
  return next;
}

function getAuth() {
  const token = wx.getStorageSync(tokenKey) || "";
  const user = wx.getStorageSync(userKey) || null;
  return { token, user };
}

function saveAuth(auth) {
  wx.setStorageSync(tokenKey, auth.token);
  wx.setStorageSync(userKey, auth.user);
  return getAuth();
}

function clearAuth() {
  wx.removeStorageSync(tokenKey);
  wx.removeStorageSync(userKey);
  return getAuth();
}

function getErrorMessage(response) {
  if (!response) return "网络请求失败";
  const data = response.data || {};
  return data.message || data.error || `请求失败：${response.statusCode}`;
}

function request(path, options = {}) {
  const url = `${getApiBase()}${path}`;
  const token = options.token || getAuth().token;
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: options.method || "GET",
      data: options.data,
      timeout: options.timeout || 12000,
      header: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.header || {})
      },
      success: (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
          return;
        }
        reject(new Error(getErrorMessage(response)));
      },
      fail: (error) => {
        reject(new Error(error.errMsg || "网络请求失败"));
      }
    });
  });
}

function sendEmailCode(email) {
  return request("/auth/email-code/send", {
    method: "POST",
    data: { email }
  });
}

function verifyEmailCode(email, code) {
  return request("/auth/email-code/verify", {
    method: "POST",
    data: { email, code }
  });
}

function pushDiaries(diaries, settings) {
  return request("/sync/push", {
    method: "POST",
    timeout: 18000,
    data: {
      diaries,
      deletedDiaryIds: [],
      settings
    }
  });
}

function pullDiaries() {
  return request("/sync/pull", {
    timeout: 18000
  });
}

function generateDiary(payload) {
  return request("/ai/generate-diary", {
    method: "POST",
    timeout: 18000,
    data: payload
  });
}

function segmentSubject(payload) {
  return request("/ai/segment", {
    method: "POST",
    timeout: 18000,
    data: payload
  });
}

function stylizeSticker(payload) {
  return request("/ai/stylize", {
    method: "POST",
    timeout: 18000,
    data: payload
  });
}

function uploadImage(filePath) {
  const token = getAuth().token;
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getApiBase()}/files/upload`,
      filePath,
      name: "file",
      timeout: 30000,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`图片上传失败：${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(response.data));
        } catch (error) {
          reject(new Error("图片上传响应解析失败"));
        }
      },
      fail: (error) => {
        reject(new Error(error.errMsg || "图片上传失败"));
      }
    });
  });
}

module.exports = {
  clearAuth,
  defaultApiBase,
  getApiBase,
  getAuth,
  generateDiary,
  pullDiaries,
  pushDiaries,
  request,
  saveAuth,
  segmentSubject,
  sendEmailCode,
  setApiBase,
  stylizeSticker,
  uploadImage,
  verifyEmailCode
};

import { defineStore } from "pinia";
import { sendEmailCode, verifyEmailCode } from "../lib/api";

interface User {
  id: string;
  email: string;
}

const tokenKey = "tietie.auth.token";
const userKey = "tietie.auth.user";

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: localStorage.getItem(tokenKey),
    user: JSON.parse(localStorage.getItem(userKey) || "null") as User | null,
    sending: false,
    verifying: false,
    message: "",
    devCode: "",
    codeExpiresAt: 0,
    resendAvailableAt: 0
  }),
  getters: {
    isLoggedIn: (state) => Boolean(state.token && state.user)
  },
  actions: {
    async sendCode(email: string) {
      this.sending = true;
      this.message = "";
      this.devCode = "";
      try {
        const result = await sendEmailCode(email);
        this.devCode = result.devCode ?? "";
        this.codeExpiresAt = Date.now() + result.expiresInSeconds * 1000;
        this.resendAvailableAt = Date.now() + 30 * 1000;
        this.message = result.devCode ? `开发验证码：${result.devCode}` : "验证码已发送，请检查邮箱。";
        return true;
      } catch {
        this.message = "验证码发送失败，请检查网络或稍后再试。";
        return false;
      } finally {
        this.sending = false;
      }
    },
    async verify(email: string, code: string) {
      this.verifying = true;
      this.message = "";
      try {
        const result = await verifyEmailCode(email, code);
        this.token = result.token;
        this.user = result.user;
        localStorage.setItem(tokenKey, result.token);
        localStorage.setItem(userKey, JSON.stringify(result.user));
        this.devCode = "";
        this.codeExpiresAt = 0;
        this.resendAvailableAt = 0;
        this.message = "登录成功，之后可以云端备份。";
        return true;
      } catch {
        this.message = "登录失败，请检查验证码或稍后再试。";
        return false;
      } finally {
        this.verifying = false;
      }
    },
    logout() {
      this.token = null;
      this.user = null;
      this.devCode = "";
      this.codeExpiresAt = 0;
      this.resendAvailableAt = 0;
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(userKey);
      this.message = "已退出登录。";
    }
  }
});

import { defineStore } from "pinia";

type ToastTone = "info" | "success" | "warning";

export const useUiStore = defineStore("ui", {
  state: () => ({
    toast: "",
    tone: "info" as ToastTone,
    timer: 0
  }),
  actions: {
    showToast(message: string, tone: ToastTone = "info") {
      this.toast = message;
      this.tone = tone;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.toast = "";
      }, 2600);
    }
  }
});

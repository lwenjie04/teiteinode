import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { useDiaryStore } from "./stores/diaryStore";
import { useSettingsStore } from "./stores/settingsStore";
import "./styles.css";

const pinia = createPinia();
const app = createApp(App).use(pinia).use(router);
const settingsStore = useSettingsStore(pinia);
const diaryStore = useDiaryStore(pinia);

app.mount("#app");

Promise.all([settingsStore.hydrate(), diaryStore.hydrate()]).catch(() => undefined);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

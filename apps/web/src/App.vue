<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "./stores/authStore";
import { useDiaryStore } from "./stores/diaryStore";
import { useUiStore } from "./stores/uiStore";

const route = useRoute();
const router = useRouter();
const ui = useUiStore();
const auth = useAuthStore();
const store = useDiaryStore();
const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
const autoSyncDelayMs = 2600;
const autoSyncRetryDelayMs = 18000;
let autoSyncTimer = 0;

const bannerText = computed(() => {
  if (!online.value) return "离线模式：日记会先保存到这台设备，网络恢复后再同步。";
  if (store.syncing) return "正在同步云端备份。";
  if (store.pendingSyncCount > 0) return `还有 ${store.pendingSyncCount} 项改动等待同步。`;
  return "";
});

const canManualSync = computed(() => online.value && auth.isLoggedIn && store.pendingSyncCount > 0 && !store.syncing);
const canAutoSync = computed(() => canManualSync.value && Boolean(auth.token));

const tabs = [
  { name: "记录", path: "/", icon: "记" },
  { name: "时间线", path: "/timeline", icon: "线" },
  { name: "日历", path: "/calendar", icon: "月" },
  { name: "心情", path: "/moods", icon: "心" },
  { name: "设置", path: "/settings", icon: "设" }
];

function clearAutoSyncTimer() {
  if (!autoSyncTimer) return;
  window.clearTimeout(autoSyncTimer);
  autoSyncTimer = 0;
}

function scheduleAutoSync(delayMs = autoSyncDelayMs) {
  clearAutoSyncTimer();
  if (!canAutoSync.value) return;
  autoSyncTimer = window.setTimeout(runAutoSync, delayMs);
}

async function runAutoSync() {
  autoSyncTimer = 0;
  if (!canAutoSync.value) return;
  const ok = await syncNow(true);
  if (!ok && canAutoSync.value) scheduleAutoSync(autoSyncRetryDelayMs);
}

async function syncNow(silent = false) {
  clearAutoSyncTimer();
  if (!auth.token || store.syncing) return false;
  try {
    await store.syncWithCloud(auth.token);
    if (silent) return true;
    ui.showToast("云同步完成", "success");
  } catch {
    if (silent) {
      store.syncState = "同步失败";
      return false;
    }
    store.syncState = "同步失败";
    ui.showToast("同步失败，稍后会再试", "warning");
  }
}

async function manualSync() {
  await syncNow(false);
}

async function handleOnline() {
  online.value = true;
  ui.showToast("网络已恢复", "success");
  scheduleAutoSync(500);
}

function handleOffline() {
  online.value = false;
  ui.showToast("已进入离线模式", "info");
}

onMounted(async () => {
  await store.refreshPendingSyncCount();
  scheduleAutoSync();
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
});

onUnmounted(() => {
  clearAutoSyncTimer();
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
});

watch([() => store.pendingSyncCount, () => auth.token, () => online.value, () => store.syncing], () => {
  scheduleAutoSync();
});
</script>

<template>
  <div class="app-shell">
    <main class="page-frame">
      <div v-if="bannerText" class="connection-banner" :class="{ offline: !online }">
        <span>{{ bannerText }}</span>
        <button v-if="canManualSync" type="button" @click="manualSync">同步</button>
      </div>
      <RouterView />
    </main>

    <div v-if="ui.toast" class="toast" :class="ui.tone" role="status">
      {{ ui.toast }}
    </div>

    <nav class="tab-bar" aria-label="主导航">
      <button
        v-for="tab in tabs"
        :key="tab.path"
        class="tab-button"
        :class="{ active: route.path === tab.path }"
        type="button"
        @click="router.push(tab.path)"
      >
        <span class="tab-icon">{{ tab.icon }}</span>
        <span>{{ tab.name }}</span>
      </button>
    </nav>
  </div>
</template>

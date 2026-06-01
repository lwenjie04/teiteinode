<script setup lang="ts">
import { moods } from "@tietie/shared";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatLocalDateKey } from "../lib/dateTools";
import { useDiaryStore } from "../stores/diaryStore";
import { useUiStore } from "../stores/uiStore";

type StatusFilter = "all" | "draft" | "done";

const store = useDiaryStore();
const ui = useUiStore();
const router = useRouter();
const route = useRoute();

const query = ref(readQueryText(route.query.q));
const statusFilter = ref<StatusFilter>(readStatus(route.query.status));
const moodFilter = ref(readQueryText(route.query.mood));
const dateFilter = ref(readQueryText(route.query.date));
const todayKey = formatLocalDateKey();
const monthKey = todayKey.slice(0, 7);

function readQueryText(value: unknown) {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

function readStatus(value: unknown): StatusFilter {
  const status = readQueryText(value);
  return status === "draft" || status === "done" ? status : "all";
}

function sameQueryValue(a: unknown, b: string | undefined) {
  return readQueryText(a) === (b ?? "");
}

watch(
  () => route.query,
  (params) => {
    query.value = readQueryText(params.q);
    statusFilter.value = readStatus(params.status);
    moodFilter.value = readQueryText(params.mood);
    dateFilter.value = readQueryText(params.date);
  }
);

watch([query, statusFilter, moodFilter, dateFilter], ([nextQuery, nextStatus, nextMood, nextDate]) => {
  const nextParams = {
    q: nextQuery.trim() || undefined,
    status: nextStatus === "all" ? undefined : nextStatus,
    mood: nextMood || undefined,
    date: nextDate || undefined
  };

  if (
    sameQueryValue(route.query.q, nextParams.q) &&
    sameQueryValue(route.query.status, nextParams.status) &&
    sameQueryValue(route.query.mood, nextParams.mood) &&
    sameQueryValue(route.query.date, nextParams.date)
  ) {
    return;
  }

  router.replace({ path: "/timeline", query: nextParams });
});

const hasActiveFilters = computed(() => Boolean(query.value.trim() || statusFilter.value !== "all" || moodFilter.value || dateFilter.value));
const restoringDeleted = ref(false);
const brokenCardImageIds = ref(new Set<string>());
const doneCount = computed(() => store.doneDiaries.length);
const draftCount = computed(() => store.drafts.length);
const todayCount = computed(() => store.diaries.filter((diary) => diary.date === todayKey).length);
const monthCount = computed(() => store.diaries.filter((diary) => diary.date.startsWith(monthKey)).length);
const filterLabel = computed(() => {
  if (!hasActiveFilters.value) return `${filteredDiaries.value.length} 篇日记`;
  return `已筛出 ${filteredDiaries.value.length} 篇`;
});

const filteredDiaries = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return store.diaries.filter((diary) => {
    if (statusFilter.value !== "all" && diary.status !== statusFilter.value) return false;
    if (moodFilter.value && diary.mood !== moodFilter.value) return false;
    if (dateFilter.value && diary.date !== dateFilter.value) return false;
    if (!keyword) return true;
    const haystack = [diary.date, diary.location ?? "", diary.mood, diary.body, diary.tags.join(" "), diary.writingStyle, diary.background].join(" ").toLowerCase();
    return haystack.includes(keyword);
  });
});

function resetFilters() {
  query.value = "";
  statusFilter.value = "all";
  moodFilter.value = "";
  dateFilter.value = "";
}

function setStatusFilter(status: StatusFilter) {
  statusFilter.value = status;
}

function openDiary(id: string, edit = false) {
  router.push(edit ? `/diaries/${id}/edit` : `/diaries/${id}`);
}

function isVolatileImageUrl(url?: string) {
  return Boolean(url?.startsWith("blob:"));
}

function cardImageNeedsRepair(diary: { id: string; cardImageUrl?: string }) {
  return Boolean(diary.cardImageUrl && (brokenCardImageIds.value.has(diary.id) || isVolatileImageUrl(diary.cardImageUrl)));
}

function markCardImageLoaded(id: string) {
  if (!brokenCardImageIds.value.has(id)) return;
  const next = new Set(brokenCardImageIds.value);
  next.delete(id);
  brokenCardImageIds.value = next;
}

function markCardImageFailed(id: string) {
  const next = new Set(brokenCardImageIds.value);
  next.add(id);
  brokenCardImageIds.value = next;
}

function openCardImageRepair(id: string) {
  router.push({
    path: `/diaries/${id}/edit`,
    query: {
      repair: "card",
      issue: `${id}:card`
    }
  });
}

async function deleteDiary(id: string) {
  const confirmed = window.confirm("确定删除这篇日记吗？删除后会在下次同步时从云端移除。");
  if (!confirmed) return;
  await store.removeDiary(id);
  ui.showToast("日记已删除，可以在时间线撤销", "warning");
}

async function undoDelete() {
  if (restoringDeleted.value) return;
  restoringDeleted.value = true;
  try {
    const restored = await store.restoreLastDeletedDiary();
    if (restored) {
      ui.showToast("已恢复日记", "success");
      router.push(`/diaries/${restored.id}`);
    }
  } finally {
    restoringDeleted.value = false;
  }
}
</script>

<template>
  <section class="timeline-page">
    <div class="page-title timeline-title-row">
      <div>
        <p class="eyebrow">Timeline</p>
        <h1>时间线</h1>
        <p class="timeline-subtitle">本月 {{ monthCount }} 篇 · 今天 {{ todayCount }} 篇</p>
      </div>
    </div>

    <section class="timeline-summary">
      <button type="button" :class="{ active: statusFilter === 'all' }" @click="setStatusFilter('all')">
        <span>全部</span>
        <strong>{{ store.diaries.length }}</strong>
      </button>
      <button type="button" :class="{ active: statusFilter === 'done' }" @click="setStatusFilter('done')">
        <span>完成</span>
        <strong>{{ doneCount }}</strong>
      </button>
      <button type="button" :class="{ active: statusFilter === 'draft' }" @click="setStatusFilter('draft')">
        <span>草稿</span>
        <strong>{{ draftCount }}</strong>
      </button>
      <button type="button" @click="dateFilter = todayKey">
        <span>今天</span>
        <strong>{{ todayCount }}</strong>
      </button>
    </section>

    <details class="section-block compact-block timeline-filter" :open="hasActiveFilters">
      <summary>
        <strong>搜索和筛选</strong>
        <span>{{ filterLabel }}</span>
      </summary>
      <div class="filter-grid">
        <label>
          搜索日记
          <input v-model="query" type="search" placeholder="搜索文字、地点、标签或背景" />
        </label>
        <label>
          指定日期
          <input v-model="dateFilter" type="date" />
        </label>
        <label>
          心情
          <select v-model="moodFilter">
            <option value="">全部心情</option>
            <option v-for="mood in moods" :key="mood" :value="mood">{{ mood }}</option>
          </select>
        </label>
      </div>

      <div class="segmented three">
        <button type="button" :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
        <button type="button" :class="{ active: statusFilter === 'done' }" @click="statusFilter = 'done'">已完成</button>
        <button type="button" :class="{ active: statusFilter === 'draft' }" @click="statusFilter = 'draft'">草稿</button>
      </div>

      <div v-if="hasActiveFilters" class="active-filter-row">
        <span v-if="query.trim()">关键词：{{ query.trim() }}</span>
        <span v-if="dateFilter">日期：{{ dateFilter }}</span>
        <span v-if="moodFilter">心情：{{ moodFilter }}</span>
        <span v-if="statusFilter !== 'all'">状态：{{ statusFilter === "draft" ? "草稿" : "已完成" }}</span>
        <button type="button" @click="resetFilters">清空</button>
      </div>
    </details>

    <article v-if="store.lastDeletedDiary" class="undo-strip">
      <div>
        <strong>刚刚删除了 {{ store.lastDeletedDiary.date }} 的日记</strong>
        <span>{{ store.lastDeletedDiary.body || "这是一篇草稿。" }}</span>
      </div>
      <button class="secondary-action compact-action" type="button" :disabled="restoringDeleted" @click="undoDelete">
        {{ restoringDeleted ? "恢复中" : "撤销删除" }}
      </button>
    </article>

    <div class="timeline-list">
      <article v-for="diary in filteredDiaries" :key="diary.id" class="diary-row" @click="openDiary(diary.id, diary.status === 'draft')">
        <div class="diary-thumb" :class="[diary.status, { broken: cardImageNeedsRepair(diary) }]">
          <img v-if="diary.cardImageUrl && !brokenCardImageIds.has(diary.id)" :src="diary.cardImageUrl" :alt="`${diary.date} 预览图`" @load="markCardImageLoaded(diary.id)" @error="markCardImageFailed(diary.id)" />
          <span v-else class="thumb-fallback">{{ diary.mood }}</span>
          <strong v-if="cardImageNeedsRepair(diary)" class="thumb-warning-badge">{{ brokenCardImageIds.has(diary.id) ? "失效" : "临时" }}</strong>
        </div>
        <div>
          <div class="row-meta">
            <strong>{{ diary.date }}</strong>
            <span>{{ diary.status === "draft" ? "草稿" : diary.mood }}</span>
          </div>
          <p>{{ diary.body || "还没写完的小日记" }}</p>
          <div class="row-footer">
            <div class="tag-line">
              <span v-if="diary.location">{{ diary.location }}</span>
              <span v-for="tag in diary.tags" :key="tag">#{{ tag }}</span>
            </div>
            <details class="row-menu" @click.stop>
              <summary aria-label="更多操作">•••</summary>
              <div class="row-menu-panel">
                <button v-if="cardImageNeedsRepair(diary)" class="secondary-action compact-action" type="button" @click="openCardImageRepair(diary.id)">修复封面</button>
                <button v-if="diary.status === 'draft'" class="secondary-action compact-action" type="button" @click="openDiary(diary.id, true)">继续写</button>
                <button class="text-danger" type="button" @click="deleteDiary(diary.id)">删除</button>
              </div>
            </details>
          </div>
        </div>
      </article>

      <article v-if="!filteredDiaries.length" class="empty-list">
        <strong>没有找到日记</strong>
        <span>换个关键词，或者清空筛选再看看。</span>
      </article>
    </div>
  </section>
</template>

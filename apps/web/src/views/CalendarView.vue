<script setup lang="ts">
import type { Diary } from "@tietie/shared";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { formatLocalDateKey, formatLocalMonthKey } from "../lib/dateTools";
import { useDiaryStore } from "../stores/diaryStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

const store = useDiaryStore();
const settings = useSettingsStore();
const ui = useUiStore();
const router = useRouter();
const monthCursor = ref(startOfMonth(new Date()));
const creatingDate = ref("");
const todayKey = formatLocalDateKey();
const weekDays = ["一", "二", "三", "四", "五", "六", "日"];

interface CalendarDay {
  key: string;
  dateKey: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  diaries: Diary[];
  latest?: Diary;
  moods: string[];
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function changeMonth(offset: number) {
  monthCursor.value = new Date(monthCursor.value.getFullYear(), monthCursor.value.getMonth() + offset, 1);
}

function goToday() {
  monthCursor.value = startOfMonth(new Date());
}

function diaryNeedsEditing(diary: Diary) {
  return diary.status !== "done";
}

async function openOrCreateDiary(day: CalendarDay) {
  if (day.diaries.length > 1) {
    router.push({ path: "/timeline", query: { date: day.dateKey } });
    return;
  }
  if (day.latest) {
    router.push(diaryNeedsEditing(day.latest) ? `/diaries/${day.latest.id}/edit` : `/diaries/${day.latest.id}`);
    return;
  }
  if (creatingDate.value) return;
  creatingDate.value = day.dateKey;
  try {
    const draft = await store.createDraft({
      date: day.dateKey,
      writingStyle: settings.values.defaultWritingStyle,
      length: settings.values.defaultDiaryLength,
      background: settings.values.defaultBackground
    });
    ui.showToast(`已创建 ${day.dateKey} 的补记草稿`, "success");
    router.push(`/diaries/${draft.id}/edit`);
  } finally {
    creatingDate.value = "";
  }
}

function openDiary(diary: Diary) {
  router.push(diaryNeedsEditing(diary) ? `/diaries/${diary.id}/edit` : `/diaries/${diary.id}`);
}

function diaryHasPendingSync(id: string) {
  return pendingSyncDiaryIds.value.has(id);
}

function diaryStatusLabel(status: Diary["status"]) {
  const labels: Record<Diary["status"], string> = {
    draft: "草稿",
    processing: "处理中",
    done: "已完成",
    syncing: "同步中",
    sync_failed: "同步失败"
  };
  return labels[status];
}

const diariesByDate = computed(() => {
  const grouped = new Map<string, Diary[]>();
  for (const diary of store.diaries) {
    const list = grouped.get(diary.date) ?? [];
    list.push(diary);
    grouped.set(diary.date, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  }
  return grouped;
});

const currentMonthKey = computed(() => formatLocalMonthKey(monthCursor.value));

const monthLabel = computed(() =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long"
  }).format(monthCursor.value)
);

const calendarDays = computed<CalendarDay[]>(() => {
  const first = startOfMonth(monthCursor.value);
  const mondayFirstOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - mondayFirstOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const dateKey = formatLocalDateKey(date);
    const diaries = diariesByDate.value.get(dateKey) ?? [];
    const moods = [...new Set(diaries.map((diary) => diary.mood))].slice(0, 4);
    return {
      key: `${dateKey}-${index}`,
      dateKey,
      day: date.getDate(),
      inMonth: date.getMonth() === monthCursor.value.getMonth(),
      isToday: dateKey === todayKey,
      diaries,
      latest: diaries[0],
      moods
    };
  });
});

const currentMonthDiaries = computed(() =>
  store.diaries
    .filter((diary) => diary.date.startsWith(currentMonthKey.value))
    .sort((a, b) => (a.date === b.date ? b.lastModifiedAt.localeCompare(a.lastModifiedAt) : b.date.localeCompare(a.date)))
);

const doneCount = computed(() => currentMonthDiaries.value.filter((diary) => diary.status === "done").length);
const draftCount = computed(() => currentMonthDiaries.value.filter((diary) => diary.status === "draft").length);
const pendingSyncDiaryIds = computed(() => {
  const ids = new Set<string>();
  for (const item of store.syncQueueItems) {
    if (!item.type.startsWith("diary:")) continue;
    const payload = item.payload;
    if (!payload || typeof payload !== "object") continue;
    const id = (payload as { id?: unknown }).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
});

const topMood = computed(() => {
  const counts = new Map<string, number>();
  for (const diary of currentMonthDiaries.value) {
    counts.set(diary.mood, (counts.get(diary.mood) ?? 0) + 1);
  }
  const [winner] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return winner ? `${winner[0]} ${winner[1]} 篇` : "还没有记录";
});
</script>

<template>
  <section class="calendar-page">
    <div class="page-title calendar-title-row">
      <div>
        <p class="eyebrow">Calendar</p>
        <h1>手账月历</h1>
      </div>
      <button class="secondary-action calendar-today-button" type="button" @click="goToday">今天</button>
    </div>

    <section class="section-block compact-block calendar-summary">
      <article>
        <span>本月记录</span>
        <strong>{{ currentMonthDiaries.length }}</strong>
      </article>
      <article>
        <span>已完成</span>
        <strong>{{ doneCount }}</strong>
      </article>
      <article>
        <span>草稿</span>
        <strong>{{ draftCount }}</strong>
      </article>
      <article>
        <span>高频心情</span>
        <strong>{{ topMood }}</strong>
      </article>
    </section>

    <div class="calendar-toolbar" aria-label="切换月份">
      <button type="button" aria-label="上个月" @click="changeMonth(-1)">‹</button>
      <strong>{{ monthLabel }}</strong>
      <button type="button" aria-label="下个月" @click="changeMonth(1)">›</button>
    </div>

    <div class="calendar-weekdays">
      <span v-for="day in weekDays" :key="day">{{ day }}</span>
    </div>

    <div class="calendar-grid">
      <button
        v-for="day in calendarDays"
        :key="day.key"
        class="calendar-day"
        :class="{ 'other-month': !day.inMonth, today: day.isToday, 'has-diary': day.diaries.length }"
        type="button"
        :aria-label="day.diaries.length ? `${day.dateKey}，${day.diaries.length} 篇日记` : `为 ${day.dateKey} 创建补记草稿`"
        :disabled="creatingDate === day.dateKey"
        @click="openOrCreateDiary(day)"
      >
        <span class="day-number">{{ day.day }}</span>
        <span v-if="day.latest" class="day-sticker">{{ day.latest.mood }}</span>
        <span v-else-if="day.inMonth" class="day-create-hint">补记</span>
        <span v-if="day.diaries.length > 1" class="day-count">{{ day.diaries.length }} 篇</span>
        <span v-if="day.moods.length" class="day-moods" aria-hidden="true">
          <span v-for="mood in day.moods" :key="mood" class="day-dot">{{ mood.slice(0, 1) }}</span>
        </span>
      </button>
    </div>

    <section class="section-block compact-block month-diary-list">
      <div class="section-heading">
        <h2>本月日记</h2>
        <span>{{ monthLabel }}</span>
      </div>

      <div class="timeline-list">
        <article v-for="diary in currentMonthDiaries" :key="diary.id" class="diary-row" @click="openDiary(diary)">
          <div class="diary-thumb" :class="diary.status">
            <span>{{ diary.mood }}</span>
          </div>
          <div>
            <div class="row-meta">
              <strong>{{ diary.date }}</strong>
              <span>{{ diaryStatusLabel(diary.status) }}</span>
              <span v-if="diaryHasPendingSync(diary.id)">待同步</span>
            </div>
            <p>{{ diary.body || "还没有写完的小日记" }}</p>
            <div class="tag-line">
              <span v-for="tag in diary.tags" :key="tag">#{{ tag }}</span>
            </div>
          </div>
        </article>

        <article v-if="!currentMonthDiaries.length" class="empty-list">
          <strong>这个月还没有贴贴</strong>
          <span>回到记录页拍一张照片，月历会自动亮起来。</span>
        </article>
      </div>
    </section>
  </section>
</template>

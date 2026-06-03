<script setup lang="ts">
import { moods } from "@tietie/shared";
import type { Diary, Mood } from "@tietie/shared";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useDiaryStore } from "../stores/diaryStore";

const store = useDiaryStore();
const router = useRouter();
const view = ref<"grid" | "chart" | "line" | "wall">("grid");
const tabs = [
  { id: "grid", label: "宫格" },
  { id: "chart", label: "统计" },
  { id: "line", label: "时间轴" },
  { id: "wall", label: "贴纸墙" }
] as const;

const moodCounts = computed(() =>
  moods.map((mood) => {
    const diaries = store.diaries.filter((diary) => diary.mood === mood);
    return {
      mood,
      count: diaries.length,
      latest: diaries[0],
      percent: store.diaries.length ? Math.round((diaries.length / store.diaries.length) * 100) : 0
    };
  })
);

const maxMoodCount = computed(() => Math.max(...moodCounts.value.map((item) => item.count), 1));
const moodTimelineDiaries = computed(() =>
  [...store.diaries].sort((a, b) => (a.date === b.date ? b.lastModifiedAt.localeCompare(a.lastModifiedAt) : b.date.localeCompare(a.date)))
);
const wallDiaries = computed(() => store.diaries.filter((diary) => diary.cardImageUrl || diary.stickers.length).slice(0, 18));

function openMood(mood: Mood) {
  router.push({ path: "/timeline", query: { mood } });
}

function diaryNeedsEditing(diary: Diary) {
  return diary.status !== "done";
}

function openDiary(diary: Diary) {
  router.push(diaryNeedsEditing(diary) ? `/diaries/${diary.id}/edit` : `/diaries/${diary.id}`);
}
</script>

<template>
  <section class="moods-page">
    <div class="page-title">
      <p class="eyebrow">Mood</p>
      <h1>心情</h1>
    </div>

    <div class="segmented">
      <button v-for="tab in tabs" :key="tab.id" :class="{ active: view === tab.id }" type="button" @click="view = tab.id">
        {{ tab.label }}
      </button>
    </div>

    <div v-if="view === 'grid'" class="mood-grid">
      <button v-for="item in moodCounts" :key="item.mood" class="mood-card" type="button" @click="openMood(item.mood)">
        <strong>{{ item.mood }}</strong>
        <span>{{ item.count }} 篇 · {{ item.percent }}%</span>
        <small v-if="item.latest">最近 {{ item.latest.date }}</small>
        <small v-else>还没有记录</small>
      </button>
    </div>

    <div v-else-if="view === 'chart'" class="chart-list">
      <button v-for="item in moodCounts" :key="item.mood" class="chart-row" type="button" @click="openMood(item.mood)">
        <span>{{ item.mood }}</span>
        <span class="chart-track"><i :style="{ width: `${Math.max((item.count / maxMoodCount) * 100, item.count ? 12 : 4)}%` }" /></span>
        <b>{{ item.count }}</b>
      </button>
    </div>

    <div v-else-if="view === 'line'" class="mood-line">
      <article v-for="diary in moodTimelineDiaries" :key="diary.id" class="mood-line-item" @click="openDiary(diary)">
        <span>{{ diary.date }}</span>
        <strong>{{ diary.mood }}</strong>
      </article>
      <article v-if="!store.diaries.length" class="empty-list">
        <strong>还没有心情记录</strong>
        <span>贴一篇小日记后，这里会自动长出你的心情时间轴。</span>
        <button class="primary-action compact-action" type="button" @click="router.push('/create')">开始贴一篇</button>
      </article>
    </div>

    <div v-else class="sticker-wall">
      <button v-for="diary in wallDiaries" :key="diary.id" class="mood-sticker-card" type="button" @click="openDiary(diary)">
        <img v-if="diary.cardImageUrl" :src="diary.cardImageUrl" alt="" />
        <img v-else-if="diary.stickers[0]" :src="diary.stickers[0].fileUrl" alt="" />
        <strong>{{ diary.mood }}</strong>
        <span>{{ diary.date }}</span>
      </button>
      <article v-if="!wallDiaries.length" class="empty-list">
        <strong>还没有贴纸墙</strong>
        <span>完成一篇带贴纸的小日记后，这里会自动收集你的心情卡片。</span>
        <button class="primary-action compact-action" type="button" @click="router.push('/create')">开始贴一篇</button>
      </article>
    </div>
  </section>
</template>

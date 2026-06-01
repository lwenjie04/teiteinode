<script setup lang="ts">
import { moods } from "@tietie/shared";
import type { Mood } from "@tietie/shared";
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

function openMood(mood: Mood) {
  router.push({ path: "/timeline", query: { mood } });
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
      <article v-for="diary in store.diaries" :key="diary.id" class="mood-line-item" @click="router.push(`/diaries/${diary.id}`)">
        <span>{{ diary.date }}</span>
        <strong>{{ diary.mood }}</strong>
      </article>
    </div>

    <div v-else class="sticker-wall">
      <button v-for="item in moodCounts" :key="item.mood" type="button" @click="openMood(item.mood)">
        <strong>{{ item.mood }}</strong>
        <span>{{ item.count }}</span>
      </button>
    </div>
  </section>
</template>

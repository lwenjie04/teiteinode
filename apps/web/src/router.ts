import { createRouter, createWebHistory } from "vue-router";
import CalendarView from "./views/CalendarView.vue";
import CreateView from "./views/CreateView.vue";
import DiaryDetailView from "./views/DiaryDetailView.vue";
import DiaryEditorView from "./views/DiaryEditorView.vue";
import MoodsView from "./views/MoodsView.vue";
import SettingsView from "./views/SettingsView.vue";
import TimelineView from "./views/TimelineView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: CreateView },
    { path: "/timeline", component: TimelineView },
    { path: "/calendar", component: CalendarView },
    { path: "/moods", component: MoodsView },
    { path: "/settings", component: SettingsView },
    { path: "/diaries/:id", component: DiaryDetailView },
    { path: "/diaries/:id/edit", component: DiaryEditorView }
  ]
});

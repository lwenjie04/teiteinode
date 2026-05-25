import { backgrounds, diaryLengths, writingStyles } from "@tietie/shared";
import type { Background, DiaryLength, UserSettings, WritingStyle } from "@tietie/shared";
import { defineStore } from "pinia";
import { enqueueSync, loadSettingsLocal, saveSettingsLocal } from "../lib/localDb";

export const defaultUserSettings: UserSettings = {
  defaultWritingStyle: "可爱活泼",
  defaultDiaryLength: "一小段",
  defaultBackground: "横线纸"
};

function normalizeSettings(input: Partial<UserSettings> | undefined): UserSettings {
  return {
    defaultWritingStyle: writingStyles.includes(input?.defaultWritingStyle as WritingStyle) ? (input?.defaultWritingStyle as WritingStyle) : defaultUserSettings.defaultWritingStyle,
    defaultDiaryLength: diaryLengths.includes(input?.defaultDiaryLength as DiaryLength) ? (input?.defaultDiaryLength as DiaryLength) : defaultUserSettings.defaultDiaryLength,
    defaultBackground: backgrounds.includes(input?.defaultBackground as Background) ? (input?.defaultBackground as Background) : defaultUserSettings.defaultBackground
  };
}

export const useSettingsStore = defineStore("settings", {
  state: () => ({
    values: defaultUserSettings,
    hydrated: false
  }),
  actions: {
    async hydrate() {
      if (this.hydrated) return;
      const stored = await loadSettingsLocal();
      this.values = normalizeSettings(stored);
      await saveSettingsLocal(this.values);
      this.hydrated = true;
    },
    async applySettings(settings: Partial<UserSettings>) {
      this.values = normalizeSettings(settings);
      await saveSettingsLocal(this.values);
      return this.values;
    },
    async updateSettings(patch: Partial<UserSettings>, queue = true) {
      this.values = normalizeSettings({
        ...this.values,
        ...patch
      });
      await saveSettingsLocal(this.values);
      if (queue) {
        await enqueueSync({
          id: crypto.randomUUID(),
          type: "settings:update",
          payload: this.values
        });
      }
      return this.values;
    },
    async resetSettings(queue = true) {
      this.values = defaultUserSettings;
      await saveSettingsLocal(this.values);
      if (queue) {
        await enqueueSync({
          id: crypto.randomUUID(),
          type: "settings:update",
          payload: this.values
        });
      }
      return this.values;
    }
  }
});

export const moods = [
  "开心",
  "平静",
  "疲惫",
  "感动",
  "焦虑",
  "期待",
  "治愈",
  "生气",
  "孤独",
  "松弛"
] as const;

export const defaultTags = [
  "美食",
  "旅行",
  "朋友",
  "家人",
  "工作",
  "学习",
  "购物",
  "运动",
  "宠物",
  "风景",
  "节日",
  "自我照顾"
] as const;

export const writingStyles = ["可爱活泼", "文艺感", "吐槽幽默"] as const;
export const diaryLengths = ["一句话", "一小段", "两三段"] as const;
export const backgrounds = ["牛皮纸", "横线纸", "拍立得", "柔和纯色", "透明"] as const;
export const stickerVariants = ["白边原图贴纸", "旅行插画风", "像素风格", "线条手绘风", "可爱漫画风", "复古邮票风"] as const;

export type Mood = (typeof moods)[number];
export type DefaultTag = (typeof defaultTags)[number];
export type WritingStyle = (typeof writingStyles)[number];
export type DiaryLength = (typeof diaryLengths)[number];
export type Background = (typeof backgrounds)[number];
export type StickerVariant = (typeof stickerVariants)[number];

export type DiaryStatus = "draft" | "processing" | "done" | "syncing" | "sync_failed";
export type StickerStatus = "ready" | "selecting" | "processing" | "failed";
export type SubjectSelectionMode = "point" | "box";

export interface PointSelection {
  mode: "point";
  x: number;
  y: number;
}

export interface BoxSelection {
  mode: "box";
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SubjectSelection = PointSelection | BoxSelection;

export interface StickerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  zIndex: number;
}

export interface Sticker extends StickerTransform {
  id: string;
  diaryId: string;
  sourcePhotoId?: string;
  fileUrl: string;
  sourceImageUrl?: string;
  originalFileUrl?: string;
  variant: StickerVariant;
  status: StickerStatus;
  selection?: SubjectSelection;
  errorMessage?: string;
}

export type DecorationKind = "text" | "emoji" | "tape" | "label" | "bubble";

export interface Decoration extends StickerTransform {
  id: string;
  diaryId: string;
  kind: DecorationKind;
  text: string;
  color: string;
}

export interface DoodleStroke {
  id: string;
  color: string;
  size: number;
  points: Array<{
    x: number;
    y: number;
  }>;
}

export interface Diary {
  id: string;
  localId: string;
  status: DiaryStatus;
  body: string;
  date: string;
  location?: string;
  mood: Mood;
  tags: string[];
  writingStyle: WritingStyle;
  length: DiaryLength;
  background: Background;
  cardImageUrl?: string;
  cardImageSignature?: string;
  stickers: Sticker[];
  decorations?: Decoration[];
  doodles?: DoodleStroke[];
  lastModifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSettings {
  defaultWritingStyle: WritingStyle;
  defaultDiaryLength: DiaryLength;
  defaultBackground: Background;
}

export interface AiStatus {
  available: boolean;
  providerConfigured: boolean;
  message: string;
}

export interface SegmentRequest {
  imageUrl: string;
  selection: SubjectSelection;
}

export interface SegmentResponse {
  status: "completed" | "queued";
  stickerUrl: string;
  message: string;
}

export interface StylizeRequest {
  imageUrl: string;
  variant: StickerVariant;
  selection?: SubjectSelection;
}

export interface StylizeResponse {
  status: "completed" | "queued";
  stickerUrl: string;
  variant: StickerVariant;
  message: string;
}

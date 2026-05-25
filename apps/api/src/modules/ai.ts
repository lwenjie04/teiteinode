import type { StickerVariant } from "@tietie/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";

const selectionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("point"),
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100)
  }),
  z.object({
    mode: z.literal("box"),
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100)
  })
]);

const segmentSchema = z.object({
  imageUrl: z.string().min(1),
  selection: selectionSchema
});

const stylizeSchema = z.object({
  imageUrl: z.string().min(1),
  variant: z.enum(["原始抠图", "白边贴纸", "可爱漫画版", "手绘插画版", "黑白线稿版"])
});

const generateDiarySchema = z.object({
  prompt: z.string().optional(),
  location: z.string().optional(),
  mood: z.string().optional(),
  writingStyle: z.string().optional(),
  length: z.string().optional(),
  tags: z.array(z.string()).optional(),
  stickerCount: z.number().optional()
});

function buildDiaryText(input: z.infer<typeof generateDiarySchema>) {
  const place = input.location?.trim() || "今天";
  const hint = input.prompt?.trim() || "这个小片刻";
  const mood = input.mood || "心情";
  const tags = input.tags?.length ? `#${input.tags.slice(0, 3).join(" #")}` : "";
  const stickerLine = input.stickerCount ? `这页里贴了 ${input.stickerCount} 个小画面，` : "";

  const styleMap: Record<string, string[]> = {
    可爱活泼: [
      `${place}的${mood}被我认真贴进了这一页。${hint}，像给普通日子加了一点甜甜的能量。`,
      `${stickerLine}越看越觉得今天没有白过。${tags}`.trim()
    ],
    文艺感: [
      `${place}留下了一个很小却清楚的瞬间。${hint}，像纸页边缘的一点光，把今天温柔地固定下来。`,
      `${stickerLine}等以后再翻到这里，应该还能想起当时的空气和心跳。${tags}`.trim()
    ],
    吐槽幽默: [
      `${place}这一天本来平平无奇，结果${hint}成功抢镜。钱包和理智先不评价，快乐已经盖章通过。`,
      `${stickerLine}总之今天的我也算认真生活了一下。${tags}`.trim()
    ]
  };

  const lines = styleMap[input.writingStyle || ""] ?? styleMap["可爱活泼"];
  if (input.length === "一句话") return lines[0];
  if (input.length === "两三段") return `${lines[0]}\n\n${lines[1]}`;
  return lines.join("");
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/status", async () => ({
    available: Boolean(config.AI_PROVIDER && config.AI_API_KEY),
    providerConfigured: Boolean(config.AI_PROVIDER),
    message: config.AI_API_KEY ? "AI 服务已配置" : "AI 服务尚未配置 API Key"
  }));

  app.post("/segment", { preHandler: app.authenticate }, async (request) => {
    const body = segmentSchema.parse(request.body);

    return {
      status: "completed",
      stickerUrl: body.imageUrl,
      message: "已收到主体选择。当前为本地占位结果，接入 AI 服务后会返回真实抠图。"
    };
  });

  app.post("/stylize", { preHandler: app.authenticate }, async (request) => {
    const body = stylizeSchema.parse(request.body);

    return {
      status: "completed",
      stickerUrl: body.imageUrl,
      variant: body.variant as StickerVariant,
      message: "已收到风格化请求。当前为本地占位结果，接入 AI 服务后会返回真实风格图。"
    };
  });

  app.post("/generate-diary", { preHandler: app.authenticate }, async (request) => {
    const body = generateDiarySchema.parse(request.body);

    return {
      text: buildDiaryText(body),
      model: config.AI_API_KEY ? `${config.AI_PROVIDER || "configured"}-placeholder` : "local-template",
      policy: "轻微润色，不编造重大事件"
    };
  });
};

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
  variant: z.enum(["原始抠图", "白边贴纸", "旅行插画版", "可爱漫画版", "手绘插画版", "黑白线稿版"])
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

type GenerateDiaryInput = z.infer<typeof generateDiarySchema>;

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface ImageEditResponse {
  data?: Array<{
    b64_json?: string;
  }>;
}

function canUseRemoteAi() {
  if (!config.AI_PROVIDER || !config.AI_API_KEY) return false;
  return ["openai", "openai-compatible"].includes(config.AI_PROVIDER.toLowerCase());
}

function canUseOpenAiImageEdit() {
  return config.AI_PROVIDER?.toLowerCase() === "openai" && Boolean(config.AI_API_KEY);
}

function buildRemoteDiaryPrompt(input: GenerateDiaryInput) {
  return [
    "You are the diary writing assistant for a Chinese photo journal app named Tietie Diary.",
    "Write only the diary body in Simplified Chinese.",
    "Keep it gentle, concrete, personal, and suitable for a cute journal page.",
    "Do not invent major events or dramatic facts.",
    `Style: ${input.writingStyle || "cute and lively"}`,
    `Length: ${input.length || "short paragraph"}`,
    `Location: ${input.location || "today"}`,
    `Mood: ${input.mood || "happy"}`,
    `Tags: ${input.tags?.length ? input.tags.join(", ") : "none"}`,
    `Sticker count: ${input.stickerCount ?? 0}`,
    `User note: ${input.prompt?.trim() || "record today's small moment"}`
  ].join("\n");
}

async function generateDiaryWithChatCompletion(input: GenerateDiaryInput) {
  const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.AI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.AI_MODEL,
      messages: [
        {
          role: "system",
          content: "You generate warm, realistic Simplified Chinese diary entries. Return only the diary text."
        },
        {
          role: "user",
          content: buildRemoteDiaryPrompt(input)
        }
      ],
      temperature: 0.85,
      max_tokens: 500
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI request failed: ${response.status} ${detail.slice(0, 160)}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI response did not include diary text");

  return {
    text,
    model: data.model || config.AI_MODEL
  };
}

function dataUrlToBlob(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URL");
  const bytes = Buffer.from(match[2], "base64");
  return new Blob([bytes], { type: match[1] });
}

async function imageUrlToBlob(imageUrl: string) {
  if (imageUrl.startsWith("data:")) return dataUrlToBlob(imageUrl);

  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  return response.blob();
}

function buildStickerEditPrompt(variant: StickerVariant) {
  const styleMap: Record<StickerVariant, string> = {
    原始抠图: "cut out the main subject cleanly, preserve the original photographic look",
    白边贴纸: "make a clean die-cut sticker with a thick white border and soft drop shadow",
    旅行插画版: "redraw the main subject as a travel journal illustration sticker, clean black line art, soft flat colors, thick white border, subtle shadow, like a souvenir sticker",
    可爱漫画版: "redraw the main subject as a cute comic sticker, bold outline, playful colors, thick white border, subtle shadow",
    手绘插画版: "redraw the main subject as a hand-drawn editorial illustration sticker, gentle textured lines, soft colors, thick white border",
    黑白线稿版: "redraw the main subject as a black and white line-art sticker, clean ink lines, thick white border"
  };

  return [
    styleMap[variant],
    "Use the input image only as reference.",
    "Isolate the main subject or selected object.",
    "Remove the original background.",
    "Return a single centered sticker on transparent background.",
    "No UI, no watermark, no extra text unless the original subject contains essential visible text."
  ].join(" ");
}

async function stylizeStickerWithOpenAi(imageUrl: string, variant: StickerVariant) {
  const image = await imageUrlToBlob(imageUrl);
  const formData = new FormData();
  formData.append("model", config.AI_IMAGE_MODEL);
  formData.append("image", image, "source.png");
  formData.append("prompt", buildStickerEditPrompt(variant));
  formData.append("size", "1024x1024");
  formData.append("background", "transparent");
  formData.append("quality", "medium");

  const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, "")}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.AI_API_KEY}`
    },
    body: formData,
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI image edit failed: ${response.status} ${detail.slice(0, 160)}`);
  }

  const data = (await response.json()) as ImageEditResponse;
  const imageBase64 = data.data?.[0]?.b64_json;
  if (!imageBase64) throw new Error("AI image edit response did not include image data");
  return `data:image/png;base64,${imageBase64}`;
}

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
    available: canUseRemoteAi(),
    providerConfigured: Boolean(config.AI_PROVIDER),
    model: config.AI_MODEL,
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

    if (canUseOpenAiImageEdit()) {
      try {
        const stickerUrl = await stylizeStickerWithOpenAi(body.imageUrl, body.variant as StickerVariant);
        return {
          status: "completed",
          stickerUrl,
          variant: body.variant as StickerVariant,
          message: "AI 已生成新的风格贴纸。"
        };
      } catch (error) {
        request.log.warn({ error }, "AI sticker stylization failed, falling back to local result");
      }
    }

    return {
      status: "completed",
      stickerUrl: body.imageUrl,
      variant: body.variant as StickerVariant,
      message: "已收到风格化请求。当前为本地占位结果，接入 AI 服务后会返回真实风格图。"
    };
  });

  app.post("/generate-diary", { preHandler: app.authenticate }, async (request) => {
    const body = generateDiarySchema.parse(request.body);

    if (canUseRemoteAi()) {
      try {
        const result = await generateDiaryWithChatCompletion(body);
        return {
          text: result.text,
          model: result.model,
          policy: "轻微润色，不编造重大事件"
        };
      } catch (error) {
        request.log.warn({ error }, "AI diary generation failed, falling back to local template");
      }
    }

    return {
      text: buildDiaryText(body),
      model: config.AI_API_KEY ? `${config.AI_PROVIDER || "configured"}-placeholder` : "local-template",
      policy: "轻微润色，不编造重大事件"
    };
  });
};

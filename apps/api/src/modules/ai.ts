import type { StickerVariant, SubjectSelection } from "@tietie/shared";
import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
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
  variant: z.enum(["白边原图贴纸", "旅行插画风", "像素风格", "线条手绘风", "可爱漫画风", "复古邮票风"]),
  selection: selectionSchema.optional()
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

interface QwenImageEditResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{
          image?: string;
        }>;
      };
    }>;
  };
  code?: string;
  message?: string;
}

function canUseRemoteAi() {
  if (!config.AI_PROVIDER || !config.AI_API_KEY) return false;
  return ["openai", "openai-compatible"].includes(config.AI_PROVIDER.toLowerCase());
}

function getImageProvider() {
  if (config.AI_IMAGE_PROVIDER) return config.AI_IMAGE_PROVIDER.toLowerCase();
  return config.AI_PROVIDER?.toLowerCase() === "openai" ? "openai" : "";
}

function getImageApiKey() {
  return config.AI_IMAGE_API_KEY || (getImageProvider() === "openai" ? config.AI_API_KEY : undefined);
}

function canUseOpenAiImageEdit() {
  return getImageProvider() === "openai" && Boolean(getImageApiKey());
}

function canUseQwenImageEdit() {
  return ["qwen-image-edit", "dashscope"].includes(getImageProvider()) && Boolean(getImageApiKey());
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function normalizeCrop(selection: SubjectSelection) {
  if (selection.mode === "box") {
    const pad = 5;
    const x = clampPercent(selection.x - pad);
    const y = clampPercent(selection.y - pad);
    return {
      x,
      y,
      width: Math.min(100 - x, Math.max(8, selection.width + pad * 2)),
      height: Math.min(100 - y, Math.max(8, selection.height + pad * 2))
    };
  }

  const size = 56;
  const x = clampPercent(selection.x - size / 2);
  const y = clampPercent(selection.y - size / 2);
  return {
    x,
    y,
    width: Math.min(size, 100 - x),
    height: Math.min(size, 100 - y)
  };
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

async function imageUrlToBuffer(imageUrl: string) {
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new Error("Invalid data URL");
    return Buffer.from(match[1], "base64");
  }

  const publicBase = config.PUBLIC_BASE_URL.replace(/\/$/, "");
  const relativeUrl = imageUrl.startsWith(publicBase) ? imageUrl.slice(publicBase.length) : imageUrl;
  if (relativeUrl.startsWith("/uploads/") || relativeUrl.startsWith("/assets/")) {
    const storagePath = relativeUrl.replace(/^\/(?:uploads|assets)\//, "");
    return readFile(path.join(config.STORAGE_DIR, storagePath));
  }

  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function blobToDataUrl(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const mimeType = blob.type || "image/png";
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function imageUrlToQwenInput(imageUrl: string) {
  if (imageUrl.startsWith("data:")) return imageUrl;
  if (/^https?:\/\//i.test(imageUrl) && !/^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:|\/|$)/i.test(imageUrl)) {
    return imageUrl;
  }
  return blobToDataUrl(await imageUrlToBlob(imageUrl));
}

function colorDistance(data: Buffer, ai: number, bi: number) {
  const dr = data[ai] - data[bi];
  const dg = data[ai + 1] - data[bi + 1];
  const db = data[ai + 2] - data[bi + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function removeConnectedBorderBackground(data: Buffer, width: number, height: number) {
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let head = 0;
  const threshold = 42;

  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < queue.length) {
    const index = queue[head];
    head += 1;
    const pixelIndex = index * 4;
    const x = index % width;
    const y = Math.floor(index / width);
    data[pixelIndex + 3] = 0;

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1
    ];

    for (const next of neighbors) {
      if (next < 0 || visited[next]) continue;
      const nextPixelIndex = next * 4;
      if (data[nextPixelIndex + 3] < 20 || colorDistance(data, pixelIndex, nextPixelIndex) < threshold) {
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
}

async function makeSilhouettePng(subjectPng: Buffer, color: string, blur = 0) {
  const metadata = await sharp(subjectPng).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Sticker image metadata missing");
  const alpha = await sharp(subjectPng).ensureAlpha().extractChannel("alpha").toBuffer();
  let image = sharp({
    create: {
      width: metadata.width,
      height: metadata.height,
      channels: 3,
      background: color
    }
  }).joinChannel(alpha);
  if (blur > 0) image = image.blur(blur);
  return image.png().toBuffer();
}

async function composeStickerPng(subjectPng: Buffer, padding = 44) {
  const metadata = await sharp(subjectPng).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Sticker image metadata missing");
  const width = metadata.width + padding * 2;
  const height = metadata.height + padding * 2;
  const white = await makeSilhouettePng(subjectPng, "#ffffff");
  const shadow = await makeSilhouettePng(subjectPng, "#263447", 7);
  const outlineOffsets = [
    [16, 0],
    [-16, 0],
    [0, 16],
    [0, -16],
    [11, 11],
    [-11, -11],
    [11, -11],
    [-11, 11]
  ];

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([
      { input: shadow, left: padding + 8, top: padding + 12, blend: "over" },
      ...outlineOffsets.map(([x, y]) => ({ input: white, left: padding + x, top: padding + y, blend: "over" as const })),
      { input: subjectPng, left: padding, top: padding, blend: "over" }
    ])
    .png()
    .toBuffer();
}

async function saveGeneratedSticker(buffer: Buffer) {
  const id = randomUUID();
  const dateFolder = new Date().toISOString().slice(0, 10);
  const folder = path.join(config.STORAGE_DIR, "generated", dateFolder);
  await mkdir(folder, { recursive: true });
  const filename = `${id}.png`;
  await writeFile(path.join(folder, filename), buffer);
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/uploads/generated/${dateFolder}/${filename}`;
}

async function createCutoutSubjectPng(sourceUrl: string, selection?: SubjectSelection) {
  const source = await imageUrlToBuffer(sourceUrl);
  const sourceImage = sharp(source).rotate();
  const metadata = await sourceImage.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image metadata missing");

  if (!selection) {
    return sourceImage.resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true }).ensureAlpha().png().toBuffer();
  }

  const crop = normalizeCrop(selection);
  const left = Math.min(metadata.width - 1, Math.max(0, Math.round((crop.x / 100) * metadata.width)));
  const top = Math.min(metadata.height - 1, Math.max(0, Math.round((crop.y / 100) * metadata.height)));
  const width = Math.max(1, Math.min(metadata.width - left, Math.round((crop.width / 100) * metadata.width)));
  const height = Math.max(1, Math.min(metadata.height - top, Math.round((crop.height / 100) * metadata.height)));
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(width, height));

  const raw = await sharp(source)
    .rotate()
    .extract({ left, top, width, height })
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      fit: "fill"
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  removeConnectedBorderBackground(raw.data, raw.info.width, raw.info.height);
  return sharp(raw.data, {
    raw: {
      width: raw.info.width,
      height: raw.info.height,
      channels: 4
    }
  })
    .png()
    .toBuffer();
}

async function createLocalSelectionStickerUrl(sourceUrl: string, selection: SubjectSelection) {
  const subject = await createCutoutSubjectPng(sourceUrl, selection);
  const sticker = await composeStickerPng(subject);
  return saveGeneratedSticker(sticker);
}

type StickerStyleModule = {
  padding: number;
  render: (subjectPng: Buffer) => Promise<Buffer>;
};

async function renderWhitePhotoStyle(subjectPng: Buffer) {
  return sharp(subjectPng).ensureAlpha().modulate({ saturation: 1.08 }).linear(1.04, -4).png().toBuffer();
}

async function renderTravelIllustrationStyle(subjectPng: Buffer) {
  return sharp(subjectPng).ensureAlpha().modulate({ saturation: 1.35, brightness: 1.08 }).linear(1.12, -10).tint("#d7f0ff").png().toBuffer();
}

async function renderPixelStyle(subjectPng: Buffer) {
  const metadata = await sharp(subjectPng).metadata();
  const maxSide = Math.max(metadata.width ?? 1, metadata.height ?? 1);
  const pixelSide = Math.max(24, Math.round(maxSide / 14));
  return sharp(subjectPng)
    .ensureAlpha()
    .resize({ width: pixelSide, height: pixelSide, fit: "inside", kernel: sharp.kernel.nearest })
    .resize({ width: metadata.width, height: metadata.height, fit: "contain", kernel: sharp.kernel.nearest, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .modulate({ saturation: 1.35, brightness: 1.05 })
    .png()
    .toBuffer();
}

async function renderLineSketchStyle(subjectPng: Buffer) {
  return sharp(subjectPng).ensureAlpha().grayscale().linear(1.7, -24).tint("#263447").png().toBuffer();
}

async function renderCuteComicStyle(subjectPng: Buffer) {
  return sharp(subjectPng).ensureAlpha().modulate({ saturation: 1.55, brightness: 1.06 }).linear(1.18, -12).png().toBuffer();
}

async function renderRetroStampStyle(subjectPng: Buffer) {
  const metadata = await sharp(subjectPng).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const grain = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity="0.08"/></svg>`
  );
  return sharp(subjectPng)
    .ensureAlpha()
    .modulate({ saturation: 0.78, brightness: 1.08 })
    .tint("#f3d49b")
    .composite([{ input: grain, blend: "overlay" }])
    .png()
    .toBuffer();
}

const stickerStyleModules: Record<StickerVariant, StickerStyleModule> = {
  白边原图贴纸: { padding: 58, render: renderWhitePhotoStyle },
  旅行插画风: { padding: 58, render: renderTravelIllustrationStyle },
  像素风格: { padding: 48, render: renderPixelStyle },
  线条手绘风: { padding: 42, render: renderLineSketchStyle },
  可爱漫画风: { padding: 42, render: renderCuteComicStyle },
  复古邮票风: { padding: 62, render: renderRetroStampStyle }
};

async function createLocalVariantStickerUrl(sourceUrl: string, variant: StickerVariant, selection?: SubjectSelection) {
  const subject = await createCutoutSubjectPng(sourceUrl, selection);
  const styleModule = stickerStyleModules[variant];
  const styledSubject = await styleModule.render(subject);
  const sticker = await composeStickerPng(styledSubject, styleModule.padding);
  return saveGeneratedSticker(sticker);
}

async function createStickerSelfTestImage() {
  const svg = `<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg">
    <rect width="320" height="240" fill="#8fd3ff"/>
    <circle cx="160" cy="120" r="70" fill="#ffcf56"/>
    <rect x="126" y="88" width="68" height="68" rx="14" fill="#ffffff"/>
  </svg>`;
  const source = await sharp(Buffer.from(svg)).png().toBuffer();
  const dataUrl = `data:image/png;base64,${source.toString("base64")}`;
  const selection: SubjectSelection = { mode: "box", x: 8, y: 8, width: 84, height: 84 };
  return createLocalSelectionStickerUrl(dataUrl, selection);
}

function buildStickerEditPrompt(variant: StickerVariant) {
  const styleMap: Record<StickerVariant, string> = {
    白边原图贴纸: "make a clean photo die-cut sticker with a thick white border and soft drop shadow",
    旅行插画风: "redraw the main subject as a travel journal illustration sticker, clean black line art, soft flat colors, thick white border, subtle shadow, like a souvenir sticker",
    像素风格: "redraw the main subject as a cute pixel art sticker, blocky low-resolution pixels, crisp edges, bright game-like colors, thick white border",
    线条手绘风: "redraw the main subject as a hand-drawn line sketch sticker, clean ink lines, sparse soft fill, thick white border",
    可爱漫画风: "redraw the main subject as a cute comic sticker, bold outline, playful colors, thick white border, subtle shadow",
    复古邮票风: "redraw the main subject as a retro postage stamp sticker, warm paper texture, vintage colors, thick white border"
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

  const baseUrl = config.AI_IMAGE_BASE_URL.includes("dashscope.aliyuncs.com") ? config.AI_BASE_URL : config.AI_IMAGE_BASE_URL;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getImageApiKey()}`
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

async function stylizeStickerWithQwen(imageUrl: string, variant: StickerVariant) {
  const sourceImage = await imageUrlToQwenInput(imageUrl);
  const response = await fetch(config.AI_IMAGE_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getImageApiKey()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.AI_IMAGE_MODEL,
      input: {
        messages: [
          {
            role: "user",
            content: [
              { image: sourceImage },
              { text: buildStickerEditPrompt(variant) }
            ]
          }
        ]
      },
      parameters: {
        n: 1,
        watermark: false,
        prompt_extend: true,
        negative_prompt: "low quality, blurry, messy background, watermark, extra text",
        size: "1024*1024"
      }
    }),
    signal: AbortSignal.timeout(90000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Qwen image edit failed: ${response.status} ${detail.slice(0, 160)}`);
  }

  const data = (await response.json()) as QwenImageEditResponse;
  if (data.code) throw new Error(`Qwen image edit failed: ${data.code} ${data.message || ""}`);

  const generatedImage = data.output?.choices?.[0]?.message?.content?.find((item) => item.image)?.image;
  if (!generatedImage) throw new Error("Qwen image edit response did not include image URL");
  return generatedImage;
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
    imageProvider: getImageProvider() || "local",
    imageModel: config.AI_IMAGE_MODEL,
    imageAvailable: canUseOpenAiImageEdit() || canUseQwenImageEdit(),
    message: config.AI_API_KEY ? "AI 服务已配置" : "AI 服务尚未配置 API Key"
  }));

  app.get("/sticker-self-test", async () => {
    const stickerUrl = await createStickerSelfTestImage();
    return {
      ok: true,
      status: "completed",
      stickerUrl,
      message: "贴纸抠图服务可用。"
    };
  });

  app.post("/segment", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const body = segmentSchema.parse(request.body);

    const stickerUrl = await createLocalSelectionStickerUrl(body.imageUrl, body.selection);
    return {
      status: "completed",
      stickerUrl,
      message: "后端已生成本地抠图贴纸。"
    };
  });

  app.post("/stylize", { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const body = stylizeSchema.parse(request.body);

    try {
      const variant = body.variant as StickerVariant;
      const stickerUrl = await createLocalVariantStickerUrl(body.imageUrl, variant, body.selection);
      return {
        status: "completed",
        stickerUrl,
        variant,
        message: "后端已生成本地风格贴纸。"
      };
    } catch (error) {
      request.log.warn({ error }, "Local sticker stylization failed, trying remote image provider");
    }

    if (canUseQwenImageEdit() || canUseOpenAiImageEdit()) {
      try {
        const variant = body.variant as StickerVariant;
        const stickerUrl = canUseQwenImageEdit()
          ? await stylizeStickerWithQwen(body.imageUrl, variant)
          : await stylizeStickerWithOpenAi(body.imageUrl, variant);
        return {
          status: "completed",
          stickerUrl,
          variant,
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

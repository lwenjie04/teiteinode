const endpoint = process.env.STICKER_STYLE_SELF_TEST_URL || "http://localhost:4000/api/ai/sticker-style-self-test";
const expectedVariants = ["白边原图贴纸", "旅行插画风", "像素风格", "线条手绘风", "可爱漫画风", "复古邮票风"];

function fail(message, detail) {
  console.error(message);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

async function main() {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail(`Sticker style check failed: non-JSON response from ${endpoint}`, text.slice(0, 500));
    return;
  }

  if (!response.ok) {
    fail(`Sticker style check failed: HTTP ${response.status}`, JSON.stringify(payload, null, 2));
    return;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const variants = new Set(items.map((item) => item.variant));
  const missing = expectedVariants.filter((variant) => !variants.has(variant));
  const failed = items.filter((item) => !item.ok || item.status !== "completed" || !item.stickerUrl);

  if (!payload.ok || missing.length || failed.length) {
    fail(
      "Sticker style check failed.",
      JSON.stringify(
        {
          ok: payload.ok,
          missing,
          failed: failed.map((item) => ({
            variant: item.variant,
            status: item.status,
            ok: item.ok,
            diagnostics: item.diagnostics
          }))
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint,
        variants: items.map((item) => ({
          variant: item.variant,
          width: item.diagnostics?.width,
          height: item.diagnostics?.height,
          transparentRatio: item.diagnostics?.transparentRatio,
          opaquePixels: item.diagnostics?.opaquePixels
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  fail("Sticker style check failed.", error instanceof Error ? error.message : String(error));
});

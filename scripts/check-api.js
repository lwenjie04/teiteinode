const baseUrl = (process.env.API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const health = await fetchJson("/api/health");
  assert(health.ok, "Health check did not return ok: true");

  const cutout = await fetchJson("/api/ai/sticker-self-test");
  assert(cutout.status === "completed" && cutout.stickerUrl, "Sticker cutout self-test did not complete");

  const styles = await fetchJson("/api/ai/sticker-style-self-test");
  assert(styles.ok, "Sticker style self-test did not return ok: true");
  assert(Array.isArray(styles.items) && styles.items.length === 6, "Sticker style self-test did not return six style items");
  for (const item of styles.items) {
    assert(item.ok, `${item.variant} style self-test failed`);
    assert(item.status === "completed" && item.stickerUrl, `${item.variant} did not return a generated sticker URL`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        health: { name: health.name, aiConfigured: health.aiConfigured, database: health.database?.available ? "available" : "fallback" },
        cutout: { status: cutout.status, stickerUrl: cutout.stickerUrl },
        styles: styles.items.map((item) => ({
          variant: item.variant,
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
  console.error("API check failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

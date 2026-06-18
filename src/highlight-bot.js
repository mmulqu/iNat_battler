// Autonomous highlight rendering via Cloudflare Browser Rendering (headless
// Chrome). See docs/battle-highlights-bluesky.md. The bot can't use a user's
// browser, so it drives the same /replay page headlessly: load it, let it encode
// the MP4 in-page (WebCodecs), then pull the bytes out and hand them to the
// app-password brand poster. R2 is never used — bytes go straight to Bluesky.
//
// COST: Browser Rendering is metered (10 browser-hours/month free on Workers
// Paid). Keep renders short and gated — see the curator's daily cap.
import puppeteer from "@cloudflare/puppeteer";

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Launches headless Chrome, renders the battle's /replay page to an MP4, and
// returns the bytes + metadata. Throws on any failure (with page errors folded
// in, so wrangler tail shows what broke).
export async function renderHighlightHeadless(env, battleId, { fps = 24, maxSeconds = 60, timeoutMs = 150000 } = {}) {
  const base = env.PUBLIC_BASE_URL;
  if (!base) throw new Error("PUBLIC_BASE_URL is not set");

  const browser = await puppeteer.launch(env.BROWSER);
  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push("console: " + msg.text());
    });

    const url = `${base}/replay/${encodeURIComponent(battleId)}?autostart=1&fps=${fps}&max=${maxSeconds}`;
    await page.goto(url, { waitUntil: "load", timeout: 60000 });

    // The page sets window.__replayResult when encoding finishes (ok or error).
    await page.waitForFunction(
      "window.__replayResult && typeof window.__replayResult.ok !== 'undefined'",
      { timeout: timeoutMs, polling: 500 }
    );

    const meta = await page.evaluate(() => {
      const r = window.__replayResult;
      return { ok: r.ok, error: r.error, width: r.width, height: r.height, durationMs: r.durationMs, bytes: r.bytes, encodeMs: r.encodeMs };
    });
    if (!meta.ok) {
      throw new Error(`Headless render failed: ${meta.error || "unknown"}${pageErrors.length ? " | " + pageErrors.join(" ; ") : ""}`);
    }

    const base64 = await page.evaluate(() => window.__replayResult.base64);
    if (!base64) throw new Error("Headless render produced no video data");

    return {
      bytes: base64ToBytes(base64),
      width: meta.width,
      height: meta.height,
      durationMs: meta.durationMs,
      encodeMs: meta.encodeMs
    };
  } finally {
    await browser.close();
  }
}

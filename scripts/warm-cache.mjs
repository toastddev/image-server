#!/usr/bin/env node
/**
 * Warm the derivative cache.
 *
 * For every image original, requests the full width × format matrix from the
 * deployed image server so each derivative is generated and persisted to
 * `toastd-assets-cache` *before* a shopper ever hits it. Run it after a batch of
 * uploads (or on a schedule) and the site's first paint is always a cache hit —
 * this is what makes AVIF (slow to encode on the first miss) safe to serve as
 * the default format.
 *
 * It drives the real HTTP endpoint rather than re-encoding here, so it exercises
 * the exact same cache-key logic as live traffic (`md5(path + JSON.stringify(
 * query))`) — no risk of the warm objects landing under a different key than the
 * ones the app requests.
 *
 * ── Source of image paths ────────────────────────────────────────────────────
 *   default            list the originals bucket (assets.toastd.in) via GCS
 *   --from-file <path>  newline-separated object paths (one per line), e.g. a
 *                       dump of `product_image.url` from the app database
 *
 * ── The width/format/quality matrix MUST match the Next.js loader ────────────
 * These are exactly the widths Next requests (imageSizes + deviceSizes in
 * new toastd/next.config.mjs) at the format/quality the loader emits
 * (src/lib/image-loader.ts). Keep the two in sync or warmed objects won't be
 * the ones the app asks for. Override via env if you change the loader.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   node scripts/warm-cache.mjs                       # warm the whole bucket
 *   node scripts/warm-cache.mjs --prefix greenhermitage/
 *   node scripts/warm-cache.mjs --from-file paths.txt
 *   node scripts/warm-cache.mjs --dry-run             # list work, request nothing
 *
 *   BASE_URL       endpoint to warm            (default https://assets.toastd.in)
 *   WIDTHS         comma list of pixel widths  (default matches the Next loader)
 *   FORMATS        comma list, e.g. avif,webp  (default avif)
 *   IMAGE_QUALITY  encoder quality             (default 50 — matches the loader)
 *   CONCURRENCY    parallel requests           (default 16)
 *   ORIGINAL_BUCKET  originals bucket to list  (default assets.toastd.in)
 */

import { Storage } from "@google-cloud/storage";

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.BASE_URL ?? "https://assets.toastd.in").replace(/\/+$/, "");
const ORIGINAL_BUCKET = process.env.ORIGINAL_BUCKET ?? "assets.toastd.in";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const QUALITY = Number(process.env.IMAGE_QUALITY ?? 50);

// Keep in lockstep with new toastd/next.config.mjs (imageSizes + deviceSizes)
// and src/lib/image-loader.ts (format + quality).
const WIDTHS = (process.env.WIDTHS ?? "96,183,280,384,549,640,750,828,1080,1200,1500,2000")
  .split(",")
  .map((n) => parseInt(n.trim(), 10))
  .filter((n) => n > 0 && n <= 2000);

const FORMATS = (process.env.FORMATS ?? "avif")
  .split(",")
  .map((f) => f.trim().toLowerCase())
  .filter(Boolean);

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? (args[i + 1] ?? "") : undefined;
};
const DRY_RUN = args.includes("--dry-run");
const PREFIX = flag("--prefix") ?? "";
const FROM_FILE = flag("--from-file");

// ── Collect the list of image object paths ───────────────────────────────────
async function collectPaths() {
  if (FROM_FILE) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(FROM_FILE, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Accept either bare object paths or full assets.toastd.in URLs.
      .map((line) => line.replace(/^https?:\/\/[^/]+\//i, "").replace(/[?#].*$/, ""))
      .filter((p) => p && IMAGE_EXT.test(p));
  }

  const storage = new Storage();
  const [files] = await storage.bucket(ORIGINAL_BUCKET).getFiles({ prefix: PREFIX });
  return files.map((f) => f.name).filter((name) => IMAGE_EXT.test(name));
}

// ── Build the request URL exactly as the app's loader does ───────────────────
// Param order (w, format, q) is significant: it must match image-loader.ts so
// the cache key is identical.
function derivativeUrl(objectPath, width, format) {
  const path = objectPath.replace(/^\/+/, "");
  return `${BASE_URL}/${encodeURI(path)}?w=${width}&format=${format}&q=${QUALITY}`;
}

// ── Simple bounded-concurrency worker pool ───────────────────────────────────
async function runPool(jobs, worker, concurrency) {
  let index = 0;
  const stats = { hit: 0, miss: 0, error: 0 };
  async function next() {
    while (index < jobs.length) {
      const job = jobs[index++];
      try {
        const cache = await worker(job);
        if (cache === "HIT") stats.hit++;
        else stats.miss++;
      } catch {
        stats.error++;
      }
      const done = stats.hit + stats.miss + stats.error;
      if (done % 200 === 0 || done === jobs.length) {
        process.stdout.write(
          `\r  ${done}/${jobs.length}  hit:${stats.hit} miss:${stats.miss} err:${stats.error}   `,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return stats;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Warming ${BASE_URL}`);
  console.log(`  widths:  ${WIDTHS.join(", ")}`);
  console.log(`  formats: ${FORMATS.join(", ")}  quality: ${QUALITY}`);

  const paths = await collectPaths();
  const jobs = [];
  for (const p of paths) {
    for (const format of FORMATS) {
      for (const width of WIDTHS) {
        jobs.push({ url: derivativeUrl(p, width, format) });
      }
    }
  }

  console.log(
    `  ${paths.length} images × ${FORMATS.length} formats × ${WIDTHS.length} widths = ${jobs.length} derivatives\n`,
  );

  if (jobs.length === 0) {
    console.log("Nothing to warm.");
    return;
  }
  if (DRY_RUN) {
    console.log("Dry run — sample URLs:");
    for (const j of jobs.slice(0, 8)) console.log("  " + j.url);
    return;
  }

  const t0 = Date.now();
  const stats = await runPool(
    jobs,
    async ({ url }) => {
      // A GET triggers generation on a miss and persists the derivative; on a
      // hit it's served straight from the cache bucket. We drain the body below
      // rather than keep it — we only care that the object now exists.
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      // Drain the body so the connection is freed for the next job.
      await res.arrayBuffer();
      // `x-goog-*` isn't exposed; treat any 200 as warmed. (Hit/miss split is
      // best-effort — the CDN/age header would refine it if one is in front.)
      return res.headers.get("age") ? "HIT" : "MISS";
    },
    CONCURRENCY,
  );

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n\nDone in ${secs}s — warmed:${stats.hit + stats.miss} errors:${stats.error}`,
  );
  if (stats.error > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nwarm-cache failed:", err);
  process.exit(1);
});

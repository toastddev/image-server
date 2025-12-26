import express from "express";
import crypto from "crypto";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";

const app = express();

/**
 * Health check (Cloud Run)
 */
app.get("/health", (_, res) => {
  res.status(200).send("ok");
});

const ORIGINAL_BUCKET = "assets.toastd.in";
const CACHE_BUCKET = "toastd-assets-cache";

let storage;
let originals;
let cache;

/**
 * Lazy-init GCS (IMPORTANT for Cloud Run startup)
 */
function initGCS() {
  if (!storage) {
    storage = new Storage();
    originals = storage.bucket(ORIGINAL_BUCKET);
    cache = storage.bucket(CACHE_BUCKET);
    console.log("GCS initialized");
  }
}

/**
 * Generate deterministic cache key
 */
function cacheKey(path, query) {
  return (
    "cache/" +
    crypto
      .createHash("md5")
      .update(path + JSON.stringify(query))
      .digest("hex")
  );
}

/**
 * Main handler
 */
app.get("*", async (req, res) => {
  try {
    initGCS();

    const assetPath = req.path.replace(/^\/+/, "");

    /**
     * 🚫 BYPASS NON-IMAGES (VIDEOS, PDFs, etc.)
     */
    if (!assetPath.match(/\.(jpg|jpeg|png|webp|avif)$/i)) {
      const file = originals.file(assetPath);
      if (!(await file.exists())[0]) {
        return res.status(404).send("Not found");
      }

      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return file.createReadStream().pipe(res);
    }

    /**
     * IMAGE REQUEST
     */
    const { w, h, format = "webp", q = 80 } = req.query;

    const width = w ? parseInt(w, 10) : undefined;
    const height = h ? parseInt(h, 10) : undefined;

    if ((width && width > 2000) || (height && height > 2000)) {
      return res.status(400).send("Image too large");
    }

    const key = cacheKey(assetPath, req.query);
    const cachedFile = cache.file(key);

    /**
     * ✅ CACHE HIT → SERVE FROM CACHE BUCKET
     */
    if ((await cachedFile.exists())[0]) {
      res.set({
        "Content-Type": `image/${format}`,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return cachedFile.createReadStream().pipe(res);
    }

    /**
     * ❌ CACHE MISS → LOAD ORIGINAL
     */
    const originalFile = originals.file(assetPath);
    if (!(await originalFile.exists())[0]) {
      return res.status(404).send("Not found");
    }

    const [buffer] = await originalFile.download();

    /**
     * Resize & convert
     */
    const output = await sharp(buffer)
      .resize(width, height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .toFormat(format, { quality: parseInt(q, 10) })
      .toBuffer();

    /**
     * Save resized image to cache bucket
     */
    await cachedFile.save(output, {
      contentType: `image/${format}`,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    /**
     * Serve resized image
     */
    res.set({
      "Content-Type": `image/${format}`,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(output);
  } catch (err) {
    console.error("Asset processing error:", err);
    res.status(500).send("Processing failed");
  }
});

/**
 * Cloud Run port binding
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Asset server running on port ${PORT}`);
});

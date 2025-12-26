import express from "express";
import crypto from "crypto";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";
import path from "path";

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
 * Lazy initialize GCS (avoids Cloud Run cold-start failure)
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
 * Generate cache key for resized images
 */
function cacheKey(filePath, query) {
  return (
    "cache/" +
    crypto
      .createHash("md5")
      .update(filePath + JSON.stringify(query))
      .digest("hex")
  );
}

/**
 * MIME type resolver for non-image assets
 */
function getMimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    case ".flv":
      return "video/x-flv";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

/**
 * Main request handler
 */
app.get("*", async (req, res) => {
  try {
    initGCS();

    const assetPath = req.path.replace(/^\/+/, "");

    /**
     * 🚫 BYPASS NON-IMAGES (VIDEOS, FILES)
     */
    if (!assetPath.match(/\.(jpg|jpeg|png|webp|avif)$/i)) {
      const file = originals.file(assetPath);
      if (!(await file.exists())[0]) {
        return res.status(404).send("Not found");
      }

      res.set({
        "Content-Type": getMimeType(assetPath),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "bytes",
      });

      return file.createReadStream().pipe(res);
    }

    /**
     * IMAGE HANDLING
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
     * ✅ Cache hit
     */
    if ((await cachedFile.exists())[0]) {
      res.set({
        "Content-Type": `image/${format}`,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return cachedFile.createReadStream().pipe(res);
    }

    /**
     * ❌ Cache miss → process image
     */
    const originalFile = originals.file(assetPath);
    if (!(await originalFile.exists())[0]) {
      return res.status(404).send("Not found");
    }

    const [buffer] = await originalFile.download();

    const output = await sharp(buffer)
      .resize(width, height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .toFormat(format, { quality: parseInt(q, 10) })
      .toBuffer();

    await cachedFile.save(output, {
      contentType: `image/${format}`,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

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

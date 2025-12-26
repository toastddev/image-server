import express from "express";
import sharp from "sharp";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

console.log("Starting image server...");

const app = express();

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const ORIGINAL_BUCKET = "assets.toastd.in";
const CACHE_BUCKET = "toastd-assets-cache";

let storage;
try {
  storage = new Storage();
  console.log("GCS client initialized");
} catch (err) {
  console.error("GCS init failed:", err);
  process.exit(1);
}

const originals = storage.bucket(ORIGINAL_BUCKET);
const cache = storage.bucket(CACHE_BUCKET);

function cacheKey(path, query) {
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify(query))
    .digest("hex");

  return `cache/${path}.${hash}`;
}

app.get("*", async (req, res) => {
  try {
    const imagePath = req.path.replace(/^\/+/, "");
    const { w, h, format = "webp", q = 80 } = req.query;

    if (!w && !h && !format) {
      const file = originals.file(imagePath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).send("Not found");

      res.set("Cache-Control", "public, max-age=31536000, immutable");
      file.createReadStream().pipe(res);
      return;
    }

    const width = w ? parseInt(w) : undefined;
    const height = h ? parseInt(h) : undefined;

    if (width > 2000 || height > 2000) {
      return res.status(400).send("Image too large");
    }

    const key = cacheKey(imagePath, req.query);
    const cached = cache.file(key);

    const [cachedExists] = await cached.exists();
    if (cachedExists) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      cached.createReadStream().pipe(res);
      return;
    }

    const original = originals.file(imagePath);
    const [exists] = await original.exists();
    if (!exists) return res.status(404).send("Not found");

    const [buffer] = await original.download();

    const output = await sharp(buffer)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .toFormat(format, { quality: parseInt(q) })
      .toBuffer();

    await cached.save(output, {
      contentType: `image/${format}`,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", `image/${format}`);
    res.send(output);
  } catch (err) {
    console.error("Request error:", err);
    res.status(500).send("Processing failed");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Image server running on port ${PORT}`);
});

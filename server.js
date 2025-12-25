import express from "express";
import sharp from "sharp";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

const app = express();
const PORT = 8080;

const ORIGINAL_BUCKET = "assets.toastd.in";       // originals bucket
const CACHE_BUCKET = "toastd-assets-cache";       // resized cache

const storage = new Storage();
const originals = storage.bucket(ORIGINAL_BUCKET);
const cache = storage.bucket(CACHE_BUCKET);

// Build cache key
function getCachePath(path, query) {
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify(query))
    .digest("hex");

  return `cache${path}.${hash}`;
}

app.get("*", async (req, res) => {
  try {
    const imagePath = req.path.replace(/^\/+/, ""); // remove leading /
    const { w, h, format = "webp", q = 80 } = req.query;

    // 🚀 NO PARAMS → SERVE ORIGINAL
    if (!w && !h && !format) {
      const file = originals.file(imagePath);
      const [exists] = await file.exists();
      if (!exists) return res.status(404).send("Not found");

      res.set("Cache-Control", "public, max-age=31536000, immutable");
      file.createReadStream().pipe(res);
      return;
    }

    // Validate sizes
    const width = w ? parseInt(w) : undefined;
    const height = h ? parseInt(h) : undefined;
    if (width > 2000 || height > 2000) {
      return res.status(400).send("Image size too large");
    }

    // Check cache
    const cachePath = getCachePath(imagePath, req.query);
    const cachedFile = cache.file(cachePath);
    const [cachedExists] = await cachedFile.exists();

    if (cachedExists) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      cachedFile.createReadStream().pipe(res);
      return;
    }

    // Cache miss → read original
    const originalFile = originals.file(imagePath);
    const [exists] = await originalFile.exists();
    if (!exists) return res.status(404).send("Not found");

    const [buffer] = await originalFile.download();

    // Resize
    const output = await sharp(buffer)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .toFormat(format, { quality: parseInt(q) })
      .toBuffer();

    // Save to cache bucket
    await cachedFile.save(output, {
      contentType: `image/${format}`,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", `image/${format}`);
    res.send(output);
  } catch (err) {
    console.error(err);
    res.status(500).send("Image processing failed");
  }
});

app.listen(PORT, () => {
  console.log(`Image server running on ${PORT}`);
});

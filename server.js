import express from "express";
import crypto from "crypto";
import sharp from "sharp";
import { Storage } from "@google-cloud/storage";

const app = express();

app.get("/health", (_, res) => res.send("ok"));

const ORIGINAL_BUCKET = "assets.toastd.in";
const CACHE_BUCKET = "toastd-assets-cache";

let storage;
let originals;
let cache;

// Lazy init GCS
function initGCS() {
  if (!storage) {
    storage = new Storage();
    originals = storage.bucket(ORIGINAL_BUCKET);
    cache = storage.bucket(CACHE_BUCKET);
    console.log("GCS initialized");
  }
}

function cacheKey(path, query) {
  return (
    "cache/" +
    crypto
      .createHash("md5")
      .update(path + JSON.stringify(query))
      .digest("hex")
  );
}

app.get("*", async (req, res) => {
  try {
    initGCS(); // initialize ONLY when first request comes

    const imagePath = req.path.replace(/^\/+/, "");
    const { w, h, format = "webp", q = 80 } = req.query;

    const width = w ? parseInt(w) : undefined;
    const height = h ? parseInt(h) : undefined;

    if (width > 2000 || height > 2000) {
      return res.status(400).send("Image too large");
    }

    const key = cacheKey(imagePath, req.query);
    const cachedFile = cache.file(key);

    if ((await cachedFile.exists())[0]) {
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return cachedFile.createReadStream().pipe(res);
    }

    const originalFile = originals.file(imagePath);
    if (!(await originalFile.exists())[0]) {
      return res.status(404).send("Not found");
    }

    const [buffer] = await originalFile.download();

    const output = await sharp(buffer)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .toFormat(format, { quality: parseInt(q) })
      .toBuffer();

    await cachedFile.save(output, {
      contentType: `image/${format}`,
      metadata: { cacheControl: "public, max-age=31536000, immutable" },
    });

    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Content-Type", `image/${format}`);
    res.send(output);
  } catch (err) {
    console.error(err);
    res.status(500).send("Processing failed");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});

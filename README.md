# Toastd Image / Asset Server

An on-the-fly image resizing and format-conversion server for Toastd assets, backed by
Google Cloud Storage and deployed on Cloud Run.

It sits in front of the `assets.toastd.in` bucket and serves:

- **Images** — resized, re-encoded and quality-tuned per request (`?w=`, `?h=`, `?format=`, `?q=`),
  with every derivative persisted to a second GCS bucket so it is only ever generated once.
- **Everything else** (video, PDF, zip, …) — streamed straight through from the originals
  bucket with the correct `Content-Type` and range support.

---

## Table of contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting to Google Cloud](#connecting-to-google-cloud)
- [Buckets](#buckets)
- [Running locally](#running-locally)
- [API reference](#api-reference)
  - [`GET /health`](#get-health)
  - [`GET /*` — asset endpoint](#get--asset-endpoint)
  - [Query parameters](#query-parameters)
  - [Supported input formats](#supported-input-formats)
  - [Supported output formats](#supported-output-formats)
  - [Non-image passthrough types](#non-image-passthrough-types)
  - [Response headers](#response-headers)
  - [Status codes](#status-codes)
- [Usage](#usage)
  - [Responsive images](#responsive-images)
  - [Next.js / custom loader](#nextjs--custom-loader)
  - [CSS background images](#css-background-images)
- [Caching](#caching)
- [Deployment (Cloud Run)](#deployment-cloud-run)
- [Bucket lifecycle policy](#bucket-lifecycle-policy)
- [Environment variables](#environment-variables)
- [Known limitations](#known-limitations)
- [Project layout](#project-layout)

---

## Architecture

```
                    ┌────────────────────────┐
  Browser / CDN ───▶│  Cloud Run: server.js  │
                    └───────────┬────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              ▼                                    ▼
   gs://assets.toastd.in                 gs://toastd-assets-cache
   (originals, read-only)                (derivatives, read/write)
```

Request flow for an image:

1. Path is normalised (`/a/b/img.jpg` → `a/b/img.jpg`).
2. If the extension is **not** an image, the object is streamed from the originals bucket as-is.
3. Otherwise a cache key is derived from `md5(path + JSON.stringify(query))`.
4. **Cache hit** → the derivative is streamed from `toastd-assets-cache`.
5. **Cache miss** → the original is downloaded, transformed with [sharp](https://sharp.pixelplumbing.com/),
   written to the cache bucket, and returned in the same response.

GCS clients are initialised lazily on first request (`initGCS()` in `server.js`) so a
credential problem cannot kill the container during Cloud Run cold start — the health
check stays green and the error surfaces per-request instead.

---

## Requirements

| Requirement | Version / notes |
|---|---|
| Node.js | 20.x (the Docker image is `node:20-slim`; sharp ships prebuilt binaries for Debian) |
| npm | 9+ |
| Google Cloud SDK | `gcloud` CLI, for local auth and deployment |
| GCS buckets | `assets.toastd.in` (originals) and `toastd-assets-cache` (derivatives) |

Runtime dependencies (`package.json`):

- `express` ^4.19.2
- `sharp` ^0.34.5 — bundles libvips 8.17.x (webp 1.6.0, aom/AVIF 3.13.1, libheif 1.20.2, mozjpeg, libpng, tiff)
- `@google-cloud/storage` ^7.18.0

---

## Installation

```bash
git clone <repo-url>
cd Image-server
npm install
```

> **Windows note:** sharp installs a platform-specific prebuilt binary. If you develop on
> Windows and deploy via Docker, do not commit `node_modules` — the Linux image installs its
> own binary at build time (`npm install --production` in the Dockerfile).

---

## Connecting to Google Cloud

The server uses **Application Default Credentials (ADC)**. `new Storage()` is constructed
with no arguments, so it picks up credentials from the environment in this order:

1. `GOOGLE_APPLICATION_CREDENTIALS` (path to a service-account JSON key)
2. gcloud user credentials from `gcloud auth application-default login`
3. The attached service account of the runtime (Cloud Run / GCE metadata server)

### Local development

Sign in and set the ADC credentials:

```bash
gcloud auth login
gcloud config set project <PROJECT_ID>
gcloud auth application-default login
```

If you would rather use a service-account key file:

```bash
gcloud iam service-accounts create image-server \
  --display-name="Toastd image server"

gcloud iam service-accounts keys create ./sa-key.json \
  --iam-account=image-server@<PROJECT_ID>.iam.gserviceaccount.com

# Bash / Git Bash
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/sa-key.json"

# PowerShell
$env:GOOGLE_APPLICATION_CREDENTIALS = "$PWD\sa-key.json"
```

`.env` and `*.json` keys are gitignored — never commit a key file.

### Required IAM roles

| Bucket | Access needed | Suggested role |
|---|---|---|
| `assets.toastd.in` | read objects | `roles/storage.objectViewer` |
| `toastd-assets-cache` | read + create objects | `roles/storage.objectAdmin` |

Grant them to the service account the server runs as:

```bash
SA=image-server@<PROJECT_ID>.iam.gserviceaccount.com

gcloud storage buckets add-iam-policy-binding gs://assets.toastd.in \
  --member="serviceAccount:$SA" --role="roles/storage.objectViewer"

gcloud storage buckets add-iam-policy-binding gs://toastd-assets-cache \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

---

## Buckets

| Constant in `server.js` | Bucket | Purpose |
|---|---|---|
| `ORIGINAL_BUCKET` | `assets.toastd.in` | Source of truth. Never written to by this service. |
| `CACHE_BUCKET` | `toastd-assets-cache` | Generated derivatives, stored under the `cache/` prefix. Safe to wipe. |

Both are hardcoded at the top of `server.js`; change them there if you fork this for
another environment.

---

## Running locally

```bash
npm start          # node server.js
```

The server binds `0.0.0.0:8080` (override with `PORT`). Quick check:

```bash
curl -i http://localhost:8080/health
curl -o out.webp "http://localhost:8080/products/shoe.jpg?w=400&format=webp&q=75"
```

---

## API reference

### `GET /health`

Cloud Run health probe. Always returns `200 ok` and never touches GCS.

### `GET /*` — asset endpoint

Every other path is treated as an object path inside `assets.toastd.in`. Leading slashes
are stripped, so `GET /banners/hero.jpg` reads `gs://assets.toastd.in/banners/hero.jpg`.

Behaviour depends on the file extension:

- **Image extension** (see below) → transformed and cached.
- **Anything else** → existence check, then streamed straight through with
  `Accept-Ranges: bytes` so video seeking works.

### Query parameters

Only applied to image requests. All are optional.

| Param | Type | Default | Range / accepted values | Description |
|---|---|---|---|---|
| `w` | integer | — | 1 – 2000 | Target **max width** in pixels. |
| `h` | integer | — | 1 – 2000 | Target **max height** in pixels. |
| `format` | string | `webp` | see [output formats](#supported-output-formats) | Output encoding. |
| `q` | integer | `80` | 1 – 100 | Encoder quality. Applies to lossy formats (webp, jpeg, avif, heif, jxl) and to palette quantisation for png. |

**Resize semantics** — `fit: "inside"` with `withoutEnlargement: true`:

- Aspect ratio is always preserved. `w` and `h` are a bounding box, not exact dimensions.
- Passing only `w` scales height proportionally (and vice versa).
- Images are **never upscaled**. Requesting `?w=2000` on a 400px-wide original returns 400px.
- With neither `w` nor `h`, the image is only re-encoded (format/quality change, original dimensions).

Examples:

| Request | 371×384 source → result |
|---|---|
| `?w=183` | 183×189 webp |
| `?h=183` | 177×183 webp |
| `?w=183&h=183` | 177×183 webp (fits inside the box) |
| `?w=366&format=avif&q=60` | 366×379 avif |
| `?format=jpeg` | 371×384 jpeg |

Anything over 2000px in either dimension returns `400 Image too large`.

### Supported input formats

Transformation is gated on the URL extension (case-insensitive):

```
.jpg  .jpeg  .png  .webp  .avif
```

Any other extension **bypasses sharp entirely** and is streamed byte-for-byte from the
originals bucket. That includes formats sharp could technically decode (`.gif`, `.tiff`,
`.svg`, `.heic`) — they are served as-is rather than resized. Extend the regex in
`server.js` if you need them transformed.

### Supported output formats

`format` is passed to sharp's `toFormat()`, which accepts these values (aliases collapse to
the same encoder):

| `format` value | Encoder | Notes |
|---|---|---|
| `webp` | WebP | **Default.** Best size/compatibility trade-off. |
| `avif` | AVIF | Smallest files, slower to encode. |
| `jpeg`, `jpg`, `jpe` | JPEG (mozjpeg) | Use `jpeg` — see the `Content-Type` caveat below. |
| `png` | PNG | Lossless; `q` drives palette quantisation. |
| `gif` | GIF | |
| `tiff`, `tif` | TIFF | |
| `heif`, `heic` | HEIF | |
| `jxl` | JPEG XL | Limited browser support. |
| `jp2`, `jpx`, `j2k`, `j2c` | JPEG 2000 | Requires libvips built with OpenJPEG. |
| `raw` | uncompressed pixel data | Not useful over HTTP. |
| `tile`, `dz` | DeepZoom tiles | Not usable through this endpoint. |

The response `Content-Type` is built as `image/<format>` verbatim, so `?format=jpg` sends
`image/jpg` (non-standard but tolerated by browsers) while `?format=jpeg` sends the correct
`image/jpeg`. **Prefer `webp`, `avif`, `jpeg`, `png`.** An unrecognised value throws inside
sharp and surfaces as `500 Processing failed`.

### Non-image passthrough types

`getMimeType()` maps these extensions; everything unlisted falls back to
`application/octet-stream`:

| Extension | `Content-Type` |
|---|---|
| `.mp4`, `.m4v` | `video/mp4` |
| `.webm` | `video/webm` |
| `.mov` | `video/quicktime` |
| `.mkv` | `video/x-matroska` |
| `.avi` | `video/x-msvideo` |
| `.flv` | `video/x-flv` |
| `.pdf` | `application/pdf` |
| `.zip` | `application/zip` |
| *(anything else)* | `application/octet-stream` |

### Response headers

| Response | Headers |
|---|---|
| Image (hit or miss) | `Content-Type: image/<format>`, `Cache-Control: public, max-age=31536000, immutable` |
| Passthrough asset | `Content-Type: <mapped mime>`, `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes` |
| 404 | `Cache-Control: no-store, must-revalidate` |

404s are deliberately non-cacheable: a presigned upload that commits a moment after a read
would otherwise leave a broken thumbnail pinned in the browser and CDN until expiry.

### Status codes

| Code | Body | Cause |
|---|---|---|
| `200` | asset bytes | OK |
| `400` | `Image too large` | `w` or `h` above 2000 |
| `404` | `Not found` | Object missing from the originals bucket (after one retry) |
| `500` | `Processing failed` | sharp/GCS error — invalid `format`, non-numeric `w`/`h`, corrupt source, IAM failure. Details are logged server-side. |

Existence checks use `existsWithRetry()`: if the first `file.exists()` is false it waits
300 ms and checks once more, covering the brief window where a freshly written object is
not yet visible to a parallel reader.

---

## Usage

### Responsive images

Request the size you actually display — this is what fixes Lighthouse's *"image file is
larger than it needs to be for its displayed dimensions"* warning. For a 183×183 slot:

```html
<img
  src="https://assets.toastd.in/products/shoe.jpg?w=183"
  srcset="
    https://assets.toastd.in/products/shoe.jpg?w=183 1x,
    https://assets.toastd.in/products/shoe.jpg?w=366 2x,
    https://assets.toastd.in/products/shoe.jpg?w=549 3x"
  width="183" height="183" alt="Shoe" loading="lazy" decoding="async" />
```

Width-based `srcset` with `sizes`, for a fluid grid:

```html
<img
  src="https://assets.toastd.in/products/shoe.jpg?w=600"
  srcset="
    https://assets.toastd.in/products/shoe.jpg?w=200 200w,
    https://assets.toastd.in/products/shoe.jpg?w=400 400w,
    https://assets.toastd.in/products/shoe.jpg?w=800 800w"
  sizes="(max-width: 640px) 50vw, 183px"
  alt="Shoe" loading="lazy" />
```

AVIF with a WebP fallback:

```html
<picture>
  <source type="image/avif" srcset="https://assets.toastd.in/products/shoe.jpg?w=366&format=avif" />
  <img src="https://assets.toastd.in/products/shoe.jpg?w=366" width="183" height="183" alt="Shoe" />
</picture>
```

> Keep the generated variants to a small, fixed set of widths. Every unique query string is
> a separate cached object, so `?w=181`, `?w=182`, `?w=183` bloat the cache bucket for no
> visual gain.

### Next.js / custom loader

```js
// next.config.js
module.exports = {
  images: {
    loader: "custom",
    loaderFile: "./toastdLoader.js",
  },
};
```

```js
// toastdLoader.js
export default function toastdLoader({ src, width, quality }) {
  const params = new URLSearchParams({
    w: String(width),
    q: String(quality || 80),
    format: "webp",
  });
  return `https://assets.toastd.in/${src.replace(/^\/+/, "")}?${params}`;
}
```

### CSS background images

```css
.hero {
  background-image: url("https://assets.toastd.in/banners/hero.jpg?w=1200&q=70");
}

@media (min-resolution: 2dppx) {
  .hero {
    background-image: url("https://assets.toastd.in/banners/hero.jpg?w=2000&q=60");
  }
}
```

---

## Caching

Three layers:

1. **Browser / CDN** — `Cache-Control: public, max-age=31536000, immutable` on every success.
2. **GCS derivative cache** — `cache/<md5(path + JSON.stringify(query))>` in
   `toastd-assets-cache`, saved with the same `cacheControl` metadata.
3. **Originals** — untouched.

Because URLs are served `immutable`, **replacing an object in place will not be picked up**
by clients or the derivative cache. To publish a new version, either upload under a new
path or add a cache-busting parameter (`?v=2`) — which also produces a fresh cache key.

Clearing the derivative cache is safe at any time; it rebuilds on demand:

```bash
gcloud storage rm -r gs://toastd-assets-cache/cache/**       # nuke everything
gcloud storage ls gs://toastd-assets-cache/cache/ | head     # inspect
```

---

## Deployment (Cloud Run)

`Dockerfile` builds a `node:20-slim` image (Debian, required for sharp's prebuilt libvips),
installs production deps only, and exposes port 8080.

Source-based deploy (Cloud Build does the image build):

```bash
gcloud run deploy toastd-image-server \
  --source . \
  --project <PROJECT_ID> \
  --region <REGION> \
  --platform managed \
  --allow-unauthenticated \
  --service-account image-server@<PROJECT_ID>.iam.gserviceaccount.com \
  --memory 1Gi \
  --cpu 1 \
  --concurrency 40 \
  --timeout 60
```

Or build and push the image yourself:

```bash
gcloud builds submit --tag gcr.io/<PROJECT_ID>/toastd-image-server

gcloud run deploy toastd-image-server \
  --image gcr.io/<PROJECT_ID>/toastd-image-server \
  --region <REGION> \
  --allow-unauthenticated
```

Sizing notes: sharp decodes the whole original into memory, so 1 GiB and a bounded
`--concurrency` keep AVIF/large-JPEG encodes from OOMing the instance. Put Cloud CDN or
Cloudflare in front so repeat traffic never reaches Cloud Run at all.

Local Docker run:

```bash
docker build -t toastd-image-server .
docker run --rm -p 8080:8080 \
  -v "$HOME/.config/gcloud:/root/.config/gcloud:ro" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json \
  toastd-image-server
```

---

## Bucket lifecycle policy

`lifecycle.json` deletes cached derivatives after 90 days so the cache bucket does not grow
without bound. Apply it to the **cache bucket only** — never the originals:

```bash
gcloud storage buckets update gs://toastd-assets-cache --lifecycle-file=lifecycle.json

# verify
gcloud storage buckets describe gs://toastd-assets-cache --format="value(lifecycle)"
```

```json
{
  "rule": [
    { "action": { "type": "Delete" }, "condition": { "age": 90 } }
  ]
}
```

Deleted entries are simply regenerated on the next request.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Listen port. Cloud Run sets this automatically. |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a service-account JSON key. Unset on Cloud Run, where the attached service account is used. |

There is no `.env` file in use; the bucket names are constants in `server.js`.

---

## Known limitations

- **`format` is not validated.** Any string goes straight to `sharp.toFormat()`; an unknown
  value throws and returns `500`. An allowlist would turn it into a `400`.
- **`Content-Type` mirrors the raw `format` value**, so `?format=jpg` emits the
  non-standard `image/jpg`. Use `?format=jpeg`.
- **Cache keys are query-order sensitive** — `?w=183&q=80` and `?q=80&w=183` hash
  differently and store two identical objects. Sort the params before hashing to fix.
- **Non-numeric `w`/`h`** (`?w=abc`) become `NaN` and reach sharp, producing a `500` rather
  than a `400`.
- **No cropping.** `fit` is hardcoded to `"inside"`, so exact square/fixed-ratio output is
  not possible; a `fit=cover` parameter would need to be added.
- **No cache invalidation endpoint** — clear objects from `toastd-assets-cache` manually.
- **Non-image passthrough ignores `Range` headers.** `Accept-Ranges: bytes` is advertised
  but the full object is streamed, so video scrubbing re-downloads from the start.
- **Whole-file download on cache miss** — large originals are buffered in memory.

---

## Project layout

```
.
├── server.js         # the service (routing, resize, cache, passthrough)
├── server copy.js    # earlier revision, kept for reference — not deployed
├── package.json
├── Dockerfile        # node:20-slim, production deps, port 8080
├── lifecycle.json    # 90-day delete rule for the cache bucket
├── .dockerignore
└── README.md
```

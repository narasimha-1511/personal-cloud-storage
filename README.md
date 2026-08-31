# Video Vault

Private, resumable raw-video transfer: record 4K on a phone in the mountains, upload the **original bytes** (zero transcoding, zero compression) to Cloudflare R2 over unreliable internet, and let a remote editor download them reliably.

**Primary engineering principle: if the internet dies, nothing is lost.** Uploads and downloads always resume from where they stopped — never from zero.

---

## 1. Architecture

```
┌──────────────────────┐   session cookie   ┌──────────────────────────────┐
│  Browser PWA         │   + JSON API       │  Node (Hono) on Coolify      │
│  React + Vite        │───────────────────▶│   auth: users/roles/sessions │──▶ SQLite
│  Dexie (IndexedDB)   │                    │   multipart orchestration    │   (/data volume)
│                      │                    │   presigns R2 S3 URLs        │
│  upload engine       │                    │   serves the built PWA       │
│  download engine     │                    └──────────────────────────────┘
│                      │      presigned URLs (short-lived)
│  PUT part ───────────┼───────────────────────────────────▶ ┌────────────────┐
│  GET (Range) ────────┼───────────────────────────────────▶ │ Cloudflare R2  │
└──────────────────────┘                                     │ private bucket │
                                                             └────────────────┘
```

- **Video bytes flow browser ↔ R2 directly.** The app server signs URLs and tracks metadata; it never proxies gigabytes. R2 egress is free, so editor downloads don't touch your Coolify server's bandwidth either.
- **Uploads**: R2 multipart via presigned `UploadPart` URLs, 50 MB parts (configurable), max 2 parts in flight (drops to 1 on a flaky connection). Every finished part is persisted to IndexedDB *and* reported to the server before anything else happens. On resume the server asks R2 `ListParts` — the authoritative record — and only missing parts are sent. `Complete` verifies every part and the exact total size before a video is marked `READY`, then double-checks the final object with a `HEAD`.
- **Downloads**: presigned GET + `Range` requests, streamed to disk via the File System Access API (never `response.blob()`), checkpointed every 64 MB. Resume continues from the actual on-disk file size.
- **Viewing**: presigned inline GET (1 h) — the `<video>` tag streams and seeks directly against R2.

Repo layout: `server/` (Hono API, Drizzle + SQLite), `web/` (React PWA), `shared/` (API types).

## 2. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `8787` | HTTP port |
| `DATABASE_PATH` | no | `./data/videovault.db` | SQLite file — point at the persistent volume |
| `R2_ACCOUNT_ID` | prod | — | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | prod | — | R2 S3 API token id (bucket-scoped) |
| `R2_SECRET_ACCESS_KEY` | prod | — | R2 S3 API token secret |
| `R2_BUCKET` | prod | — | Bucket name, e.g. `video-vault` |
| `S3_ENDPOINT` | no | R2 endpoint | Override for MinIO in local dev |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | first boot | — | Seeds the admin **only when no users exist** |
| `SESSION_SECRET` | prod | — | HMAC key for session tokens (`openssl rand -hex 32`) |
| `PART_SIZE_BYTES` | no | `52428800` (50 MB) | Multipart part size (min 5 MiB; ≤10 000 parts/file) |
| `VIEW_URL_TTL_SECONDS` | no | `3600` | Lifetime of view/download links |
| `PART_URL_TTL_SECONDS` | no | `3600` | Lifetime of part-upload links |
| `SESSION_TTL_DAYS` | no | `30` | Login session lifetime |
| `PUBLIC_ORIGIN` | no | — | Public URL of the app (informational) |

Secrets never reach the browser; the frontend has no environment at all.

## 3. Cloudflare R2 setup (once)

```sh
npx wrangler r2 bucket create video-vault

# CORS: the browser PUTs parts and GETs ranges directly against R2.
# exposeHeaders MUST include ETag — resume cannot work without it.
npx wrangler r2 bucket cors put video-vault --rules '[{
  "allowed": {
    "origins": ["https://YOUR-COOLIFY-DOMAIN"],
    "methods": ["PUT", "GET", "HEAD"],
    "headers": ["*"]
  },
  "exposeHeaders": ["ETag"],
  "maxAgeSeconds": 3600
}]'
```

Then in the Cloudflare dashboard: **R2 → Manage R2 API tokens → Create token** → *Object Read & Write*, scoped to **only** this bucket. That gives you `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`; the account id is on the R2 overview page. Keep the bucket private — no public access, no custom domain needed.

## 4. Database

SQLite via Drizzle; migrations in `server/drizzle/*.sql` apply automatically on boot (tracked in `_migrations`). Tables: `users`, `sessions`, `projects`, `folders`, `videos`, `uploads`, `upload_parts`. Back up by copying the SQLite file from the volume (it's WAL mode; `sqlite3 videovault.db ".backup backup.db"` is the safe way).

## 5. Local development

```sh
npm install
cp .env.example server/.env        # fill in R2 creds, or point S3_ENDPOINT at MinIO
npm run dev                        # server on :8787, Vite on :5173 (proxies /api)
```

Open http://localhost:5173, log in with the seeded admin. Without R2 credentials everything works except transfers. Fully offline option: `docker compose up` runs the app + MinIO standing in for R2.

Checks: `npm run check` = typecheck + lint + tests (46) + build. Individual: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

## 6. Deploying on Coolify

1. Push this repo to Git (GitHub/Gitea/…).
2. Coolify → **New Resource → Application**, pick the repo. Build pack: **Dockerfile** (in the repo root). Port: **8787**.
3. **Persistent storage**: add a volume mounted at `/data`.
4. **Environment variables**: set everything in the table above marked *prod* (plus `ADMIN_USERNAME`/`ADMIN_PASSWORD` for first boot, and `DATABASE_PATH=/data/videovault.db`).
5. Assign your HTTPS domain, deploy.
6. Health check endpoint: `GET /api/health`.
7. Put the same domain in the R2 CORS rule (step 3 above).
8. Log in as admin → **Admin** tab → create a user for yourself/family and one for the editor.

Redeploys are safe: state lives in the volume (SQLite) and in R2. Interrupted uploads survive server restarts — resume state is in R2 + the phone's IndexedDB.

## 7. Security checklist

- [x] R2 bucket private; token scoped to the one bucket; credentials only in server env
- [x] Browser gets only short-lived presigned URLs (1 h) for exactly one object/part
- [x] Every `/api` route behind session auth; sessions are HMAC-hashed random tokens in an `HttpOnly`/`Secure`/`SameSite=Lax` cookie
- [x] Passwords: argon2id; login rate-limited; username enumeration mitigated (constant-shape verify)
- [x] Roles: admin (everything, user management) vs user (upload; rename/move/delete **own** videos)
- [x] Object keys built entirely server-side; client filenames sanitized; no client-supplied keys/paths anywhere (no `?key=../..` class of bug)
- [x] Deactivating a user kills their existing sessions
- [x] Logs never contain credentials, signed URLs, or passwords
- [ ] You: use strong passwords, HTTPS-only domain (Coolify default), and keep `SESSION_SECRET` random

## 8. Reliability / failure-mode checklist

| Failure | Behavior |
|---|---|
| WiFi/4G drops mid-part | Part retries with backoff 1s→2s→4s→8s→16s (±jitter), then the upload pauses as *Waiting for connection*; auto-resumes via `online` event + 30 s health probe. `navigator.onLine` is only a hint — a successful request is the proof. |
| Page reload / tab killed | All state (parts, ETags, offsets) is in IndexedDB. On restart the app asks the server, which asks R2 `ListParts` (authoritative), and continues from the first missing part. The phone re-picks the file (identity checked: name+size+mtime). |
| Phone dies at part 47/100 | Parts 48–100 are uploaded on resume; 1–47 never again (integration-tested — the test fails if any early part is re-PUT). |
| Presigned URL expires while offline | Every retry signs a fresh URL. |
| Complete called with parts missing | Server refuses (409 + missing list) after checking R2; client drops those parts locally and re-uploads them. A video can never be `READY` without every byte verified. |
| Completed object size mismatch | Server marks the video `FAILED`, never `READY`. |
| Download cut at 4.7 GB | Progress is committed to disk in 64 MB checkpoints; resume issues `Range: bytes=<on-disk-size>-`. If a server ever ignored Range, the client errors instead of silently rewriting the file. |
| Browser without File System Access API | Falls back to the browser's own download manager with an honest caveat. |
| Upload abandoned forever | Server sweep aborts multipart uploads idle >7 days so R2 doesn't silently bill for invisible parts. |
| App server dies mid-upload | Parts continue PUTting to R2 until sign/part-done calls fail, then normal retry/pause kicks in; nothing is lost. |

Browser reality, stated honestly: JavaScript cannot keep uploading after the OS kills the browser. Keep the tab open and the screen on for big uploads (the UI says so). What *is* guaranteed: whatever was uploaded stays uploaded, and resuming is cheap.

## 9. Manual test: simulating mountain internet

1. Start an upload of a large file (≥ 500 MB).
2. DevTools → Network → throttle to *Slow 3G*: speed drops, ETA grows, parts keep landing.
3. Switch throttle to *Offline* mid-part: watch *Uploading → Retrying → Waiting for connection*. Progress bar keeps its position.
4. Back to *Online*: upload resumes by itself within ~30 s from the same part.
5. While uploading, hard-reload the tab: the upload card reappears as *Tap to resume*; re-select the same file; verify in DevTools that PUTs start at the first missing part, not part 1.
6. Kill the whole browser, reopen: same as 5.
7. On the phone itself: enable airplane mode mid-upload, wait a minute, disable — same recovery.
8. Editor side: start a download, pull the ethernet cable at ~50%, replug, press Resume — the request in DevTools shows `Range: bytes=N-` and the final file plays.

## 10. Uploading from Android (the mountain phone)

1. Open `https://your-domain` in **Chrome**, log in.
2. Menu ⋮ → **Add to Home screen / Install app** — Video Vault installs as a PWA.
3. In the app: pick the project (and folder, e.g. *Day 1*), tap **+ ADD VIDEOS**, select clips from the gallery. Originals are uploaded byte-for-byte.
4. **Keep the app open and the screen on while uploading** (plug the phone in; consider a screen-timeout bump). Android will pause the upload if the browser is killed in the background — reopen and it resumes.
5. If the connection dies: nothing to do. The app retries, then waits and resumes when signal returns.
6. If the app was closed mid-upload: reopen it, tap **Re-select file to resume** on the interrupted card and pick the same clip — it continues from the exact part where it stopped.

## 11. Downloading footage (the editor)

1. Open `https://your-domain` in **Chrome or Edge** (needed for resumable managed downloads), log in, go to **Editor**.
2. Click **Download** on a clip, choose where to save it. Progress shows bytes, %, speed and ETA.
3. Connection drop? The card says *Connection lost — resuming from X GB*; it retries automatically, or press **Resume** — it continues from the byte where it stopped, even after a browser restart (progress is on disk).
4. **Play** (Browse tab) streams the original for a quick check without downloading; **Copy view link** gives a 1-hour shareable link.
5. The downloaded file is bit-exact: the system verifies part inventory and total size at upload completion, and the download finishes only when the on-disk size matches exactly.

---

*Verified end-to-end against a real S3 implementation (MinIO): multipart upload through presigned URLs, SHA-256-identical full and Range-resumed downloads, 46 automated tests including the parts-48-to-100-only restart invariant.*

/**
 * Streamable client using only HTTP requests (no headless browser). Runs on Node.js >= 20 and Bun.
 *
 * Flow (mirrors what streamable.com's web uploader does):
 *   1. POST https://ajax.streamable.com/check                     -> session cookies
 *   2. GET  https://api-f.streamable.com/api/v1/uploads/shortcode -> shortcode + S3 upload credentials
 *   3. POST https://api-f.streamable.com/api/v1/videos/:sc/initialize
 *   4. S3 multipart upload with the returned temporary credentials
 *      (falls back to a single presigned form POST, like the web app)
 *   5. POST https://api-f.streamable.com/api/v1/transcode/:sc
 */

import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { multipartUpload, type RangeSource, type S3Credentials } from "./s3-multipart.js";

const AJAX_HOST = "https://ajax.streamable.com";
const API_HOST = "https://api-f.streamable.com/api/v1";
const PUBLIC_API_HOST = "https://api.streamable.com";
// The web app sends REACT_APP_VERSION, which is unset in production builds.
const CLIENT_VERSION = "unknown";
const GiB = 1024 ** 3;
// S3 presigned POST uploads are capped at 5 GB.
const MAX_FORM_POST_SIZE = 5 * GiB;

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  origin: "https://streamable.com",
  referer: "https://streamable.com/",
  pragma: "no-cache",
  "cache-control": "no-cache",
};

export interface UploadOptions {
  /** Label (folder) id to put the video in. */
  labelId?: string | number;
  /** Video title. Defaults to the file name without extension. */
  title?: string;
  /** File name reported to Streamable. Defaults to the path/URL/File name. */
  fileName?: string;
  /**
   * Extra HTTP headers for downloading a URL source, e.g. `{ Authorization: "Bearer <token>" }`.
   * Only sent to the URL's own origin; never forwarded to a host it redirects to.
   */
  headers?: HeadersInit;
  /** Wait until Streamable finishes processing the video. */
  waitForReady?: boolean;
  onStatus?: (message: string) => void;
  /** Called as bytes reach S3. */
  onProgress?: (loaded: number, total: number) => void;
  /** Local files at or above this size use S3 multipart upload. Default 32 MiB. */
  multipartThreshold?: number;
  /** Multipart part size in bytes. Default 16 MiB. */
  partSize?: number;
  /** Parallel part uploads. Default 4. */
  concurrency?: number;
}

export interface UploadResult {
  shortcode: string;
  url: string;
}

/** Status codes reported by Streamable: 0 = uploading, 1 = processing, 2 = ready, 3 = error. */
export type VideoStatus = 0 | 1 | 2 | 3;

export interface Video {
  shortcode: string;
  title: string;
  status: VideoStatus;
  url: string;
  labels: { id: number; name: string }[];
  [key: string]: unknown;
}

export interface ListVideosOptions {
  labelId?: string | number;
  search?: string;
  /** Page size. Default 50. */
  count?: number;
  /** 1-based page. Default 1. */
  page?: number;
}

/** What an upload reads from: a local file/Blob, or a remote file fetched range by range. */
type OpenedSource = { name: string; size: number; cleanup?: () => Promise<void> } & (
  | { file: Blob }
  | { ranged: RangeSource }
);

interface ShortcodeResponse {
  shortcode: string;
  url: string;
  bucket: string;
  key: string;
  accelerated: boolean;
  time: number;
  credentials: S3Credentials;
  fields: Record<string, string>;
  options: Record<string, unknown>;
  transcoder_options: Record<string, unknown>;
}

export class StreamableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "StreamableError";
  }
}

export class StreamableClient {
  private cookies = new Map<string, string>();
  /** Account info returned by login(). */
  user: Record<string, any> | null = null;

  constructor(
    private email: string,
    private password: string,
  ) {}

  async login(): Promise<Record<string, any>> {
    const res = await this.request(`${AJAX_HOST}/check`, {
      method: "POST",
      json: { username: this.email, password: this.password },
    });
    const body: any = await res.json();
    if (body.error) throw new StreamableError(`Login failed: ${body.message}`, res.status, body);
    this.user = body;
    return body;
  }

  /**
   * Upload a local file path, an http(s) URL, or a Blob/File.
   *
   * URLs whose server supports Range requests are never fully downloaded: each S3 part is
   * fetched as its own byte range right before it is uploaded. Otherwise the URL is downloaded
   * to a temp file first. (Piping the response stream isn't used because Bun's HTTP clients
   * buffer the whole response regardless of how fast it is read.)
   */
  async upload(source: string | URL | Blob, opts: UploadOptions = {}): Promise<UploadResult> {
    const log = opts.onStatus ?? (() => {});
    if (!this.user) await this.login();

    let input: OpenedSource;
    if (source instanceof Blob) {
      const name = opts.fileName ?? ("name" in source && typeof source.name === "string" ? source.name : "video.mp4");
      input = { file: source, name, size: source.size };
    } else if (isUrl(source)) {
      input = await this.openUrl(new URL(source), new Headers(opts.headers), log);
    } else {
      input = await this.openFile(String(source));
    }
    if (opts.fileName) input.name = opts.fileName;

    try {
      return await this.uploadSource(input, opts, log);
    } finally {
      await input.cleanup?.();
    }
  }

  async listVideos(opts: ListVideosOptions = {}): Promise<{ total: number; videos: Video[] }> {
    if (!this.user) await this.login();
    const query = new URLSearchParams({ count: String(opts.count ?? 50), page: String(opts.page ?? 1) });
    if (opts.labelId) query.set("labels", String(opts.labelId));
    if (opts.search) query.set("search", opts.search);
    const res = await this.request(`${API_HOST}/videos?${query}`);
    return (await res.json()) as { total: number; videos: Video[] };
  }

  /** Permanently deletes a video from the account. */
  async deleteVideo(shortcode: string): Promise<void> {
    if (!this.user) await this.login();
    const res = await this.request(`${API_HOST}/videos/${encodeURIComponent(shortcode)}`, { method: "DELETE" });
    if ((await res.text()).trim() !== "true") throw new StreamableError(`Failed to delete ${shortcode}`);
  }

  /** Public video info. */
  async getVideo(shortcode: string): Promise<Record<string, any>> {
    const res = await fetch(`${PUBLIC_API_HOST}/videos/${encodeURIComponent(shortcode)}`);
    if (!res.ok) throw new StreamableError(`Video lookup failed (${res.status})`, res.status);
    return (await res.json()) as Record<string, any>;
  }

  async waitForReady(shortcode: string, log: (m: string) => void = () => {}, timeoutMs = 15 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const video = await this.getVideo(shortcode).catch(() => null);
      if (video?.status === 2) return video;
      if (video?.status === 3) throw new StreamableError(`Processing failed: ${video.message ?? "unknown"}`);
      log(`Processing… ${video?.percent ?? 0}%`);
      await sleep(3000);
    }
    throw new StreamableError(`Timed out waiting for ${shortcode} to process`);
  }

  private async openFile(filePath: string): Promise<OpenedSource> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new StreamableError(`File not found: ${filePath}`);
    // openAsBlob reads lazily, so slicing it for multipart parts never loads the whole file.
    const file = await openAsBlob(filePath);
    return { file, name: basename(filePath), size: file.size };
  }

  private async openUrl(url: URL, headers: Headers, log: (m: string) => void): Promise<OpenedSource> {
    // Probe with a 1-byte range: a 206 with a total size means parts can be fetched on demand.
    const res = await fetchSource(url, headers, { range: "bytes=0-0" });
    if (!res.ok || !res.body) throw new StreamableError(`Download failed (${res.status}): ${url}`, res.status);

    const name = fileNameFromResponse(res, url);
    const total = Number(res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]);
    if (res.status === 206 && Number.isFinite(total)) {
      await res.body.cancel();
      // Pin the exact version so a change mid-upload is caught. Each part re-requests the
      // original URL, so short-lived signed redirect targets can't expire mid-upload.
      const etag = res.headers.get("etag");
      const validator = (etag && !etag.startsWith("W/") ? etag : null) ?? res.headers.get("last-modified");
      log(`Streaming ${url} via range requests (${(total / 1024 / 1024).toFixed(1)} MB)`);
      return {
        name,
        size: total,
        ranged: { size: total, read: (start, end) => readRange(url, headers, start, end, validator) },
      };
    }

    // 200: the server ignored Range, so this response is the whole file.
    log(`${url} doesn't support range requests, downloading to a temp file first`);
    const tmpPath = join(tmpdir(), `streamable-${randomUUID()}-${name}`);
    const cleanup = () => unlink(tmpPath).catch(() => {});
    try {
      // Manual copy: Bun.write(path, response) hangs on chunked responses.
      const fh = await open(tmpPath, "w");
      try {
        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await fh.write(value);
        }
      } finally {
        await fh.close();
      }
    } catch (err) {
      await cleanup();
      throw err;
    }
    const file = await openAsBlob(tmpPath);
    return { file, name, size: file.size, cleanup };
  }

  private async uploadSource(input: OpenedSource, opts: UploadOptions, log: (m: string) => void) {
    const { name: fileName, size } = input;
    const title = opts.title ?? fileName.replace(/\.[^.]+$/, "");

    const maxSize = this.user!.plan_max_size ? this.user!.plan_max_size * GiB : Infinity;
    if (size > maxSize) {
      throw new StreamableError(
        `File is ${(size / GiB).toFixed(2)} GB but the ${this.user!.plan_name} plan allows ${this.user!.plan_max_size} GB`,
      );
    }

    const query = new URLSearchParams({ size: String(size), version: CLIENT_VERSION });
    if (opts.labelId) query.set("label_id", String(opts.labelId));
    const meta = (await (await this.request(`${API_HOST}/uploads/shortcode?${query}`)).json()) as ShortcodeResponse;
    const { shortcode } = meta;
    log(`Got shortcode ${shortcode}`);

    await this.request(`${API_HOST}/videos/${shortcode}/initialize`, {
      method: "POST",
      json: { original_size: size, original_name: fileName, upload_source: "web", title },
    });

    const multipartOpts = {
      bucket: meta.bucket,
      key: meta.key,
      credentials: meta.credentials,
      accelerated: meta.accelerated,
      serverTime: meta.time,
      partSize: opts.partSize,
      concurrency: opts.concurrency,
      onProgress: opts.onProgress,
    };
    const sizeMb = (size / 1024 / 1024).toFixed(1);
    if ("ranged" in input) {
      log(`Uploading ${fileName} (${sizeMb} MB) to S3 via multipart`);
      await multipartUpload(input.ranged, multipartOpts);
    } else if (size >= (opts.multipartThreshold ?? 32 * 1024 * 1024)) {
      const { file } = input;
      log(`Uploading ${fileName} (${sizeMb} MB) to S3 via multipart`);
      try {
        await multipartUpload(file, multipartOpts);
      } catch (err) {
        if (file.size > MAX_FORM_POST_SIZE) throw err;
        log(`Multipart upload failed (${(err as Error).message}), retrying as a single POST`);
        await this.formPostUpload(file, fileName, meta, opts.onProgress);
      }
    } else {
      log(`Uploading ${fileName} (${sizeMb} MB) to S3`);
      await this.formPostUpload(input.file, fileName, meta, opts.onProgress);
    }

    log("Starting transcode");
    await this.request(`${API_HOST}/transcode/${shortcode}`, {
      method: "POST",
      json: { upload_source: "web", title, ...meta.transcoder_options },
    });

    const result = { shortcode, url: `https://streamable.com/${shortcode}` };
    if (opts.waitForReady) await this.waitForReady(shortcode, log);
    return result;
  }

  private async formPostUpload(
    file: Blob,
    fileName: string,
    meta: ShortcodeResponse,
    onProgress?: (loaded: number, total: number) => void,
  ) {
    const form = new FormData();
    for (const [k, v] of Object.entries(meta.fields)) form.append(k, v);
    form.append("file", file, fileName);
    // S3 must not receive the Streamable cookies, so use plain fetch here.
    const s3 = await fetch(meta.url, { method: "POST", body: form });
    if (!s3.ok) throw new StreamableError(`S3 upload failed (${s3.status})`, s3.status, await s3.text());
    onProgress?.(file.size, file.size);
  }

  private async request(url: string, init: { method?: string; json?: unknown } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.json !== undefined) headers["content-type"] = "application/json";

    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (!res.ok) {
      const body = await res.text();
      throw new StreamableError(`${init.method ?? "GET"} ${url} failed (${res.status}): ${body}`, res.status, body);
    }
    return res;
  }
}

function isUrl(source: string | URL): boolean {
  return source instanceof URL || /^https?:\/\//i.test(source);
}

/**
 * GET a URL source, following redirects manually so the caller's headers (e.g. an auth token)
 * only go to the original origin. Signed CDN/S3 redirect targets would reject or leak them.
 */
async function fetchSource(url: URL, extra: Headers, base: Record<string, string>): Promise<Response> {
  let current = url;
  for (let hops = 0; hops <= 10; hops++) {
    const headers = new Headers(current.origin === url.origin ? extra : undefined);
    // Ask for the raw bytes so Content-Length / Content-Range match what we read.
    headers.set("accept-encoding", "identity");
    for (const [k, v] of Object.entries(base)) headers.set(k, v);
    const res = await fetch(current, { headers, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    current = new URL(location, current);
  }
  throw new StreamableError(`Too many redirects: ${url}`);
}

async function readRange(
  url: URL,
  extra: Headers,
  start: number,
  end: number,
  validator: string | null,
): Promise<Blob> {
  const base: Record<string, string> = { range: `bytes=${start}-${end - 1}` };
  if (validator) base["if-range"] = validator;
  const res = await fetchSource(url, extra, base);
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new StreamableError(
      res.status === 200
        ? `Source changed during upload (or stopped honoring Range): ${url}`
        : `Range request ${start}-${end - 1} failed (${res.status})`,
      res.status,
    );
  }
  const blob = await res.blob();
  if (blob.size !== end - start) throw new StreamableError(`Range ${start}-${end - 1} returned ${blob.size} bytes`);
  return blob;
}

function fileNameFromResponse(res: Response, url: URL): string {
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) ?? disposition.match(/filename="?([^";]+)"?/i);
  const raw = match?.[1] ?? url.pathname.split("/").pop() ?? "";
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {}
  // Keep it safe to use as a temp file name.
  return name.replace(/[/\\]/g, "_").trim() || "video.mp4";
}

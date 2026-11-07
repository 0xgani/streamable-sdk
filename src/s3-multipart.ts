/**
 * Dependency-free S3 multipart upload (SigV4) for the temporary credentials
 * Streamable hands out in /uploads/shortcode. Each part is read on demand (a slice of a
 * local file, or an HTTP range of a remote one), uploaded concurrently and retried
 * individually, so at most ~concurrency parts are held in memory regardless of file size.
 */
import { createHash, createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  callUploadCallback,
  UploadCallbackError,
  validateMultipartOptions,
  xmlDecode,
  xmlEscape,
} from "./checkpoint.js";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Anything that can return an arbitrary byte range, e.g. a remote file via HTTP Range. */
export interface RangeSource {
  size: number;
  /** Returns bytes [start, end). */
  read(start: number, end: number, signal?: AbortSignal): Promise<Blob>;
}

/** A Blob (e.g. from fs.openAsBlob, read lazily) or a RangeSource. */
export type UploadSource = Blob | RangeSource;

export interface MultipartOptions {
  bucket: string;
  key: string;
  credentials: S3Credentials;
  region?: string;
  accelerated?: boolean;
  /** Server time (unix seconds) used to correct local clock skew. */
  serverTime?: number;
  /** Persist a clock offset, not an old timestamp, when resuming a previously created target. */
  clockOffsetMs?: number;
  /** Bytes per part (min 5 MiB). Grown automatically to stay under 10,000 parts. */
  partSize?: number;
  concurrency?: number;
  retries?: number;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
  /** Supplying this enables durable mode: failures preserve the remote multipart session. */
  onCheckpoint?: (checkpoint: MultipartCheckpoint) => void | Promise<void>;
  resume?: MultipartCheckpoint;
  /** Immutable source identity. Required in durable mode; caller must verify the source bytes. */
  sourceIdentity?: string;
  /** Refresh credentials for this same bucket/key/session, never create a new upload. */
  refreshCredentials?: () => Promise<S3Credentials>;
  /** For storage with nonstandard ETags, prove a missing completing session already completed. */
  verifyCompleted?: (checkpoint: MultipartCheckpoint) => Promise<boolean>;
  onStage?: (
    stage: "uploading" | "completing" | "completed",
  ) => void | Promise<void>;
}

export interface MultipartCheckpoint {
  version: 1;
  bucket: string;
  key: string;
  region: string;
  accelerated: boolean;
  uploadId: string;
  size: number;
  partSize: number;
  sourceIdentity: string;
  clockOffsetMs: number;
  phase: "uploading" | "completing" | "completed";
  parts: { partNumber: number; etag: string; size: number }[];
}

export class MultipartResumeError extends Error {
  constructor(
    readonly code:
      | "invalid-checkpoint"
      | "session-missing"
      | "completion-uncertain"
      | "access-denied",
    readonly status?: number,
  ) {
    super(
      `Multipart resume stopped: ${code}; the SDK did not create a replacement upload`,
    );
    this.name = "MultipartResumeError";
  }
}

class StorageError extends Error {
  constructor(
    readonly status: number,
    readonly storageCode: string,
  ) {
    super(
      `S3 request failed (${status})${storageCode ? `: ${storageCode}` : ""}`,
    );
  }
}

const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

const sha256 = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding as required by SigV4.
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function transport(opts: MultipartOptions) {
  const region = opts.region ?? "us-east-1";
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(opts.bucket) ||
    !/^[a-z0-9-]+$/.test(region) ||
    !opts.key
  )
    throw new MultipartResumeError("invalid-checkpoint");
  const host = `${opts.bucket}.${opts.accelerated ? "s3-accelerate" : region === "us-east-1" ? "s3" : `s3.${region}`}.amazonaws.com`;
  const path = "/" + opts.key.split("/").map(encode).join("/");
  const clockOffset =
    opts.resume?.clockOffsetMs ??
    opts.clockOffsetMs ??
    (opts.serverTime ? opts.serverTime * 1000 - Date.now() : 0);
  let credentials = opts.credentials;
  let renewing: Promise<S3Credentials> | undefined;

  const signedFetch = async (
    method: string,
    query: Record<string, string>,
    body?: Blob | string,
    signal = opts.signal,
    refreshed = false,
  ): Promise<Response> => {
    const requestCredentials = credentials;
    const amzDate = new Date(Date.now() + clockOffset)
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const scope = `${date}/${region}/s3/aws4_request`;
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k]!)}`)
      .join("&");

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      "x-amz-date": amzDate,
    };
    if (credentials.sessionToken)
      headers["x-amz-security-token"] = credentials.sessionToken;
    const signedHeaders = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      signedHeaders.map((h) => `${h}:${headers[h]}\n`).join(""),
      signedHeaders.join(";"),
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join("\n");

    let signingKey = hmac(`AWS4${credentials.secretAccessKey}`, date);
    for (const part of [region, "s3", "aws4_request"])
      signingKey = hmac(signingKey, part);
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");

    const { host: _host, ...sendHeaders } = headers;
    const res = await fetch(`https://${host}${path}?${canonicalQuery}`, {
      method,
      body,
      signal,
      headers: {
        ...sendHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      const code = text.match(/<Code>([A-Za-z0-9]+)<\/Code>/)?.[1] ?? "";
      if (
        res.status === 403 &&
        code === "ExpiredToken" &&
        opts.refreshCredentials &&
        !refreshed
      ) {
        if (credentials !== requestCredentials)
          return signedFetch(method, query, body, signal, true);
        renewing ??= opts.refreshCredentials();
        try {
          credentials = await renewing;
        } finally {
          renewing = undefined;
        }
        return signedFetch(method, query, body, signal, true);
      }
      if (res.status === 403 && opts.onCheckpoint)
        throw new MultipartResumeError("access-denied", 403);
      throw new StorageError(res.status, code);
    }
    return res;
  };
  return signedFetch;
}

/** Explicitly discard a saved session. Ordinary durable failures/cancellation never call this. */
export async function abortMultipartUpload(
  checkpoint: MultipartCheckpoint,
  opts: Pick<MultipartOptions, "credentials" | "signal" | "refreshCredentials">,
) {
  const fetch = transport({ ...checkpoint, ...opts });
  try {
    await fetch("DELETE", { uploadId: checkpoint.uploadId });
  } catch (error) {
    if (!(error instanceof StorageError && error.status === 404)) throw error;
  }
}

export async function multipartUpload(
  source: UploadSource,
  opts: MultipartOptions,
): Promise<void> {
  const size = source.size;
  validateMultipartOptions(size, opts);
  opts.signal?.throwIfAborted();
  const durable = !!opts.onCheckpoint;
  if (
    (durable &&
      (typeof opts.sourceIdentity !== "string" || !opts.sourceIdentity)) ||
    (opts.resume && !durable)
  )
    throw new MultipartResumeError("invalid-checkpoint");
  const signedFetch = transport(opts);
  const controller = new AbortController();
  const cancel = () => controller.abort(opts.signal!.reason);
  const retries = opts.retries ?? 5;

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        controller.signal.throwIfAborted();
        const status = (err as { status?: number })?.status;
        if (
          attempt >= retries ||
          err instanceof UploadCallbackError ||
          err instanceof MultipartResumeError ||
          (typeof status === "number" &&
            status < 500 &&
            ![408, 429].includes(status))
        )
          throw err;
        await sleep(1000 * 2 ** attempt, undefined, {
          signal: controller.signal,
        });
      }
    }
  };

  const partSize =
    opts.resume?.partSize ??
    Math.max(
      opts.partSize ?? 16 * 1024 * 1024,
      MIN_PART_SIZE,
      Math.ceil(size / MAX_PARTS),
    );
  const partCount = Math.max(1, Math.ceil(size / partSize));
  if (partSize > 5 * 1024 ** 3 || partCount > MAX_PARTS)
    throw new RangeError(
      "Source exceeds multipart part-count/part-size limits",
    );
  const readPart = (start: number, end: number) =>
    source instanceof Blob
      ? Promise.resolve(source.slice(start, end))
      : withRetry(() => source.read(start, end, controller.signal));
  let checkpoint: MultipartCheckpoint | undefined;
  let saves = Promise.resolve();
  const save = () => {
    // Snapshot inside the serialized queue, so simultaneous part acknowledgements cannot
    // overwrite a newer checkpoint with an older one. Stop all further writes on failure.
    saves = saves.then(() =>
      callUploadCallback(
        "checkpoint",
        opts.onCheckpoint,
        structuredClone(checkpoint!),
      ),
    );
    return saves;
  };
  const verifyCompletion = async () => {
    if (
      opts.verifyCompleted &&
      (await opts.verifyCompleted(structuredClone(checkpoint!)))
    )
      return true;
    const parts = checkpoint!.parts;
    if (
      parts.length !== partCount ||
      parts.some((p) => !/^"?[a-f0-9]{32}"?$/i.test(p.etag))
    )
      return false;
    const digest =
      createHash("md5")
        .update(
          Buffer.concat(
            parts.map((p) => Buffer.from(p.etag.replaceAll('"', ""), "hex")),
          ),
        )
        .digest("hex") + `-${partCount}`;
    try {
      const response = await signedFetch(
        "HEAD",
        {},
        undefined,
        controller.signal,
      );
      return (
        response.headers.get("content-length") === String(size) &&
        response.headers.get("etag")?.replaceAll('"', "").toLowerCase() ===
          digest
      );
    } catch {
      return false;
    }
  };
  try {
    opts.signal?.addEventListener("abort", cancel, { once: true });
    opts.signal?.throwIfAborted();
    if (opts.resume) {
      checkpoint = structuredClone(opts.resume);
      if (
        checkpoint.version !== 1 ||
        checkpoint.bucket !== opts.bucket ||
        checkpoint.key !== opts.key ||
        checkpoint.region !== (opts.region ?? "us-east-1") ||
        checkpoint.accelerated !== !!opts.accelerated ||
        checkpoint.size !== size ||
        checkpoint.sourceIdentity !== opts.sourceIdentity ||
        !checkpoint.uploadId ||
        !Number.isFinite(checkpoint.clockOffsetMs) ||
        !Number.isSafeInteger(partSize) ||
        partSize < MIN_PART_SIZE ||
        partSize > 5 * 1024 ** 3 ||
        partCount > MAX_PARTS ||
        !["uploading", "completing", "completed"].includes(checkpoint.phase) ||
        !Array.isArray(checkpoint.parts)
      )
        throw new MultipartResumeError("invalid-checkpoint");
      const seen = new Set<number>();
      for (const part of checkpoint.parts) {
        if (
          !Number.isInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > partCount ||
          seen.has(part.partNumber) ||
          !part.etag ||
          part.size !==
            Math.min(partSize, size - (part.partNumber - 1) * partSize)
        )
          throw new MultipartResumeError("invalid-checkpoint");
        seen.add(part.partNumber);
      }
      checkpoint.parts.sort((a, b) => a.partNumber - b.partNumber);
      if (checkpoint.phase === "completed") {
        if (seen.size !== partCount)
          throw new MultipartResumeError("invalid-checkpoint");
        opts.onProgress?.(size, size);
        return;
      }
      // Reconcile S3, including a PUT accepted immediately before process/persistence failure.
      const remoteParts: MultipartCheckpoint["parts"] = [];
      let marker = 0;
      try {
        for (;;) {
          const response = await withRetry(() =>
            signedFetch(
              "GET",
              {
                uploadId: checkpoint!.uploadId,
                "max-parts": "1000",
                "part-number-marker": String(marker),
              },
              undefined,
              controller.signal,
            ),
          );
          const xml = await response.text();
          if (!xml.includes("<ListPartsResult"))
            throw new MultipartResumeError("invalid-checkpoint");
          for (const match of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
            const block = match[1]!;
            const part = {
              partNumber: Number(
                block.match(/<PartNumber>(\d+)<\/PartNumber>/)?.[1],
              ),
              size: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1]),
              etag: xmlDecode(block.match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? ""),
            };
            if (
              !Number.isInteger(part.partNumber) ||
              part.partNumber <= marker ||
              part.partNumber > partCount ||
              part.size !==
                Math.min(partSize, size - (part.partNumber - 1) * partSize) ||
              !part.etag ||
              remoteParts.some((p) => p.partNumber === part.partNumber)
            )
              throw new MultipartResumeError("invalid-checkpoint");
            const saved = checkpoint.parts.find(
              (p) => p.partNumber === part.partNumber,
            );
            if (saved && saved.etag !== part.etag)
              throw new MultipartResumeError("invalid-checkpoint");
            remoteParts.push(part);
          }
          if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
          const next = Number(
            xml.match(
              /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/,
            )?.[1],
          );
          if (!Number.isInteger(next) || next <= marker || next > MAX_PARTS)
            throw new MultipartResumeError("invalid-checkpoint");
          marker = next;
        }
      } catch (error) {
        if (error instanceof StorageError && error.status === 404) {
          if (checkpoint.phase === "completing" && (await verifyCompletion())) {
            checkpoint.phase = "completed";
            await save();
            opts.onProgress?.(size, size);
            return;
          }
          throw new MultipartResumeError(
            checkpoint.phase === "completing"
              ? "completion-uncertain"
              : "session-missing",
            404,
          );
        }
        throw error;
      }
      checkpoint.parts = remoteParts.sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      checkpoint.phase = "uploading";
      await save();
    } else {
      const created = await withRetry(() =>
        signedFetch("POST", { uploads: "" }, undefined, controller.signal),
      );
      const uploadId = xmlDecode(
        (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1] ??
          "",
      );
      if (!uploadId) throw new Error("S3 did not return an UploadId");
      checkpoint = {
        version: 1,
        bucket: opts.bucket,
        key: opts.key,
        region: opts.region ?? "us-east-1",
        accelerated: !!opts.accelerated,
        uploadId,
        size,
        partSize,
        sourceIdentity: opts.sourceIdentity ?? "",
        clockOffsetMs:
          opts.clockOffsetMs ??
          (opts.serverTime ? opts.serverTime * 1000 - Date.now() : 0),
        phase: "uploading",
        parts: [],
      };
      await save();
    }
    let loaded = checkpoint.parts.reduce((total, part) => total + part.size, 0),
      next = 0;
    let firstError: unknown;
    await callUploadCallback("stage", opts.onStage, "uploading");
    if (durable) opts.onProgress?.(loaded, size);
    const worker = async () => {
      try {
        while (!controller.signal.aborted && next < partCount) {
          const index = next++;
          if (checkpoint!.parts.some((p) => p.partNumber === index + 1))
            continue;
          const start = index * partSize,
            end = Math.min(start + partSize, size);
          const chunk = await readPart(start, end);
          if (chunk.size !== end - start)
            throw new Error("Source returned an incorrect byte range");
          const response = await withRetry(() =>
            signedFetch(
              "PUT",
              { partNumber: String(index + 1), uploadId: checkpoint!.uploadId },
              chunk,
              controller.signal,
            ),
          );
          const etag = response.headers.get("etag");
          if (!etag) throw new Error("S3 returned no ETag for a part");
          checkpoint!.parts.push({
            partNumber: index + 1,
            etag,
            size: chunk.size,
          });
          checkpoint!.parts.sort((a, b) => a.partNumber - b.partNumber);
          await save();
          loaded += chunk.size;
          opts.onProgress?.(loaded, size);
        }
      } catch (error) {
        if (firstError === undefined) firstError = error;
        controller.abort(error);
      }
    };
    await Promise.allSettled(
      Array.from(
        { length: Math.min(opts.concurrency ?? 4, partCount) },
        worker,
      ),
    );
    if (firstError !== undefined) throw firstError;
    controller.signal.throwIfAborted();
    checkpoint.phase = "completing";
    await save();
    await callUploadCallback("stage", opts.onStage, "completing");
    const completeXml =
      "<CompleteMultipartUpload>" +
      checkpoint.parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
        )
        .join("") +
      "</CompleteMultipartUpload>";
    try {
      await withRetry(async () => {
        const response = await signedFetch(
          "POST",
          { uploadId: checkpoint!.uploadId },
          completeXml,
          controller.signal,
        );
        const text = await response.text();
        if (/<Error(?:\s|>)/.test(text))
          throw new StorageError(500, "CompletionError");
        if (!text.includes("<CompleteMultipartUploadResult"))
          throw new StorageError(500, "InvalidCompletionResponse");
      });
    } catch (error) {
      if (!durable || !(await verifyCompletion())) throw error;
    }
    checkpoint.phase = "completed";
    await save();
    await callUploadCallback("stage", opts.onStage, "completed");
  } catch (err) {
    if (!durable && checkpoint)
      await signedFetch(
        "DELETE",
        { uploadId: checkpoint.uploadId },
        undefined,
        opts.signal,
      ).catch(() => {});
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}

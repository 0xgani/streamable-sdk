/**
 * Dependency-free S3 multipart upload (SigV4) for the temporary credentials
 * Streamable hands out in /uploads/shortcode. Each part is read on demand (a slice of a
 * local file, or an HTTP range of a remote one), uploaded concurrently and retried
 * individually, so at most ~concurrency parts are held in memory regardless of file size.
 */
import { createHash, createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Anything that can return an arbitrary byte range, e.g. a remote file via HTTP Range. */
export interface RangeSource {
  size: number;
  /** Returns bytes [start, end). */
  read(start: number, end: number): Promise<Blob>;
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
  /** Bytes per part (min 5 MiB). Grown automatically to stay under 10,000 parts. */
  partSize?: number;
  concurrency?: number;
  retries?: number;
  onProgress?: (loaded: number, total: number) => void;
}

const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding as required by SigV4.
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export async function multipartUpload(source: UploadSource, opts: MultipartOptions): Promise<void> {
  const size = source.size;
  const region = opts.region ?? "us-east-1";
  const host = `${opts.bucket}.${opts.accelerated ? "s3-accelerate" : "s3"}.amazonaws.com`;
  const path = "/" + opts.key.split("/").map(encode).join("/");
  const clockOffset = opts.serverTime ? opts.serverTime * 1000 - Date.now() : 0;
  const retries = opts.retries ?? 5;

  const signedFetch = async (
    method: string,
    query: Record<string, string>,
    body?: Blob | string,
  ): Promise<Response> => {
    const amzDate = new Date(Date.now() + clockOffset).toISOString().replace(/[:-]|\.\d{3}/g, "");
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
    if (opts.credentials.sessionToken) headers["x-amz-security-token"] = opts.credentials.sessionToken;
    const signedHeaders = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      signedHeaders.map((h) => `${h}:${headers[h]}\n`).join(""),
      signedHeaders.join(";"),
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");

    let signingKey = hmac(`AWS4${opts.credentials.secretAccessKey}`, date);
    for (const part of [region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const { host: _host, ...sendHeaders } = headers;
    const res = await fetch(`https://${host}${path}?${canonicalQuery}`, {
      method,
      body,
      headers: {
        ...sendHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
      },
    });
    if (!res.ok) throw new Error(`S3 ${method} ${opts.key} failed (${res.status}): ${await res.text()}`);
    return res;
  };

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(1000 * 2 ** attempt);
      }
    }
  };

  const partSize = Math.max(opts.partSize ?? 16 * 1024 * 1024, MIN_PART_SIZE, Math.ceil(size / MAX_PARTS));
  const partCount = Math.max(1, Math.ceil(size / partSize));
  const readPart = (start: number, end: number) =>
    source instanceof Blob ? Promise.resolve(source.slice(start, end)) : withRetry(() => source.read(start, end));

  const created = await withRetry(() => signedFetch("POST", { uploads: "" }));
  const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error("S3 did not return an UploadId");

  const etags = new Array<string>(partCount);
  let loaded = 0;
  let next = 0;
  let failed = false;

  // A part is only read once a worker is free to upload it, which bounds memory use.
  const worker = async () => {
    while (!failed && next < partCount) {
      const index = next++;
      const start = index * partSize;
      const chunk = await readPart(start, Math.min(start + partSize, size));
      const res = await withRetry(() =>
        signedFetch("PUT", { partNumber: String(index + 1), uploadId }, chunk),
      );
      const etag = res.headers.get("etag");
      if (!etag) throw new Error(`S3 returned no ETag for part ${index + 1}`);
      etags[index] = etag;
      loaded += chunk.size;
      opts.onProgress?.(loaded, size);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(opts.concurrency ?? 4, partCount) }, () =>
        worker().catch((err) => {
          failed = true;
          throw err;
        }),
      ),
    );
    const completeXml =
      "<CompleteMultipartUpload>" +
      etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const completed = await withRetry(() => signedFetch("POST", { uploadId }, completeXml));
    // S3 can answer 200 with an <Error> body for CompleteMultipartUpload.
    const text = await completed.text();
    if (text.includes("<Error>")) throw new Error(`S3 CompleteMultipartUpload failed: ${text}`);
  } catch (err) {
    await signedFetch("DELETE", { uploadId }).catch(() => {});
    throw err;
  }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const fakeCredentials = {
  accessKeyId: "FAKE_ACCESS",
  secretAccessKey: "FAKE_SECRET",
  sessionToken: "FAKE_SESSION",
};
export const makeState = () => ({
  creates: 0,
  initiates: 0,
  initializes: 0,
  transcodes: 0,
  puts: [],
  deletes: 0,
  lists: [],
  sessions: {},
  object: null,
  remoteStatus: 0,
});
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
export function mockService(state, options = {}, persist = () => {}) {
  const fakeFetch = async (input, init = {}) => {
    const url = new URL(String(input)),
      method = init.method || "GET";
    init.signal?.throwIfAborted();
    if (url.hostname === "ajax.streamable.com") {
      assert.deepEqual(JSON.parse(init.body), {
        username: "fixture@example.invalid",
        password: "FAKE_PASSWORD",
      });
      return Response.json(
        { plan_max_size: 100 },
        { headers: { "set-cookie": "session=FAKE_COOKIE; Path=/" } },
      );
    }
    if (url.hostname === "source.example") {
      const bytes = options.source ?? new Uint8Array(12 * 1024 ** 2);
      const range = new Headers(init.headers)
        .get("range")
        ?.match(/bytes=(\d+)-(\d+)/);
      if (options.noRanges || !range)
        return new Response(bytes, { headers: { etag: '"fixture-source"' } });
      const start = Number(range[1]),
        end = Number(range[2]);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${bytes.length}`,
          etag: '"fixture-source"',
        },
      });
    }
    if (url.hostname === "api.streamable.com") {
      if (options.lookupFailure) throw new Error("fixture status unavailable");
      return Response.json({ status: state.remoteStatus });
    }
    if (url.hostname === "api-f.streamable.com") {
      if (url.pathname.endsWith("/uploads/shortcode")) {
        state.creates++;
        persist();
        return Response.json({
          shortcode: "fixtureVideo",
          bucket: "fixture-bucket",
          key: "fixture-object",
          credentials: fakeCredentials,
          accelerated: false,
          transcoder_options: { fixture: true },
          fields: {},
          url: "https://fixture-bucket.s3.amazonaws.com/form",
        });
      }
      if (url.pathname.endsWith("/initialize")) {
        state.initializes++;
        persist();
        return Response.json({});
      }
      if (url.pathname.includes("/transcode/")) {
        state.transcodes++;
        if (!options.rejectTranscode)
          state.remoteStatus = options.readyOnTranscode ? 2 : 1;
        persist();
        if (options.loseTranscodeResponse || options.rejectTranscode)
          throw new Error("fixture lost processing response");
        return Response.json({});
      }
    }
    if (url.hostname === "fixture-bucket.s3.amazonaws.com") {
      if (
        (options.expired || (options.expiredOnPut && method === "PUT")) &&
        !new Headers(init.headers)
          .get("authorization")
          ?.includes("RENEWED_ACCESS")
      )
        return new Response("<Error><Code>ExpiredToken</Code></Error>", {
          status: 403,
        });
      if (url.searchParams.has("uploads")) {
        const uploadId = `upload${++state.initiates}`;
        state.sessions[uploadId] = {};
        persist();
        return new Response(
          `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (init.body instanceof FormData) {
        const file = init.body.get("file");
        assert.ok(file instanceof Blob);
        state.object = {
          size: file.size,
          etag: `"${md5(Buffer.from(await file.arrayBuffer()))}"`,
        };
        persist();
        return new Response(null, { status: 204 });
      }
      const id = url.searchParams.get("uploadId"),
        session = state.sessions[id];
      if (method === "HEAD")
        return state.object
          ? new Response(null, {
              headers: {
                "content-length": String(state.object.size),
                etag: state.object.etag,
              },
            })
          : new Response(null, { status: 404 });
      if (method === "DELETE") {
        state.deletes++;
        delete state.sessions[id];
        persist();
        return new Response(null, { status: 204 });
      }
      if (!session)
        return new Response("<Error><Code>NoSuchUpload</Code></Error>", {
          status: 404,
        });
      if (method === "GET") {
        const marker = Number(url.searchParams.get("part-number-marker") || 0);
        state.lists.push(marker);
        persist();
        const parts = Object.entries(session)
          .map(([n, p]) => ({ partNumber: Number(n), ...p }))
          .filter((p) => p.partNumber > marker)
          .sort((a, b) => a.partNumber - b.partNumber);
        const page = parts.slice(0, options.pageSize ?? 1000),
          truncated = page.length < parts.length;
        const xml = page
          .map(
            (p) =>
              `<Part><PartNumber>${p.partNumber}</PartNumber><Size>${p.size}</Size><ETag>&quot;${p.md5}&quot;</ETag></Part>`,
          )
          .join("");
        return new Response(
          `<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextPartNumberMarker>${page.at(-1).partNumber}</NextPartNumberMarker>` : ""}${xml}</ListPartsResult>`,
        );
      }
      if (method === "PUT") {
        const n = Number(url.searchParams.get("partNumber"));
        state.puts.push(n);
        persist();
        if (options.hangPart === n)
          return new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("fixture stalled part")),
              60000,
            );
            init.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal.reason);
              },
              { once: true },
            );
          });
        if (options.failPart === n)
          throw new Error("fixture network disconnected");
        const bytes = Buffer.from(await init.body.arrayBuffer());
        session[n] = { size: bytes.length, md5: md5(bytes) };
        persist();
        if (options.losePartResponse === n)
          throw new Error("fixture part response lost");
        return new Response(null, { headers: { etag: `"${session[n].md5}"` } });
      }
      if (method === "POST") {
        assert.ok(init.body.startsWith("<CompleteMultipartUpload>"));
        if (options.embeddedError)
          return new Response("<Error><Code>InternalError</Code></Error>");
        const parts = Object.entries(session)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([_, p]) => p);
        state.object = {
          size: parts.reduce((sum, p) => sum + p.size, 0),
          etag: `"${md5(Buffer.concat(parts.map((p) => Buffer.from(p.md5, "hex"))))}-${parts.length}"`,
        };
        delete state.sessions[id];
        persist();
        if (options.loseCompletionResponse)
          throw new Error("fixture completion response lost");
        return new Response(
          `<CompleteMultipartUploadResult><ETag>${state.object.etag}</ETag></CompleteMultipartUploadResult>`,
        );
      }
    }
    throw new Error("Offline fake service received an unexpected request");
  };
  fakeFetch[Symbol.for("streamable-sdk.offline-test-fetch")] = true;
  return fakeFetch;
}

// Separate-process/CLI tests use only these fixture files and fake credentials.
if (process.env.SDK_FIXTURE_STATE) {
  const path = process.env.SDK_FIXTURE_STATE;
  const state = JSON.parse(readFileSync(path, "utf8"));
  const options = JSON.parse(process.env.SDK_FIXTURE_OPTIONS || "{}");
  globalThis.fetch = mockService(state, options, () =>
    writeFileSync(path, JSON.stringify(state)),
  );
}

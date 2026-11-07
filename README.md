# streamable-sdk

Upload and download [Streamable](https://streamable.com) videos. Uploads use your own account: local files or URLs, any size,
straight into a label (folder). It uses plain HTTP requests (no headless browser) and has no runtime
dependencies.

- **CLI** you can run with `npx`
- **Typed SDK** (ESM + CommonJS, bundled `.d.ts`)
- Runs on **Node.js ≥ 20** and **Bun**
- Large files go up as parallel **S3 multipart** uploads, and each failed part is retried on its own
- **URLs are streamed** using HTTP Range requests, so the file is never fully downloaded or held in memory

## CLI

```bash
npx streamable-sdk upload ./video.mp4 --label 182334 --title "My video"
npx streamable-sdk upload https://example.com/video.mp4
npx streamable-sdk upload "$ZOOM_DOWNLOAD_URL" -H "Authorization: Bearer $ZOOM_DOWNLOAD_TOKEN"
npx streamable-sdk list --label 182334
npx streamable-sdk delete abc123 def456
npx streamable-sdk download https://streamable.com/abc123 -o ./videos/
```

The video URL is the only thing printed to stdout, so it's easy to use in scripts:

```bash
url=$(npx streamable-sdk upload ./clip.mp4 --no-wait)
```

Progress and status go to stderr.

### Credentials

`download` works for any public video and needs no credentials. Everything else does. Pass them as flags or environment variables. A `.env` file in the current directory is loaded automatically
(see [`.env.example`](.env.example)). Flags take precedence over the environment.

| Flag         | Environment variable                |
| ------------ | ----------------------------------- |
| `--email`    | `STREAMABLE_EMAIL` or `EMAIL`       |
| `--password` | `STREAMABLE_PASSWORD` or `PASSWORD` |
| `--label`    | `STREAMABLE_LABEL_ID` or `LABEL_ID` |

The label id is the number in the dashboard URL when you open a label.

### Upload options

| Option                           | Default   | Description                                                                               |
| -------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `--title <title>`                | file name | Video title                                                                               |
| `-H, --header "Name: value"`     |           | HTTP header for downloading a URL source; repeat the flag for more than one               |
| `--no-wait`                      | off       | Return as soon as the upload finishes, without waiting for processing                     |
| `--processing-timeout <seconds>` | 900       | Processing wait deadline; `0` waits without a deadline. Ignored with `--no-wait`          |
| `--part-size <MiB>`              | 16        | Multipart part size                                                                       |
| `--concurrency <n>`              | 4         | Parallel part uploads                                                                     |
| `--multipart-threshold <MiB>`    | 32        | Local files at or above this size use multipart                                           |
| `--checkpoint <file>`            | off       | Persist/resume this same upload across process restarts; forces multipart                 |
| `--retry-processing`             | off       | Explicitly retry an uncertain processing POST on the saved video; requires `--checkpoint` |
| `--json-stages`                  | off       | Structured lifecycle events on stderr instead of human progress                           |
| `--part-retries <n>`             | 5         | Retries per multipart part; `0` disables in-call retries                                  |

### Download options

| Option                       | Default           | Description                                            |
| ---------------------------- | ----------------- | ------------------------------------------------------ |
| `-o, --output <file-or-dir>` | `<shortcode>.mp4` | Where to save; a directory keeps the default file name |
| `--format <name>`            | `mp4`             | Rendition, e.g. `mp4-mobile` when the video has one    |

## SDK

```bash
npm install streamable-sdk
```

```ts
import { StreamableClient } from "streamable-sdk";

const client = new StreamableClient(
  process.env.STREAMABLE_EMAIL!,
  process.env.STREAMABLE_PASSWORD!,
);

const { shortcode, url } = await client.upload("./video.mp4", {
  labelId: 182334,
  title: "My video",
  waitForReady: true, // resolve once Streamable has finished processing
  onProgress: (loaded, total) =>
    console.log(`${((loaded / total) * 100).toFixed(0)}%`),
  onStatus: (message) => console.log(message),
});
```

`upload()` accepts a **file path**, an **`http(s)://` URL** (string or `URL`), a **`Blob`/`File`**, or a
custom **`RangeSource`** with a known size and repeatable byte reads.
It logs in on first use; call `await client.login()` yourself to fail early on bad credentials.

### API

| Method                                                      | Description                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login({ signal? }?)`                                       | Signs in and returns the account info (also available as `client.user` afterwards)                                                                       |
| `upload(source, options?)`                                  | Uploads a file and returns `{ shortcode, url }`                                                                                                          |
| `listVideos({ labelId?, search?, count?, page? })`          | Returns `{ total, videos }` for the account, optionally filtered by label                                                                                |
| `deleteVideo(shortcode)`                                    | Permanently deletes a video                                                                                                                              |
| `getVideo(shortcode, { signal? }?)`                         | Public video info, including `status` (1 processing, 2 ready, 3 error); supports cancelling the request                                                  |
| `download(shortcodeOrUrl, dest?, { format?, onProgress? })` | Saves a public video's MP4 and returns `{ path, size }`; no login needed                                                                                 |
| `waitForReady(shortcode, log?, timeoutMsOrOptions?)`        | Polls until ready; accepts the legacy timeout in milliseconds or `{ timeoutMs, signal, pollIntervalMs }`. Default timeout 15 minutes; `null` disables it |

`UploadOptions`: `labelId`, `title`, `fileName`, `headers`, `waitForReady`, `processing`, `onStatus`, `onProgress`,
`multipartThreshold`, `partSize`, `concurrency`, `retries`, `signal`, `onStage`, `resume`.

### Durable resume and structured stages

Durable uploads are opt-in and application-independent. Use a JSON checkpoint in your database/queue,
or the optional atomic file adapter:

```ts
import { StreamableClient, withCheckpointFile } from "streamable-sdk";

const client = new StreamableClient(
  process.env.STREAMABLE_EMAIL!,
  process.env.STREAMABLE_PASSWORD!,
);
await withCheckpointFile("./private/upload.json", (resume) =>
  client.upload("./video.mp4", {
    resume,
    waitForReady: false,
    onStage: async (event) => {
      console.log(event);
    },
  }),
);
```

Repeat with the same source/checkpoint to resume the same video and multipart upload ID. Completed
parts are reconciled with S3, including lost acknowledgements. Durable mode keeps unfinished sessions
and never falls back to an unrelated form POST. It verifies source content with SHA-256 and refuses
silent replacement when a session is missing or processing acceptance is uncertain. Checkpoints are
**sensitive** (temporary credentials); stage events contain only safe lifecycle metadata.

Existing uploads retain their defaults. `onStage` also works without durability, and `onStatus` text
and byte progress callbacks remain available. See the [durable upload guide](docs/durable-uploads.md)
for source types, database/CLI examples, locking, cancellation, provider credential renewal, explicit
abort, error types, cost/permission limitations, and the boundary between upload and processing.
Exactly-once remote creation and live provider permission grants are not guaranteed.

### Long processing jobs and resumable checks

Upload completion and video readiness are separate events. A long video can finish uploading and
still need more than 15 minutes to process. A processing timeout means readiness was not confirmed;
it does **not** mean the upload failed, and must not trigger a new upload.

Existing behavior is preserved: `waitForReady()` defaults to 15 minutes, and numeric third arguments
are milliseconds. To wait without a deadline, pass `null`, or use the options object:

```ts
const controller = new AbortController();
await client.waitForReady(shortcode, console.error, {
  timeoutMs: null, // no overall deadline
  signal: controller.signal,
  pollIntervalMs: 3000,
});
// Call controller.abort() from your shutdown/cancel handler to stop waiting.
```

The same settings are available when uploading:

```ts
await client.upload("./long-recording.mp4", {
  waitForReady: true,
  processing: { timeoutMs: null, signal: controller.signal },
});
```

`processing` applies only when `waitForReady: true`. Its signal cancels the processing wait, not the
preceding upload. Cancellation never deletes the remote video. A finite deadline covers status
requests (including response bodies) and polling delays; it aborts an in-flight status request.
`timeoutMs: 0` expires immediately; use `null` to disable the deadline. Timeouts must be finite
nonnegative milliseconds up to 2147483647, or `null`. Poll intervals must be positive finite
milliseconds up to the same maximum. Invalid settings are rejected before upload starts.

For persistent services, prefer saving the upload result before checking readiness:

```ts
const uploaded = await client.upload("./long-recording.mp4", {
  waitForReady: false,
});
// Persist uploaded.shortcode and uploaded.url in your application's database here.
// On restart, read that record and resume checks; do not call upload() again.
try {
  await client.waitForReady(uploaded.shortcode, console.error, {
    timeoutMs: 60 * 60_000,
  });
} catch (error) {
  if (error instanceof ProcessingTimeoutError) {
    // Keep the saved job pending and schedule another check of error.shortcode.
  } else {
    throw error;
  }
}
```

Import `ProcessingTimeoutError` and `ProcessingError` from `streamable-sdk`. Both extend
`StreamableError` and contain `shortcode` and `url`. `ProcessingTimeoutError` also contains
`lastStatus` (the last observed numeric status, or `null` if none was obtained).
`ProcessingError` means Streamable explicitly returned status `3`. Temporary lookup failures are
retried and reported as unavailable, rather than as 0% processing. Aborting the wait throws the
caller's abort reason. Unknown statuses keep waiting. You can also schedule individual
`getVideo(shortcode, { signal })` checks yourself: status `2` is ready, status `3` is a failure,
and a failed lookup leaves readiness unknown.

CLI equivalents (seconds, unlike the SDK's milliseconds):

```sh
streamable-sdk upload ./long-recording.mp4 --processing-timeout 3600
streamable-sdk upload ./long-recording.mp4 --processing-timeout 0
streamable-sdk upload ./long-recording.mp4 --no-wait
```

The CLI still exits nonzero on timeout, but prints the saved URL and explains that the upload
succeeded and processing remains unconfirmed. `--no-wait` returns the URL immediately after upload
and ignores the processing deadline. Unlimited waits can continue indefinitely if a video never
becomes ready; use cancellation or durable scheduled checks when appropriate.

### Development and validation

Run `bun install --frozen-lockfile`, `bun run typecheck`, and `bun run test`. Tests build the package
and use Node's test runner with mocked HTTP requests and fake credentials, without accessing a real
Streamable account. A network guard blocks unmatched external fetches and is inherited by spawned tests.
They cover timeout recovery, unlimited/cancellable waits, hung lookups, explicit processing failure,
option validation, upload integration, and CLI help/validation. Runtime source uses Web/Node APIs
only and remains compatible with Node.js >= 20 and Bun. Resume tests include pagination, persistence
failures, callback barriers, changed sources, expired credentials and a hard-killed CLI process that
resumes from its saved parts. These offline tests do not prove every live provider permission grant.

### Authenticated URLs (e.g. Zoom recordings)

Use `headers` (CLI: `-H`) to send a token or cookie when downloading a URL source. For Zoom, pass the
recording's `download_token` (from the `recording.completed` webhook) or an OAuth access token as a bearer token:

```ts
await client.upload(recording.download_url, {
  headers: { Authorization: `Bearer ${downloadToken}` },
  title: recording.topic,
});
```

Your headers are only sent to the URL's own origin. Redirects are followed manually, and the headers are
dropped when a redirect points to another host, such as the signed CDN/S3 link Zoom redirects to. That keeps the
token from leaking, and S3 would reject the extra `Authorization` header anyway. Every part re-requests the
original URL, so a short-lived signed redirect can't expire partway through a long upload.

Errors are thrown as `StreamableError`, with the HTTP `status` and response `body` when there is one.

The low-level `multipartUpload(source, options)` is exported too, along with the `RangeSource`
interface, in case you want to feed parts from your own storage.

## How large files and URLs are handled

- **Local files** below 32 MiB are uploaded in a single presigned POST. Larger files use an S3 multipart upload,
  signed with the temporary AWS credentials Streamable issues for each upload. Parts are read from disk lazily
  (`fs.openAsBlob`), so memory stays flat whatever the file size. Up to 4 parts upload at a time, each one is
  retried up to 5 times with backoff, and the multipart upload is aborted on S3 if it can't finish unless
  durable `resume` is enabled. In ordinary (non-durable) mode, if multipart
  fails for a file up to 5 GB, the client falls back to the single POST, which is what the Streamable web app
  does too.
- **URLs whose server supports Range requests** (most CDNs, S3/GCS and static file servers) are never fully
  downloaded. Each part is fetched as its own byte range just before it is uploaded, so downloads also run in
  parallel and a failed range is retried by itself. `If-Range` (ETag or Last-Modified) aborts the upload if the
  remote file changes partway through. Peak memory measured about 200–270 MB for both 206 MB and 650 MB files.
- **URLs without Range support** are downloaded to a temp file first, uploaded from there, then deleted.

The file size is checked against your plan's limit (`plan_max_size`; the Free plan allows 0.25 GB) before
anything is uploaded.

## How it works

These are the same requests streamable.com's web uploader makes:

1. `POST https://ajax.streamable.com/check` with `{ username, password }` sets the session cookies
2. `GET https://api-f.streamable.com/api/v1/uploads/shortcode?size=…&version=unknown&label_id=…` returns the
   shortcode, temporary S3 credentials and presigned POST fields. The label is assigned here.
3. `POST /api/v1/videos/:shortcode/initialize` sends the name, size and title
4. The file is uploaded to S3, either as a multipart upload or as a single presigned POST
5. `POST /api/v1/transcode/:shortcode` with the returned `transcoder_options` starts processing
6. `GET https://api.streamable.com/videos/:shortcode` is polled until `status === 2`

This is an unofficial client built on Streamable's private web API, which can change without notice.

## Development

```bash
bun install
bun run dev upload ./video.mp4   # run the CLI from source
bun run typecheck
bun run build                    # dist/: ESM, CJS, .d.ts, and the CLI
```

## Releasing

npm releases are published by GitHub Actions ([`.github/workflows/publish.yml`](.github/workflows/publish.yml))
using npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token or 2FA code is
needed. Each release also gets a provenance attestation.

```bash
npm version patch            # bumps package.json, commits, and tags vX.Y.Z
git push --follow-tags       # the tag push triggers the publish workflow
```

The workflow fails if the tag doesn't match the `version` in `package.json`.

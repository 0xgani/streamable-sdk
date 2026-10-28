# streamable-uploader

Upload videos to [Streamable](https://streamable.com) with your own account: local files or URLs, any size,
straight into a label (folder). It uses plain HTTP requests (no headless browser) and has no runtime
dependencies.

- **CLI** you can run with `npx`
- **Typed SDK** (ESM + CommonJS, bundled `.d.ts`)
- Runs on **Node.js ≥ 20** and **Bun**
- Large files go up as parallel **S3 multipart** uploads, and each failed part is retried on its own
- **URLs are streamed** using HTTP Range requests, so the file is never fully downloaded or held in memory

## CLI

```bash
npx streamable-uploader upload ./video.mp4 --label 182334 --title "My video"
npx streamable-uploader upload https://example.com/video.mp4
npx streamable-uploader upload "$ZOOM_DOWNLOAD_URL" -H "Authorization: Bearer $ZOOM_DOWNLOAD_TOKEN"
npx streamable-uploader list --label 182334
npx streamable-uploader delete abc123 def456
```

The video URL is the only thing printed to stdout, so it's easy to use in scripts:

```bash
url=$(npx streamable-uploader upload ./clip.mp4 --no-wait)
```

Progress and status go to stderr.

### Credentials

Pass them as flags or environment variables. A `.env` file in the current directory is loaded automatically
(see [`.env.example`](.env.example)). Flags take precedence over the environment.

| Flag         | Environment variable                    |
| ------------ | --------------------------------------- |
| `--email`    | `STREAMABLE_EMAIL` or `EMAIL`           |
| `--password` | `STREAMABLE_PASSWORD` or `PASSWORD`     |
| `--label`    | `STREAMABLE_LABEL_ID` or `LABEL_ID`     |

The label id is the number in the dashboard URL when you open a label.

### Upload options

| Option                        | Default    | Description                                     |
| ----------------------------- | ---------- | ----------------------------------------------- |
| `--title <title>`             | file name  | Video title                                     |
| `-H, --header "Name: value"`  |            | HTTP header for downloading a URL source; repeat the flag for more than one |
| `--no-wait`                   | off        | Return as soon as the upload finishes, without waiting for processing |
| `--part-size <MiB>`           | 16         | Multipart part size                             |
| `--concurrency <n>`           | 4          | Parallel part uploads                           |
| `--multipart-threshold <MiB>` | 32         | Local files at or above this size use multipart |

## SDK

```bash
npm install streamable-uploader
```

```ts
import { StreamableClient } from "streamable-uploader";

const client = new StreamableClient(process.env.STREAMABLE_EMAIL!, process.env.STREAMABLE_PASSWORD!);

const { shortcode, url } = await client.upload("./video.mp4", {
  labelId: 182334,
  title: "My video",
  waitForReady: true, // resolve once Streamable has finished processing
  onProgress: (loaded, total) => console.log(`${((loaded / total) * 100).toFixed(0)}%`),
  onStatus: (message) => console.log(message),
});
```

`upload()` accepts a **file path**, an **`http(s)://` URL** (string or `URL`), or a **`Blob`/`File`**.
It logs in on first use; call `await client.login()` yourself to fail early on bad credentials.

### API

| Method | Description |
| --- | --- |
| `login()` | Signs in and returns the account info (also available as `client.user` afterwards) |
| `upload(source, options?)` | Uploads a file and returns `{ shortcode, url }` |
| `listVideos({ labelId?, search?, count?, page? })` | Returns `{ total, videos }` for the account, optionally filtered by label |
| `deleteVideo(shortcode)` | Permanently deletes a video |
| `getVideo(shortcode)` | Public video info, including `status` (1 processing, 2 ready, 3 error) |
| `waitForReady(shortcode, log?, timeoutMs?)` | Polls until the video is ready (default timeout 15 min) |

`UploadOptions`: `labelId`, `title`, `fileName`, `headers`, `waitForReady`, `onStatus`, `onProgress`,
`multipartThreshold`, `partSize`, `concurrency`.

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
  retried up to 5 times with backoff, and the multipart upload is aborted on S3 if it can't finish. If multipart
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

# Durable uploads and structured stages

Durability is opt-in. Existing `upload(source, options)` calls keep their small-file form POST,
multipart threshold, status text and fallback behavior. Adding `resume: { save }` forces multipart
even for small files, preserves interrupted sessions, and disables single-POST fallback. No runtime
dependency, database, Zoom integration, background worker or application-specific policy is required.
This SDK targets Node.js >= 20 and Bun, not browser runtimes.

## Choose your persistence

For a local program or CLI, the optional file adapter provides an exclusive lock and atomic writes:

```ts
import { StreamableClient, withCheckpointFile } from "streamable-sdk";

const client = new StreamableClient(
  process.env.STREAMABLE_EMAIL!,
  process.env.STREAMABLE_PASSWORD!,
);
const result = await withCheckpointFile("./private/upload.json", (resume) =>
  client.upload("./recording.mp4", {
    resume,
    waitForReady: false,
    partSize: 16 * 1024 ** 2,
    concurrency: 4,
    retries: 5,
    onStage: async (event) => {
      console.log(event);
    },
  }),
);
```

Run the same operation again with the same source and checkpoint to resume. Create the private parent
directory first. The adapter writes a temporary file with POSIX mode 0600, fsyncs its contents and
renames it over the checkpoint. On Windows, protect the directory with the appropriate account ACL;
POSIX mode is not an encryption or Windows ACL guarantee. The adapter's `.lock` file is removed on
normal success/failure. After a hard kill, verify the old process is dead before manually removing a
stale lock. Never clear a lock merely because a job is slow. Atomic replacement protects against torn
writes; it is not a guarantee against every filesystem/hardware power-loss mode.

For a database, job queue or serverless worker, supply your own persistence and exclusive job lease:

```ts
// Acquire an exclusive lease for job.id and renew it for the whole call first.
await client.upload(job.source, {
  resume: {
    checkpoint: job.checkpoint ?? undefined,
    save: async (checkpoint) => {
      await jobs.transaction((tx) => tx.saveCheckpoint(job.id, checkpoint));
    },
  },
  signal: controller.signal,
});
```

`save` receives a JSON-serializable `UploadCheckpoint` snapshot. It is awaited before the next remote
step and after acknowledged parts. Writes are serialized, including during credential renewal.
Commit atomically; reject if the lease is lost. If a callback throws after committing, the next call
can reconcile that saved state. Workers settle before the call rejects, so no part checkpoint writes
continue after return. Do not run two owners against the same checkpoint/upload ID: the SDK does not
provide a distributed lock or make concurrent calls safe.

Checkpoints contain temporary S3 **credentials**, object keys, titles and transcoder options. Treat
them as secrets: encrypt/access-control storage and backups, never log them, expose them to clients,
or accept untrusted checkpoint JSON. Stage events are the safe logging interface. File paths/source
URLs/authorization headers are not embedded in a checkpoint; callers supply the source again.

## Sources and identity

Durable mode accepts local paths, `Blob`/`File`, HTTP(S) URLs (with optional download headers), and
custom `RangeSource` objects with a known size and `read(start, end, signal?) => Promise<Blob>`.
`fileName` defaults to `video.mp4` for a custom range source. The source must be immutable throughout
an upload call. Custom readers should honor the supplied signal.

Before a new durable upload and before resuming storage work, the SDK scans the source in bounded
8 MiB reads and computes SHA-256. A different size or content hash stops with `source-changed`, even
if the name and size are unchanged. This deliberately adds a full source read on every such call:
URL sources incur an extra download pass. Remote range validators also protect reads within a call.
For a URL without range support, the SDK buffers it to a temporary file and removes that temporary
file on exit; an expired URL must be renewed or replaced by a retained local copy before resuming.
The SDK does not retain the caller's original source or refresh source-provider tokens.

Resuming must use the same account identity (case-normalized sign-in email), source bytes and video
metadata. Do not change `title`, `fileName`, or `labelId` midway; omit them to use checkpoint values.
The saved multipart part size is authoritative; concurrency and per-part retries can change between
calls. A new version of source content requires a separate upload/checkpoint, chosen explicitly by
the application. Persist the checkpoint until upload confirmation; do not delete source bytes merely
because byte progress reached 100%.

## Reconciliation and uncertain responses

The checkpoint saves the Streamable shortcode, upload phase, storage target, multipart upload ID,
part geometry and acknowledged ETags. On resume, S3 `ListParts` is paginated and reconciled before
skipping parts. This recovers a PUT accepted just before its response or checkpoint was lost. Missing
parts are resent using the same upload ID; a new Streamable video is not allocated.

The SDK saves `completing` before `CompleteMultipartUpload`. HTTP 200 with an embedded S3 error is
not success. If completion was accepted but its response/save was lost, a missing multipart session
can be reconciled using `HEAD`: content length and the expected standard multipart ETag must match.
Storage/encryption modes with nonstandard ETags may supply `resume.verifyCompleted(checkpoint)` to
prove the exact saved object completed; do not return true on a guess. Missing sessions are never
silently replaced. The low-level helper supports general-purpose AWS S3 endpoints (including region
and acceleration), not arbitrary S3-compatible hosts, directory buckets or every encryption mode.
The high-level Streamable target uses its existing us-east-1 bucket contract.

After storage completion, `starting-processing` is saved before the processing POST. A later call
checks the same video: statuses 1/2/3 prove the remote processing request was accepted. A still-
uncertain result stops with `confirmation-pending`; it does not send that POST or create another
video automatically. An application/operator may explicitly set `resume.retryProcessing: true`
after checking the same video. That repeats processing on the same shortcode and may restart its
transcode; it is not an exactly-once operation. A confirmed `uploaded` checkpoint never uploads or
posts processing again.

For `starting-processing` and `uploaded` checkpoints, the source can be `null`:

```ts
await client.upload(null, { resume: { checkpoint, save: persistCheckpoint } });
// Or poll readiness directly using checkpoint.shortcode and client.waitForReady(...).
```

Processing waits/timeouts are independent of upload confirmation. `waitForReady: true` still follows
the configurable processing wait policy. The checkpoint is already `uploaded` before waiting, so a
timeout or readiness failure must not trigger another upload. A source is required for all earlier
phases, including stored-object reconciliation. The same initialization metadata may be posted again
on the same shortcode if its initialization response was lost; the unofficial web API must continue
to permit that metadata operation for this path to work.

## Expiration, retry and cancellation

Temporary S3 credentials can expire while the multipart session still exists. If a provider can renew
access to the **same** bucket/key/session, supply:

```ts
resume: {
  checkpoint,
  save: persistCheckpoint,
  refreshCredentials: async saved => renewForExistingStorageTarget(saved),
}
```

The SDK persists renewed credentials before retrying. Concurrent expiration responses share renewal
work where possible. This is a provider hook, not an invented Streamable refresh endpoint; this
repository has not established that Streamable will grant renewed ListParts/HEAD/part permissions
for every expired session. Without valid access, resume stops with `access-denied` and keeps state.
Session lifecycle policies or an explicit abort can also make resumption impossible. The application
decides whether/when to start a replacement video; the SDK never does that implicitly in durable mode.

`retries` controls transient storage retries within a call (default 5, exponential delay). A durable
call that fails preserves its checkpoint/session; applications choose backoff/scheduling across calls.
`signal` cancels network requests, retry delays, and processing waits. Cancellation preserves durable
state and does not delete the video. Application callbacks and custom range readers must implement
their own timeout/cancellation if they might hang. To explicitly discard unfinished S3 parts:

```ts
import { abortMultipartUpload } from "streamable-sdk";
await abortMultipartUpload(checkpoint.multipart!, {
  credentials: checkpoint.storage.credentials,
});
// Archive/remove the checkpoint only after the intended cleanup succeeds.
```

This aborts multipart storage only; it does not delete the Streamable video or a completed object.
Unfinished parts can incur storage charges, so operators need a cleanup/lifecycle policy. A crash or
lost response before a shortcode or upload ID is persisted can leave an untracked remote resource.
There is no cross-service transaction or exactly-once guarantee, even with durable checkpoints.

## Structured lifecycle callbacks

`onStage(event)` is independent of persistence and works with ordinary uploads too. Its typed stages
are `authenticating`, `opening-source`, `fingerprinting`, `creating-upload`, `initializing`, `uploading`,
`completing-upload`, `storage-complete`, `starting-processing`, `uploaded`, `processing`, and `ready`.
Events contain `stage`, `resumed`, `uploadConfirmed`, and the shortcode/canonical Streamable URL once
available. They never contain signed URLs, credentials, storage keys or filenames. Phases are awaited
before their remote effect; the `uploaded` event is after confirmation, and `ready` is after processing.
Not every protocol/resume path emits every stage: form POSTs have no multipart-completion phase,
already-authenticated clients skip authentication, and confirmed checkpoints skip source/storage.

Use `onProgress` for bytes and `onStage` for lifecycle transitions. Progress during durable resume
starts with bytes reconciled on S3; parallel part completion order is unspecified. `onStatus` remains
available with its original text for backward compatibility, but applications should not parse it for
correctness. A thrown/rejected stage or checkpoint callback produces `UploadCallbackError`, stops
subsequent steps and never triggers a fallback upload. Progress callbacks are synchronous; returning
an unobserved Promise from a void callback does not create a persistence barrier.

## Errors and caller policy

| Error/code                                   | Caller action                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `UploadCallbackError`                        | Fix persistence/logging callback or lease; resume the last atomic checkpoint.                |
| `UploadResumeError: source-changed`          | Restore the exact original bytes or explicitly start a separate upload.                      |
| `UploadResumeError: invalid-checkpoint`      | Investigate incompatible/corrupt state/account/options; do not discard it and retry blindly. |
| `UploadResumeError: confirmation-pending`    | Recheck the same video; only explicitly opt into repeating processing if appropriate.        |
| `MultipartResumeError: session-missing`      | Session expired/aborted; decide on cleanup/replacement outside the SDK.                      |
| `MultipartResumeError: completion-uncertain` | Prove object completion, supply a verifier for nonstandard ETags, or investigate.            |
| `MultipartResumeError: access-denied`        | Obtain valid permissions/credentials for this saved target.                                  |
| Network/storage failure                      | Preserve state/source and retry with application-controlled backoff.                         |
| `ProcessingTimeoutError` / `ProcessingError` | Upload is already confirmed; resume processing checks or report a transcode failure.         |

New upload/checkpoint errors have fixed messages without signed URLs or credentials. Callback errors
retain their original exception in `cause`; legacy `StreamableError.body` can contain provider data.
Do not serialize arbitrary errors or causes into public logs.

## CLI

```sh
streamable-sdk upload ./recording.mp4 --checkpoint ./private/upload.json --no-wait
# Same command resumes, including in another process after a disconnect.
streamable-sdk upload ./recording.mp4 --checkpoint ./private/upload.json --json-stages
streamable-sdk upload ./recording.mp4 --checkpoint ./private/upload.json --retry-processing
```

`--json-stages` writes stage JSON on stderr instead of human progress; the successful result URL stays
alone on stdout. Fatal errors still print a text diagnostic and exit nonzero. `--part-retries 0` disables
in-call storage retry delays; `--part-size` and `--concurrency` still work. SIGINT/SIGTERM cancels the
call and releases the file lock when cleanup can run. Never share a checkpoint path between distinct
videos or concurrently running processes. Checkpoints remain after success so another invocation
can report the same video instead of creating another.

## Validation and limits of testing

`bun run test` builds the package and runs offline tests with a guard rejecting unmatched external
fetches. Tests use fake credentials and mocked HTTP services; process-restart and CLI tests inherit
that guard. Coverage includes supported source types, stage barriers, source/account mismatches,
parallel saves, part reconciliation/pagination, expired credentials, completion uncertainty,
cancellation, private atomic files, and an actual hard-killed process resuming parts. No real
Streamable account is used. Offline tests verify client behavior and do not prove an unofficial
provider's live permission grants or initialization/processing semantics.

References: [S3 ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html),
[CompleteMultipartUpload and embedded errors](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html),
[multipart lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html).

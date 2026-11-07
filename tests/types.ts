// Compile-only examples: this function is never invoked and no credentials are used.
import {
  StreamableClient,
  withCheckpointFile,
  abortMultipartUpload,
  type UploadCheckpoint,
  type UploadStageEvent,
  type RangeSource,
} from "../src/index.js";

export async function typeExamples(
  client: StreamableClient,
  saved: UploadCheckpoint,
  save: (checkpoint: UploadCheckpoint) => Promise<void>,
  reader: RangeSource,
  log: (event: UploadStageEvent) => Promise<void>,
) {
  await client.upload(reader, {
    resume: { checkpoint: saved, save },
    onStage: log,
    signal: new AbortController().signal,
  });
  await client.upload(null, { resume: { checkpoint: saved, save } });
  await withCheckpointFile("private-checkpoint.json", (resume) =>
    client.upload(new Blob(["example"]), { resume }),
  );
  if (saved.multipart)
    await abortMultipartUpload(saved.multipart, {
      credentials: saved.storage.credentials,
    });
}

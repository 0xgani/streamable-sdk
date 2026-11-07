import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { DurableUploadOptions, UploadCheckpoint } from "./upload-state.js";
import { validateUploadCheckpoint } from "./upload-state.js";

/** Optional file adapter. Database/queue users can supply their own save callback instead. */
export async function withCheckpointFile<T>(
  path: string,
  action: (persistence: DurableUploadOptions) => Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        "Checkpoint is locked; verify no other owner is running before removing a stale .lock file",
      );
    throw error;
  });
  try {
    await lock.writeFile(String(process.pid));
    let checkpoint: UploadCheckpoint | undefined;
    try {
      const text = await readFile(path, "utf8");
      try {
        checkpoint = JSON.parse(text);
      } catch {
        throw new Error("Invalid checkpoint JSON; the upload was not started");
      }
      validateUploadCheckpoint(checkpoint!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return await action({
      checkpoint,
      save: async (value) => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(JSON.stringify(value));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      },
    });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

import type { MultipartCheckpoint, S3Credentials } from "./s3-multipart.js";

export type UploadStage =
  | "authenticating"
  | "opening-source"
  | "fingerprinting"
  | "creating-upload"
  | "initializing"
  | "uploading"
  | "completing-upload"
  | "storage-complete"
  | "starting-processing"
  | "uploaded"
  | "processing"
  | "ready";

/** Safe lifecycle metadata. No credentials, storage keys, source URLs or filenames. */
export interface UploadStageEvent {
  stage: UploadStage;
  resumed: boolean;
  uploadConfirmed: boolean;
  shortcode?: string;
  url?: string;
}

/** Sensitive, JSON-serializable state. Persist privately and acquire an exclusive job lease. */
export interface UploadCheckpoint {
  version: 1;
  account: string;
  shortcode: string;
  fileName: string;
  title: string;
  labelId: string;
  size: number;
  sourceFingerprint: string;
  phase:
    | "created"
    | "initialized"
    | "uploading"
    | "storage-complete"
    | "starting-processing"
    | "uploaded";
  storage: {
    bucket: string;
    key: string;
    accelerated: boolean;
    credentials: S3Credentials;
    clockOffsetMs: number;
  };
  transcoderOptions: Record<string, unknown>;
  multipart?: MultipartCheckpoint;
}

export interface DurableUploadOptions {
  checkpoint?: UploadCheckpoint;
  /** Awaited before the next effect; throw to stop. Use an atomic write/transaction. */
  save: (checkpoint: UploadCheckpoint) => void | Promise<void>;
  /** Provider-specific renewal for the same saved S3 target/session. No refresh API is assumed. */
  refreshCredentials?: (checkpoint: UploadCheckpoint) => Promise<S3Credentials>;
  verifyCompleted?: (checkpoint: UploadCheckpoint) => Promise<boolean>;
  /** Only opt in after checking the same video; may restart transcoding, never creates a video. */
  retryProcessing?: boolean;
}

export class UploadResumeError extends Error {
  constructor(
    readonly code:
      | "invalid-checkpoint"
      | "source-changed"
      | "confirmation-pending",
    readonly shortcode?: string,
  ) {
    super(`Upload resume stopped: ${code}; the saved upload was not replaced`);
    this.name = "UploadResumeError";
  }
}

export function validateUploadCheckpoint(value: UploadCheckpoint) {
  if (
    !value ||
    value.version !== 1 ||
    !/^[a-zA-Z0-9]{1,64}$/.test(value.shortcode) ||
    !/^[a-f0-9]{64}$/.test(value.account) ||
    !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.fileName !== "string" ||
    typeof value.title !== "string" ||
    typeof value.labelId !== "string" ||
    ![
      "created",
      "initialized",
      "uploading",
      "storage-complete",
      "starting-processing",
      "uploaded",
    ].includes(value.phase) ||
    !value.storage ||
    typeof value.storage.bucket !== "string" ||
    typeof value.storage.key !== "string" ||
    typeof value.storage.accelerated !== "boolean" ||
    !Number.isFinite(value.storage.clockOffsetMs) ||
    !value.storage.credentials ||
    typeof value.storage.credentials.accessKeyId !== "string" ||
    typeof value.storage.credentials.secretAccessKey !== "string" ||
    (value.storage.credentials.sessionToken !== undefined &&
      typeof value.storage.credentials.sessionToken !== "string") ||
    !value.transcoderOptions ||
    typeof value.transcoderOptions !== "object" ||
    Array.isArray(value.transcoderOptions)
  ) {
    throw new UploadResumeError("invalid-checkpoint");
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.storage.bucket) ||
    !value.storage.key ||
    !value.storage.credentials.accessKeyId ||
    !value.storage.credentials.secretAccessKey
  )
    throw new UploadResumeError("invalid-checkpoint");
  const multipart = value.multipart;
  if (
    multipart &&
    (multipart.version !== 1 ||
      multipart.bucket !== value.storage.bucket ||
      multipart.key !== value.storage.key ||
      multipart.size !== value.size ||
      multipart.sourceIdentity !== value.sourceFingerprint ||
      multipart.accelerated !== value.storage.accelerated ||
      multipart.region !== "us-east-1")
  )
    throw new UploadResumeError("invalid-checkpoint");
  if (
    ["storage-complete", "starting-processing", "uploaded"].includes(
      value.phase,
    ) &&
    multipart?.phase !== "completed"
  )
    throw new UploadResumeError("invalid-checkpoint");
  if (value.phase === "created" && multipart)
    throw new UploadResumeError("invalid-checkpoint");
}

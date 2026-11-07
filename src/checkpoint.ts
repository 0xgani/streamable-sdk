/** A persistence or lifecycle callback failed. Do not retry it as a network operation. */
export class UploadCallbackError extends Error {
  constructor(
    readonly callback: string,
    cause: unknown,
  ) {
    super(
      `Upload ${callback} callback failed; no subsequent upload step was started`,
      { cause },
    );
    this.name = "UploadCallbackError";
  }
}

export async function callUploadCallback<T>(
  name: string,
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
) {
  if (!callback) return;
  try {
    await callback(value);
  } catch (error) {
    throw new UploadCallbackError(name, error);
  }
}

export const xmlEscape = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!,
  );
export const xmlDecode = (value: string) =>
  value.replace(
    /&(lt|gt|amp|quot|apos);/g,
    (_, entity: string) =>
      ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[entity]!,
  );

export function validateMultipartOptions(
  size: number,
  opts: { partSize?: number; concurrency?: number; retries?: number },
) {
  if (!Number.isSafeInteger(size) || size < 0)
    throw new RangeError("Source size must be a nonnegative safe integer");
  if (
    opts.partSize !== undefined &&
    (!Number.isSafeInteger(opts.partSize) ||
      opts.partSize <= 0 ||
      opts.partSize > 5 * 1024 ** 3)
  )
    throw new RangeError(
      "partSize must be an integer from 1 byte to 5 GiB (values below 5 MiB are rounded up)",
    );
  if (
    opts.concurrency !== undefined &&
    (!Number.isInteger(opts.concurrency) ||
      opts.concurrency < 1 ||
      opts.concurrency > 10000)
  )
    throw new RangeError("concurrency must be an integer from 1 to 10000");
  if (
    opts.retries !== undefined &&
    (!Number.isInteger(opts.retries) || opts.retries < 0 || opts.retries > 10)
  )
    throw new RangeError("retries must be an integer from 0 to 10");
}

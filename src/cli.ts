import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ProcessingTimeoutError, StreamableClient } from "./client.js";
import { withCheckpointFile } from "./checkpoint-file.js";
import type { DurableUploadOptions } from "./upload-state.js";

const HELP = `Usage:
  streamable-sdk upload <file-or-url> [--title <title>] [--label <id>] [--no-wait]
  streamable-sdk list [--label <id>]
  streamable-sdk delete <shortcode>...
  streamable-sdk download <shortcode-or-url>... [-o <file-or-dir>] [--format <name>]

Credentials (not needed for download; flags override env; a .env file in the current directory is loaded):
  --email     or STREAMABLE_EMAIL / EMAIL
  --password  or STREAMABLE_PASSWORD / PASSWORD
  --label     or STREAMABLE_LABEL_ID / LABEL_ID

Upload options:
  --title <title>                Video title (default: file name)
  -H, --header "Name: value"     HTTP header for downloading a URL source (repeatable),
                                 e.g. -H "Authorization: Bearer <token>"
  --no-wait                      Don't wait for Streamable to finish processing
  --processing-timeout <seconds> Processing wait limit (default 900; 0 disables the deadline)
  --checkpoint <file>           Atomically save/resume this upload (forces multipart; file is sensitive)
  --retry-processing            Explicitly retry an uncertain processing request on the saved video
  --json-stages                 Write structured stage events to stderr instead of text progress
  --part-size <MiB>              Multipart part size (default 16)
  --concurrency <n>              Parallel part uploads (default 4)
  --part-retries <n>             Retries per multipart part (default 5; 0 disables retries)
  --multipart-threshold <MiB>    Local files at/above this use multipart (default 32)
  -h, --help                     Show this help

Download options:
  -o, --output <file-or-dir>     Where to save (default: <shortcode>.mp4)
  --format <name>                Rendition: mp4 (default) or mp4-mobile, when available`;

/** Minimal .env loader (KEY=value, optional quotes); never overrides existing env vars. */
function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/,
    );
    if (!m) continue;
    const [, key, raw = ""] = m;
    const value = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[key!] === undefined) process.env[key!] = value;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const mib = (value: string | undefined) =>
  value ? Number(value) * 1024 * 1024 : undefined;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: "string" },
      password: { type: "string" },
      label: { type: "string" },
      title: { type: "string" },
      header: { type: "string", short: "H", multiple: true },
      "no-wait": { type: "boolean" },
      "processing-timeout": { type: "string" },
      checkpoint: { type: "string" },
      "retry-processing": { type: "boolean" },
      "json-stages": { type: "boolean" },
      "part-size": { type: "string" },
      concurrency: { type: "string" },
      "part-retries": { type: "string" },
      "multipart-threshold": { type: "string" },
      output: { type: "string", short: "o" },
      format: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  if (command === "download")
    return download(args, values.output, values.format);

  loadDotEnv();
  const env = process.env;
  const email = values.email ?? env.STREAMABLE_EMAIL ?? env.EMAIL;
  const password = values.password ?? env.STREAMABLE_PASSWORD ?? env.PASSWORD;
  const labelId = values.label ?? env.STREAMABLE_LABEL_ID ?? env.LABEL_ID;
  if (!email || !password)
    fail(
      "Missing credentials: set --email/--password or STREAMABLE_EMAIL/STREAMABLE_PASSWORD",
    );

  const client = new StreamableClient(email, password);
  const isTTY = process.stderr.isTTY;

  switch (command) {
    case "upload": {
      const [source] = args;
      if (!source) fail("Usage: streamable-sdk upload <file-or-url>");
      if (values["retry-processing"] && !values.checkpoint)
        fail("--retry-processing requires --checkpoint");
      const rawTimeout = values["processing-timeout"];
      const seconds = rawTimeout === undefined ? undefined : Number(rawTimeout);
      if (
        seconds !== undefined &&
        (!rawTimeout?.trim() ||
          !Number.isFinite(seconds) ||
          seconds < 0 ||
          seconds * 1000 > 2_147_483_647)
      ) {
        fail(
          "--processing-timeout must be a finite nonnegative number of seconds (maximum 2147483.647)",
        );
      }
      const headers = (values.header ?? []).map((h): [string, string] => {
        const i = h.indexOf(":");
        if (i < 1) fail(`Invalid header "${h}", expected "Name: value"`);
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      });
      let lastPrinted = -1;
      const controller = new AbortController();
      const cancel = () =>
        controller.abort(
          new Error(
            "Upload cancelled; resume from the saved checkpoint if enabled",
          ),
        );
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      const run = (resume?: DurableUploadOptions) =>
        client.upload(source, {
          labelId: labelId || undefined,
          title: values.title,
          headers,
          waitForReady: !values["no-wait"],
          processing: {
            timeoutMs:
              seconds === 0
                ? null
                : seconds === undefined
                  ? undefined
                  : seconds * 1000,
          },
          partSize: mib(values["part-size"]),
          multipartThreshold: mib(values["multipart-threshold"]),
          concurrency: values.concurrency
            ? Number(values.concurrency)
            : undefined,
          retries:
            values["part-retries"] !== undefined
              ? Number(values["part-retries"])
              : undefined,
          resume: resume
            ? { ...resume, retryProcessing: values["retry-processing"] }
            : undefined,
          signal: controller.signal,
          onStage: values["json-stages"]
            ? (event) => {
                console.error(JSON.stringify(event));
              }
            : undefined,
          onStatus: (m) => {
            // Processing updates repeat every few seconds; only show them on a terminal.
            if (
              !values["json-stages"] &&
              (!m.startsWith("Processing") || isTTY)
            )
              console.error(m);
          },
          onProgress: (loaded, total) => {
            if (values["json-stages"]) return;
            const pct = Math.floor((loaded / total) * 100);
            if (isTTY) {
              process.stderr.write(
                `\r  ${pct}% (${(loaded / 1024 / 1024).toFixed(1)} MB)${loaded === total ? "\n" : ""}`,
              );
            } else if (pct >= lastPrinted + 10 || loaded === total) {
              console.error(`  ${pct}%`);
              lastPrinted = pct;
            }
          },
        });
      let result;
      try {
        result = await (values.checkpoint
          ? withCheckpointFile(values.checkpoint, run)
          : run());
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
      // The URL is the only stdout output, so the command is easy to script.
      console.log(result.url);
      break;
    }
    case "list": {
      const { total, videos } = await client.listVideos({
        labelId: labelId || undefined,
      });
      for (const v of videos)
        console.log(`${v.shortcode}\t${statusName(v.status)}\t${v.title}`);
      console.error(`${videos.length} of ${total} video(s)`);
      break;
    }
    case "delete": {
      if (!args.length) fail("Usage: streamable-sdk delete <shortcode>...");
      for (const shortcode of args) {
        try {
          await client.deleteVideo(shortcode);
          console.log(`deleted ${shortcode}`);
        } catch (err) {
          process.exitCode = 1;
          console.error(`failed ${shortcode}: ${(err as Error).message}`);
        }
      }
      break;
    }
    default:
      fail(`Unknown command "${command}"\n\n${HELP}`);
  }
}

async function download(
  videos: string[],
  output: string | undefined,
  format: string | undefined,
) {
  if (!videos.length)
    fail("Usage: streamable-sdk download <shortcode-or-url>...");
  // Public downloads need no account.
  const client = new StreamableClient("", "");
  const isTTY = process.stderr.isTTY;
  for (const video of videos) {
    try {
      const { path } = await client.download(video, output, {
        format,
        onProgress: (loaded, total) => {
          if (!isTTY) return;
          const pct = total ? ` ${Math.floor((loaded / total) * 100)}%` : "";
          process.stderr.write(
            `\r ${pct} (${(loaded / 1024 / 1024).toFixed(1)} MB)`,
          );
        },
      });
      if (isTTY) process.stderr.write("\n");
      console.log(path);
    } catch (err) {
      process.exitCode = 1;
      console.error(`failed ${video}: ${(err as Error).message}`);
    }
  }
}

function statusName(status: number) {
  return (
    ["uploading", "processing", "ready", "error"][status] ?? String(status)
  );
}

main().catch((err) => {
  if (err instanceof ProcessingTimeoutError) {
    console.error(
      `Upload succeeded: ${err.url}. Processing is unconfirmed; resume checking this video instead of uploading again.`,
    );
  }
  fail(err instanceof Error ? err.message : String(err));
});

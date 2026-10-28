import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StreamableClient } from "./client.js";

const HELP = `Usage:
  streamable-uploader upload <file-or-url> [--title <title>] [--label <id>] [--no-wait]
  streamable-uploader list [--label <id>]
  streamable-uploader delete <shortcode>...

Credentials (flags override env; a .env file in the current directory is loaded):
  --email     or STREAMABLE_EMAIL / EMAIL
  --password  or STREAMABLE_PASSWORD / PASSWORD
  --label     or STREAMABLE_LABEL_ID / LABEL_ID

Upload options:
  --title <title>                Video title (default: file name)
  -H, --header "Name: value"     HTTP header for downloading a URL source (repeatable),
                                 e.g. -H "Authorization: Bearer <token>"
  --no-wait                      Don't wait for Streamable to finish processing
  --part-size <MiB>              Multipart part size (default 16)
  --concurrency <n>              Parallel part uploads (default 4)
  --multipart-threshold <MiB>    Local files at/above this use multipart (default 32)
  -h, --help                     Show this help`;

/** Minimal .env loader (KEY=value, optional quotes); never overrides existing env vars. */
function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
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

const mib = (value: string | undefined) => (value ? Number(value) * 1024 * 1024 : undefined);

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
      "part-size": { type: "string" },
      concurrency: { type: "string" },
      "multipart-threshold": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  loadDotEnv();
  const env = process.env;
  const email = values.email ?? env.STREAMABLE_EMAIL ?? env.EMAIL;
  const password = values.password ?? env.STREAMABLE_PASSWORD ?? env.PASSWORD;
  const labelId = values.label ?? env.STREAMABLE_LABEL_ID ?? env.LABEL_ID;
  if (!email || !password) fail("Missing credentials: set --email/--password or STREAMABLE_EMAIL/STREAMABLE_PASSWORD");

  const client = new StreamableClient(email, password);
  const isTTY = process.stderr.isTTY;

  switch (command) {
    case "upload": {
      const [source] = args;
      if (!source) fail("Usage: streamable-uploader upload <file-or-url>");
      const headers = (values.header ?? []).map((h): [string, string] => {
        const i = h.indexOf(":");
        if (i < 1) fail(`Invalid header "${h}", expected "Name: value"`);
        return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
      });
      let lastPrinted = -1;
      const result = await client.upload(source, {
        labelId: labelId || undefined,
        title: values.title,
        headers,
        waitForReady: !values["no-wait"],
        partSize: mib(values["part-size"]),
        multipartThreshold: mib(values["multipart-threshold"]),
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        onStatus: (m) => {
          // Processing updates repeat every few seconds; only show them on a terminal.
          if (!m.startsWith("Processing") || isTTY) console.error(m);
        },
        onProgress: (loaded, total) => {
          const pct = Math.floor((loaded / total) * 100);
          if (isTTY) {
            process.stderr.write(`\r  ${pct}% (${(loaded / 1024 / 1024).toFixed(1)} MB)${loaded === total ? "\n" : ""}`);
          } else if (pct >= lastPrinted + 10 || loaded === total) {
            console.error(`  ${pct}%`);
            lastPrinted = pct;
          }
        },
      });
      // The URL is the only stdout output, so the command is easy to script.
      console.log(result.url);
      break;
    }
    case "list": {
      const { total, videos } = await client.listVideos({ labelId: labelId || undefined });
      for (const v of videos) console.log(`${v.shortcode}\t${statusName(v.status)}\t${v.title}`);
      console.error(`${videos.length} of ${total} video(s)`);
      break;
    }
    case "delete": {
      if (!args.length) fail("Usage: streamable-uploader delete <shortcode>...");
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

function statusName(status: number) {
  return ["uploading", "processing", "ready", "error"][status] ?? String(status);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

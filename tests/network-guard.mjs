// Offline test boundary: every non-loopback request must be replaced by a fake service.
// Propagate this to spawned CLI/process-restart tests too. Never read a user's .env file.
const flag = `--import=${JSON.stringify(import.meta.url)}`;
if (!(process.env.NODE_OPTIONS || "").includes("network-guard.mjs"))
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${flag}`.trim();
for (const key of Object.keys(process.env))
  if (/^(STREAMABLE_|EMAIL$|PASSWORD$)/.test(key)) delete process.env[key];
const original = globalThis.fetch;
// Node 20.0 can execute --import preloads in a different order. The branded fixture
// already rejects every unmatched request and must not be hidden behind this guard.
if (!original[Symbol.for("streamable-sdk.offline-test-fetch")])
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("Offline tests blocked an unmatched outbound request");
    return original(input, init);
  };

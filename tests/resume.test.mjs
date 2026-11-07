import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  StreamableClient,
  multipartUpload,
  MultipartResumeError,
  UploadResumeError,
  UploadCallbackError,
  withCheckpointFile,
  abortMultipartUpload,
} from "../dist/index.js";
import {
  makeState,
  mockService,
  fakeCredentials,
} from "./fixtures/durable-service.mjs";

const MiB = 1024 ** 2;
const source = () => new Blob([new Uint8Array(12 * MiB).fill(17)]);
const client = () =>
  new StreamableClient("fixture@example.invalid", "FAKE_PASSWORD");
const lowOptions = {
  bucket: "fixture-bucket",
  key: "fixture-object",
  credentials: fakeCredentials,
  partSize: 5 * MiB,
  concurrency: 1,
  retries: 0,
  sourceIdentity: "fixture-immutable-source-v1",
};
const fake = async (state, options, action) => {
  const original = globalThis.fetch;
  globalThis.fetch = mockService(state, options);
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
};

test("durable multipart resumes the same ID and skips persisted parts after a disconnect", async () => {
  const state = makeState();
  let checkpoint;
  const save = (c) => {
    checkpoint = structuredClone(c);
  };
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      multipartUpload(source(), { ...lowOptions, onCheckpoint: save }),
    ),
  );
  assert.equal(checkpoint.parts.length, 1);
  assert.equal(checkpoint.phase, "uploading");
  assert.equal(state.deletes, 0);
  await fake(state, {}, () =>
    multipartUpload(source(), {
      ...lowOptions,
      resume: checkpoint,
      onCheckpoint: save,
    }),
  );
  assert.equal(state.initiates, 1);
  assert.deepEqual(state.puts, [1, 2, 2, 3]);
  assert.equal(checkpoint.phase, "completed");
});

test("ListParts reconciles an accepted part whose response/checkpoint was lost", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { losePartResponse: 2 }, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        onCheckpoint: (c) => {
          checkpoint = c;
        },
      }),
    ),
  );
  assert.deepEqual(
    checkpoint.parts.map((p) => p.partNumber),
    [1],
  );
  await fake(state, { pageSize: 1 }, () =>
    multipartUpload(source(), {
      ...lowOptions,
      resume: checkpoint,
      onCheckpoint: (c) => {
        checkpoint = c;
      },
    }),
  );
  assert.deepEqual(state.puts, [1, 2, 3]);
  assert.deepEqual(state.lists, [0, 1]);
  assert.equal(state.initiates, 1);
});

test("checkpoint writes serialize and worker requests settle before rejection", async () => {
  const state = makeState();
  let active = 0,
    maxActive = 0,
    checkpoint,
    writes = 0;
  await fake(state, {}, () =>
    multipartUpload(source(), {
      ...lowOptions,
      concurrency: 3,
      onCheckpoint: async (c) => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise((r) => setTimeout(r, 2));
        checkpoint = c;
        writes++;
        active--;
      },
    }),
  );
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(checkpoint.parts.length, 3);
  assert.ok(writes >= 5);
  const before = writes;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(writes, before);
});

test("a failed persistence callback never triggers single-POST fallback or deletes the session", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, {}, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        concurrency: 1,
        partSize: 5 * MiB,
        resume: {
          save: (c) => {
            checkpoint = c;
            if (c.multipart?.parts.length === 1)
              throw new Error("fixture database unavailable");
          },
        },
      }),
      UploadCallbackError,
    ),
  );
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
  assert.equal(state.deletes, 0);
  assert.equal(state.transcodes, 0);
  await fake(state, {}, () =>
    client().upload(source(), {
      retries: 0,
      partSize: 5 * MiB,
      resume: {
        checkpoint,
        save: (c) => {
          checkpoint = c;
        },
      },
    }),
  );
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
  assert.equal(state.transcodes, 1);
});

test("high-level resume verifies source bytes, account, options and checkpoint version before effects", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        concurrency: 1,
        partSize: 5 * MiB,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
      }),
    ),
  );
  const puts = state.puts.length;
  await fake(state, {}, async () => {
    await assert.rejects(
      client().upload(new Blob([new Uint8Array(12 * MiB).fill(18)]), {
        resume: { checkpoint, save: () => {} },
      }),
      (e) => e instanceof UploadResumeError && e.code === "source-changed",
    );
    await assert.rejects(
      new StreamableClient("other@example.invalid", "FAKE_PASSWORD").upload(
        source(),
        { resume: { checkpoint, save: () => {} } },
      ),
      UploadResumeError,
    );
    await assert.rejects(
      client().upload(source(), {
        title: "a different video",
        resume: { checkpoint, save: () => {} },
      }),
      UploadResumeError,
    );
    await assert.rejects(
      client().upload(source(), {
        resume: { checkpoint: { ...checkpoint, version: 99 }, save: () => {} },
      }),
      UploadResumeError,
    );
  });
  assert.equal(state.puts.length, puts);
  assert.equal(state.creates, 1);
});

test("durable mode works for local files, Blobs, authenticated range URLs, buffered URLs and custom range sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-source-test-"));
  try {
    const bytes = new Uint8Array(1024).fill(7),
      path = join(dir, "video.mp4");
    await writeFile(path, bytes);
    for (const [input, options] of [
      [path, {}],
      [new Blob([bytes]), {}],
      ["https://source.example/video.mp4", { source: bytes }],
      ["https://source.example/video.mp4", { source: bytes, noRanges: true }],
      [
        {
          size: bytes.length,
          read: async (start, end) => new Blob([bytes.slice(start, end)]),
        },
        {},
      ],
    ]) {
      const state = makeState();
      let checkpoint;
      await fake(state, options, () =>
        client().upload(input, {
          headers: { Authorization: "Bearer FAKE_SOURCE_TOKEN" },
          resume: {
            save: (c) => {
              checkpoint = c;
            },
          },
        }),
      );
      assert.equal(checkpoint.phase, "uploaded");
      assert.equal(state.creates, 1);
      assert.equal(state.initiates, 1);
      assert.equal(state.transcodes, 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("structured stages are awaited, ordered, safe to log and work without durable mode", async () => {
  const state = makeState(),
    events = [];
  await fake(state, {}, () =>
    client().upload(new Blob(["fixture"]), {
      onStage: async (event) => {
        await Promise.resolve();
        events.push(event);
      },
    }),
  );
  assert.deepEqual(
    events.map((e) => e.stage),
    [
      "authenticating",
      "opening-source",
      "creating-upload",
      "initializing",
      "uploading",
      "storage-complete",
      "starting-processing",
      "uploaded",
    ],
  );
  assert.ok(events.at(-1).uploadConfirmed);
  assert.equal(events.at(-1).url, "https://streamable.com/fixtureVideo");
  assert.doesNotMatch(
    JSON.stringify(events),
    /FAKE_|fixture-object|amazonaws|sourceFingerprint|credentials/,
  );
  const stopped = makeState();
  await fake(stopped, {}, () =>
    assert.rejects(
      client().upload(new Blob(["fixture"]), {
        onStage: (e) => {
          if (e.stage === "starting-processing")
            throw new Error("fixture callback stop");
        },
      }),
      UploadCallbackError,
    ),
  );
  assert.equal(stopped.transcodes, 0);
  assert.equal(stopped.creates, 1);
});

test("durable stages stop before processing when the callback fails and can resume safely", async () => {
  const state = makeState(),
    events = [];
  let checkpoint;
  await fake(state, {}, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        partSize: 5 * MiB,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
        onStage: (e) => {
          events.push(e.stage);
          if (e.stage === "starting-processing")
            throw new Error("fixture callback stop");
        },
      }),
      UploadCallbackError,
    ),
  );
  assert.equal(checkpoint.phase, "storage-complete");
  assert.equal(state.transcodes, 0);
  await fake(state, {}, () =>
    client().upload(source(), {
      resume: {
        checkpoint,
        save: (c) => {
          checkpoint = c;
        },
      },
    }),
  );
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
  assert.equal(state.transcodes, 1);
  assert.ok(events.includes("completing-upload"));
});

test("every structured stage can stop execution and resume without allocating a second video", async () => {
  for (const stage of [
    "authenticating",
    "opening-source",
    "fingerprinting",
    "creating-upload",
    "initializing",
    "uploading",
    "completing-upload",
    "storage-complete",
    "starting-processing",
    "uploaded",
    "processing",
    "ready",
  ]) {
    const state = makeState();
    let checkpoint;
    await fake(state, { readyOnTranscode: true }, () =>
      assert.rejects(
        client().upload(new Blob(["fixture"]), {
          retries: 0,
          waitForReady: true,
          resume: {
            save: (c) => {
              checkpoint = c;
            },
          },
          onStage: async (e) => {
            if (e.stage === stage) throw new Error("fixture stage stop");
          },
        }),
        UploadCallbackError,
      ),
    );
    await fake(state, { readyOnTranscode: true }, () =>
      client().upload(
        checkpoint?.phase === "uploaded" ? null : new Blob(["fixture"]),
        {
          retries: 0,
          resume: {
            checkpoint,
            save: (c) => {
              checkpoint = c;
            },
          },
        },
      ),
    );
    assert.equal(state.creates, 1, stage);
    assert.equal(state.transcodes, 1, stage);
    assert.equal(checkpoint.phase, "uploaded", stage);
  }
});

test("inconsistent nested checkpoint state is rejected before initialization or processing", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        concurrency: 1,
        partSize: 5 * MiB,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
      }),
    ),
  );
  await fake(state, {}, async () => {
    for (const altered of [
      { ...checkpoint, phase: "storage-complete" },
      {
        ...checkpoint,
        storage: { ...checkpoint.storage, bucket: "https://invalid" },
      },
      {
        ...checkpoint,
        multipart: { ...checkpoint.multipart, key: "a different target" },
      },
    ]) {
      await assert.rejects(
        client().upload(source(), {
          resume: { checkpoint: altered, save: () => {} },
        }),
        UploadResumeError,
      );
    }
  });
  assert.equal(state.creates, 1);
  assert.equal(state.transcodes, 0);
});

test("lost processing response is reconciled using the same video without source/login/reupload", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { loseTranscodeResponse: true }, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
      }),
    ),
  );
  assert.equal(checkpoint.phase, "starting-processing");
  await fake(state, {}, () =>
    client().upload(null, {
      resume: {
        checkpoint,
        save: (c) => {
          checkpoint = c;
        },
      },
    }),
  );
  assert.equal(checkpoint.phase, "uploaded");
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
  assert.equal(state.transcodes, 1);
  await fake(state, {}, () =>
    client().upload(null, { resume: { checkpoint, save: () => {} } }),
  );
  assert.equal(state.transcodes, 1);
});

test("uncertain processing never silently retransmits, but supports explicit retry of the same video", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { rejectTranscode: true }, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
      }),
    ),
  );
  await fake(state, {}, () =>
    assert.rejects(
      client().upload(null, { resume: { checkpoint, save: () => {} } }),
      (e) =>
        e instanceof UploadResumeError && e.code === "confirmation-pending",
    ),
  );
  assert.equal(state.transcodes, 1);
  await fake(state, {}, () =>
    client().upload(null, {
      resume: {
        checkpoint,
        save: (c) => {
          checkpoint = c;
        },
        retryProcessing: true,
      },
    }),
  );
  assert.equal(state.transcodes, 2);
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
});

test("lost multipart completion response verifies the object before requesting processing", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { loseCompletionResponse: true }, () =>
    client().upload(source(), {
      retries: 0,
      partSize: 5 * MiB,
      resume: {
        save: (c) => {
          checkpoint = c;
        },
      },
    }),
  );
  assert.equal(checkpoint.phase, "uploaded");
  assert.equal(state.transcodes, 1);
  assert.equal(state.initiates, 1);
});

test("restart from completing checkpoint verifies a vanished session and refuses unverified objects", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, {}, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        onCheckpoint: (c) => {
          if (c.phase === "completed") throw new Error("fixture save lost");
          checkpoint = c;
        },
      }),
      UploadCallbackError,
    ),
  );
  assert.equal(checkpoint.phase, "completing");
  const bad = structuredClone(state);
  bad.object.etag = '"unrelated-object"';
  await fake(bad, {}, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        resume: checkpoint,
        onCheckpoint: () => {},
      }),
      (e) =>
        e instanceof MultipartResumeError && e.code === "completion-uncertain",
    ),
  );
  await fake(state, {}, () =>
    multipartUpload(source(), {
      ...lowOptions,
      resume: checkpoint,
      onCheckpoint: (c) => {
        checkpoint = c;
      },
    }),
  );
  assert.equal(checkpoint.phase, "completed");
  assert.equal(state.initiates, 1);
});

test("missing sessions, denied credentials and embedded HTTP-200 completion errors retain checkpoints", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        onCheckpoint: (c) => {
          checkpoint = c;
        },
      }),
    ),
  );
  const missing = structuredClone(state);
  missing.sessions = {};
  await fake(missing, {}, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        resume: checkpoint,
        onCheckpoint: () => {},
      }),
      (e) => e instanceof MultipartResumeError && e.code === "session-missing",
    ),
  );
  await fake(state, { expired: true }, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        resume: checkpoint,
        onCheckpoint: () => {},
      }),
      (e) => e instanceof MultipartResumeError && e.code === "access-denied",
    ),
  );
  await fake(state, { embeddedError: true }, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        resume: checkpoint,
        onCheckpoint: (c) => {
          checkpoint = c;
        },
      }),
    ),
  );
  assert.equal(checkpoint.phase, "completing");
  assert.equal(state.deletes, 0);
  assert.equal(state.initiates, 1);
});

test("provider-supplied credential renewal retains the same multipart identity", async () => {
  const state = makeState();
  let checkpoint,
    refreshes = 0;
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      client().upload(source(), {
        retries: 0,
        concurrency: 1,
        partSize: 5 * MiB,
        resume: {
          save: (c) => {
            checkpoint = c;
          },
        },
      }),
    ),
  );
  await fake(state, { expired: true }, () =>
    client().upload(source(), {
      retries: 0,
      resume: {
        checkpoint,
        save: (c) => {
          checkpoint = c;
        },
        refreshCredentials: async () => {
          refreshes++;
          return { ...fakeCredentials, accessKeyId: "RENEWED_ACCESS" };
        },
      },
    }),
  );
  assert.ok(refreshes >= 1);
  assert.equal(state.creates, 1);
  assert.equal(state.initiates, 1);
  assert.equal(checkpoint.storage.credentials.accessKeyId, "RENEWED_ACCESS");
});

test("parallel credential renewal and part saves share a serialized persistence barrier", async () => {
  const state = makeState();
  let active = 0,
    maxActive = 0,
    checkpoint,
    refreshes = 0;
  await fake(state, { expiredOnPut: true }, () =>
    client().upload(source(), {
      retries: 0,
      concurrency: 3,
      partSize: 5 * MiB,
      resume: {
        save: async (c) => {
          maxActive = Math.max(maxActive, ++active);
          await new Promise((r) => setTimeout(r, 1));
          checkpoint = c;
          active--;
        },
        refreshCredentials: async () => {
          refreshes++;
          await new Promise((r) => setTimeout(r, 2));
          return { ...fakeCredentials, accessKeyId: "RENEWED_ACCESS" };
        },
      },
    }),
  );
  assert.equal(maxActive, 1);
  assert.equal(checkpoint.phase, "uploaded");
  assert.equal(checkpoint.multipart.parts.length, 3);
  assert.equal(refreshes, 1);
});

test("persisted clock offset produces fresh signatures on a much later resume", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, { failPart: 2 }, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        serverTime: Math.floor((Date.now() + 30000) / 1000),
        onCheckpoint: (c) => {
          checkpoint = c;
        },
      }),
    ),
  );
  const originalNow = Date.now,
    originalFetch = globalThis.fetch;
  try {
    Date.now = () => originalNow() + 20 * 60_000;
    const service = mockService(state);
    globalThis.fetch = async (input, init) => {
      const stamp = new Headers(init.headers).get("x-amz-date");
      const expected = new Date(Date.now() + checkpoint.clockOffsetMs)
        .toISOString()
        .replace(/[:-]|\.\d{3}/g, "");
      assert.equal(stamp, expected);
      return service(input, init);
    };
    await multipartUpload(source(), {
      ...lowOptions,
      resume: checkpoint,
      onCheckpoint: (c) => {
        checkpoint = c;
      },
    });
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
  assert.equal(checkpoint.phase, "completed");
});

test("nonstandard object ETags require an explicit completion verifier", async () => {
  const state = makeState();
  let checkpoint;
  await fake(state, {}, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        onCheckpoint: (c) => {
          if (c.phase === "completed") throw new Error("fixture stop");
          checkpoint = c;
        },
      }),
      UploadCallbackError,
    ),
  );
  state.object.etag = '"nonstandard-encrypted-etag"';
  let checks = 0;
  await fake(state, {}, () =>
    multipartUpload(source(), {
      ...lowOptions,
      resume: checkpoint,
      onCheckpoint: (c) => {
        checkpoint = c;
      },
      verifyCompleted: async (c) => {
        checks++;
        assert.equal(c.uploadId, checkpoint.uploadId);
        return true;
      },
    }),
  );
  assert.equal(checks, 1);
  assert.equal(checkpoint.phase, "completed");
  assert.equal(state.initiates, 1);
});

test("cancellation and explicit abort differ: cancellation preserves, explicit abort discards", async () => {
  const state = makeState(),
    controller = new AbortController();
  let checkpoint;
  await fake(state, {}, () =>
    assert.rejects(
      multipartUpload(source(), {
        ...lowOptions,
        signal: controller.signal,
        onCheckpoint: (c) => {
          checkpoint = c;
          if (c.parts.length === 1)
            controller.abort(new Error("fixture pause"));
        },
      }),
    ),
  );
  assert.equal(state.deletes, 0);
  assert.ok(state.sessions[checkpoint.uploadId]);
  await fake(state, {}, () =>
    abortMultipartUpload(checkpoint, { credentials: fakeCredentials }),
  );
  assert.equal(state.deletes, 1);
  assert.equal(state.sessions[checkpoint.uploadId], undefined);
});

test("invalid low-level options/checkpoints fail before creating or overwriting parts", async () => {
  const state = makeState();
  await fake(state, {}, async () => {
    for (const opts of [
      { concurrency: 0 },
      { partSize: NaN },
      { retries: -1 },
      { onCheckpoint: () => {} },
    ])
      await assert.rejects(
        multipartUpload(source(), {
          ...lowOptions,
          sourceIdentity: undefined,
          ...opts,
        }),
      );
  });
  assert.equal(state.initiates, 0);
});

test("file adapter uses exclusive locks, atomic private saves and rejects corrupt JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-checkpoint-file-")),
    path = join(dir, "upload.json");
  try {
    const state = makeState();
    let checkpoint;
    await fake(state, {}, () =>
      withCheckpointFile(path, async (persistence) => {
        await assert.rejects(
          withCheckpointFile(path, async () => {}),
          /locked/,
        );
        await client().upload(new Blob(["fixture"]), { resume: persistence });
      }),
    );
    checkpoint = JSON.parse(await readFile(path, "utf8"));
    assert.equal(checkpoint.phase, "uploaded");
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{"credentials":"FAKE_SECRET" BROKEN');
    await assert.rejects(
      withCheckpointFile(path, async () => {}),
      (error) =>
        !error.message.includes("FAKE_SECRET") &&
        /Invalid checkpoint/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resumes missing multipart parts from a persisted checkpoint in a separate process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-cli-restart-"));
  try {
    const path = join(dir, "video.mp4"),
      checkpoint = join(dir, "upload.json"),
      statePath = join(dir, "service.json");
    await writeFile(path, new Uint8Array(12 * MiB).fill(17));
    await writeFile(statePath, JSON.stringify(makeState()));
    const fixture = pathToFileURL(
      resolve("tests/fixtures/durable-service.mjs"),
    ).href;
    const args = [
      "--import",
      fixture,
      "dist/cli.js",
      "upload",
      path,
      "--email",
      "fixture@example.invalid",
      "--password",
      "FAKE_PASSWORD",
      "--checkpoint",
      checkpoint,
      "--no-wait",
      "--part-size",
      "5",
      "--concurrency",
      "1",
      "--part-retries",
      "0",
      "--json-stages",
    ];
    const first = spawnSync(process.execPath, args, {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        SDK_FIXTURE_STATE: statePath,
        SDK_FIXTURE_OPTIONS: JSON.stringify({ failPart: 2 }),
      },
    });
    assert.equal(first.status, 1, first.stderr);
    assert.equal(
      JSON.parse(await readFile(checkpoint, "utf8")).phase,
      "uploading",
    );
    const second = spawnSync(process.execPath, args, {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        SDK_FIXTURE_STATE: statePath,
        SDK_FIXTURE_OPTIONS: "{}",
      },
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), "https://streamable.com/fixtureVideo");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.creates, 1);
    assert.equal(state.initiates, 1);
    assert.equal(state.transcodes, 1);
    assert.equal(state.puts.filter((n) => n === 1).length, 1);
    const events = second.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(events.every((e) => e.resumed));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hard-killed CLI process resumes its saved parts after explicit stale-lock recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-cli-kill-"));
  let child;
  try {
    const path = join(dir, "video.mp4"),
      checkpoint = join(dir, "upload.json"),
      statePath = join(dir, "service.json");
    await writeFile(path, new Uint8Array(12 * MiB).fill(17));
    await writeFile(statePath, JSON.stringify(makeState()));
    const fixture = pathToFileURL(
      resolve("tests/fixtures/durable-service.mjs"),
    ).href;
    const args = [
      "--import",
      fixture,
      "dist/cli.js",
      "upload",
      path,
      "--email",
      "fixture@example.invalid",
      "--password",
      "FAKE_PASSWORD",
      "--checkpoint",
      checkpoint,
      "--no-wait",
      "--part-size",
      "5",
      "--concurrency",
      "1",
      "--part-retries",
      "0",
      "--json-stages",
    ];
    child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        SDK_FIXTURE_STATE: statePath,
        SDK_FIXTURE_OPTIONS: JSON.stringify({ hangPart: 2 }),
      },
    });
    let errorOutput = "";
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    for (let i = 0; i < 200; i++) {
      try {
        if (
          JSON.parse(await readFile(checkpoint, "utf8")).multipart?.parts
            .length === 1
        )
          break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      JSON.parse(await readFile(checkpoint, "utf8")).multipart.parts.length,
      1,
      errorOutput,
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    // The previous process is confirmed dead; removing its lock is an explicit operator action.
    await rm(checkpoint + ".lock");
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        SDK_FIXTURE_STATE: statePath,
        SDK_FIXTURE_OPTIONS: "{}",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.creates, 1);
    assert.equal(state.initiates, 1);
    assert.equal(state.puts.filter((n) => n === 1).length, 1);
  } finally {
    child?.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

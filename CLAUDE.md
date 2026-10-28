# streamable-sdk

Unofficial Streamable SDK published as an npm package: a CLI (`npx streamable-sdk`) and a typed SDK.

## Runtime compatibility

The package must run on **Node.js >= 20 and Bun**. Inside `src/`:

- Use only Web/Node APIs (`fetch`, `Blob`, `node:fs`, `node:crypto`, `node:timers/promises`, ...). No `Bun.*`
  APIs; `tsconfig.json` loads only `@types/node` so they fail the type check.
- No runtime dependencies.
- Import sibling files with `.js` extensions (NodeNext resolution).

Bun is the development tool: `bun install`, `bun run typecheck`, `bun run build` (tsup produces ESM, CJS,
`.d.ts` and the CLI in `dist/`), and `bun run dev <command>` to run the CLI from source.

## Gotchas found so far

- Bun's `fetch` and `node:http` buffer whole responses with no backpressure, so URL sources use HTTP Range
  requests per part instead of piping the stream.
- `Bun.write(path, response)` hangs on chunked responses; copy with a reader instead.
- tsup's dts build needs TypeScript 5 (TS 6 breaks rollup-plugin-dts).
- `/uploads/shortcode` must be sent `version=unknown` or it returns 400.

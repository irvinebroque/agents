# Codex harness

A coding agent on Cloudflare Workers with a Codex-derived Rust/Wasm loop,
Workers AI, and conversations and files that survive Durable Object restarts.

The harness is experimental, lives in this example, and uses internal SDK APIs.

## Run locally

You need Node 24+, pnpm, rustup, and a Cloudflare account. From the repository root:

```sh
pnpm install
pnpm exec nx run agents:build
cd examples/next/harnesses/codex
rustup toolchain install 1.95.0 --target wasm32-unknown-unknown
pnpm run start
```

Wrangler must be signed in because Workers AI runs remotely. If you have access
to multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` before starting.

Open the printed local URL and ask the agent to write a file. Use **Restart and
verify** to check that the conversation and file survive a restart.

## Model

[`src/server.ts`](./src/server.ts) uses Kimi K2.7 Code through Workers AI and
AI Gateway:

```ts
import { createAI } from "agents/models/ai-sdk";

const model = createAI({ binding: this.env.AI, id: "default" })(
  "@cf/moonshotai/kimi-k2.7-code"
);
```

The adapter supports text, reasoning, and function tools.

## Test

From the example directory:

```sh
pnpm test
rustup run 1.95.0 cargo test --manifest-path wasm-kernel/Cargo.toml
```

For stress tests without model calls, run `pnpm run build:kernel` and
`pnpm run stress:dev`, then `pnpm run stress` in another terminal.

## Deploy

```sh
pnpm run deploy
```

See the [design notes](../../../../design/rfc-codex-harness-capability.md) for
implementation details and [third-party notices](./THIRD_PARTY_NOTICES.md) for
the Codex source and license.

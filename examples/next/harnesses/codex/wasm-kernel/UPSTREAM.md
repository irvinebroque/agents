# Codex source baseline

This extraction is aligned with [Codex 0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0), commit `360319d8dee62d87e2d59fc0c21805d79519cfed`.
It updates the previous baseline, `5e26f7621c1c470fe62350d61c9eb4d6c772a0da`.

The example adapts a subset of Codex's protocol and turn loop. It does not build the upstream Codex CLI or link its crates. Networking, transcript storage, model retries, compaction, and file execution remain owned by the TypeScript host and Agents SDK.

## Changes ported from 0.165.0

| Upstream source                                                                          | Adaptation                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-api/src/common.rs`, `core/src/client.rs`, `core/src/context/base_instructions.rs` | Base instructions are a developer message in `input`, replacing the top-level `instructions` field. The V4 adapter maps this prefix to its system message before adding the stored transcript.                                                      |
| `codex-api/src/sse/responses.rs`                                                         | Capture the response ID from `response.created`. Surface top-level provider error messages or codes. Treat `response.incomplete` with reason `interrupted` as a request to continue; other incomplete reasons fail with their reason preserved.     |
| `core/src/session/turn.rs`                                                               | Start another model round when `end_turn` is false. Settle completed tool calls before continuing; partial `output_item.added` calls are never dispatched.                                                                                          |
| `protocol/src/models.rs`                                                                 | Accept the additional optional response-item metadata without changing tool dispatch. The example's text/function-tool adapter does not implement image/file inputs, encrypted provider replay, configuration updates, or assistant message phases. |
| `tools/src/responses_api.rs`, `tools/src/tool_spec.rs`                                   | The example's function-tool schema remains compatible. The new output-schema representation is skipped during upstream serialization.                                                                                                               |
| `core/src/tools/parallel.rs`                                                             | Tool execution remains sequential and journaled by Tasks. Native cancellation, extension hooks, and tool tracing remain outside this extraction.                                                                                                    |

All paths above are relative to `codex-rs/` at the pinned commit. The upstream Apache-2.0 license is unchanged.

## Upgrade compatibility and tests

Checkpoint version 3 is unchanged. The adapter still accepts persisted model actions with the previous `instructions` field so interrupted operations can resume across an upgrade.

Run `pnpm test` from the example directory. It runs the Rust tests, builds the Wasm module, and exercises the compiled ABI together with the V4 adapter. Tests cover a full tool round, an actual pre-upgrade checkpoint/action fixture, continuation after interruption, response IDs, provider errors, and truncated streams.

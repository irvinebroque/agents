# Third-party notices

## OpenAI Codex

This example adapts protocol types and turn-processing behavior from
[openai/codex](https://github.com/openai/codex), version
[0.165.0](https://github.com/openai/codex/releases/tag/rust-v0.165.0), pinned at commit
`360319d8dee62d87e2d59fc0c21805d79519cfed`.

Copyright OpenAI.

Licensed under the Apache License, Version 2.0. The pinned upstream license text
is included in [`LICENSE-CODEX-APACHE-2.0`](./LICENSE-CODEX-APACHE-2.0).

The extracted implementation is substantially changed to remove native
network, filesystem, process, Tokio, and SQLite dependencies and expose a pure
serialized transition ABI suitable for Cloudflare Workers Wasm.

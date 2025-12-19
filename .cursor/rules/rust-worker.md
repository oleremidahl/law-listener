---
description: Rules for Rust development in Cloudflare Workers
globs: src/**/*.rs
---

# Rust Cloudflare Workers (WASM)

- **Execution Context:** Be aware of the 10ms CPU limit. Keep XML parsing efficient.
- **Networking:** Use `worker::Fetch` or `reqwest` (with `wasm` support).
- **Environment Variables:** Access via `env.var()` or `env.secret()`.
- **Asynchronous Code:** Everything must be `async` and compatible with the `worker` crate.
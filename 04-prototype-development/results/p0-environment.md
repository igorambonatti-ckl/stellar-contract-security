# P0 — Environment verification

**Run:** 2026-08-11 · **Gate:** [execution-plan.md §P0](../../docs/execution-plan.md) · **Result:** ✅ passed (with one finding)

## Toolchain

| Item | Required | Found | Status |
|---|---|---|---|
| `rustc` stable | any recent | 1.96.0 (2026-05-25) | ✅ |
| `cargo` stable | — | 1.96.0 | ✅ |
| `cargo +nightly` | needed by `cargo-fuzz` | 1.99.0-nightly (2026-08-10) | ✅ installed during P0 |
| WASM target | `wasm32v1-none` | installed during P0 | ✅ (see finding) |
| `cargo-fuzz` | — | 0.13.2 | ✅ installed during P0 |
| `cargo-mutants` | — | 27.1.0 | ✅ installed during P0 |
| `stellar` CLI | — | **not installed** | ⚠️ non-blocking |
| `cargo test` (workspace) | green | 1 passed, 0 failed | ✅ |

## Finding — the WASM target changed

The plan (inherited from the ChainGuard prototype and from older Stellar tutorials) specified
`wasm32-unknown-unknown`. That target **fails to build** against `soroban-sdk` 26.1.0, in the SDK's
own `build.rs`:

```
Rust compiler 1.82+ with target 'wasm32-unknown-unknown' is unsupported by the Soroban
Environment, use 'wasm32v1-none' available with Rust 1.84+. The 'wasm32-unknown-unknown'
target in Rust 1.82+ has features enabled that are not yet supported and not easily
disabled: reference-types, multi-value.
```

**Correct target: `wasm32v1-none`.** Verified:

```bash
rustup target add wasm32v1-none
cargo build -p increment --target wasm32v1-none --release
# → target/wasm32v1-none/release/increment.wasm  (1 443 bytes)
```

### Why this matters beyond a flag change

1. ChainGuard's dynamic fuzzer pins `soroban-sdk = "21"` and compiles user contracts to
   `wasm32-unknown-unknown` (`WASM_CARGO_TOML` in `sandbox-fuzzer.service.ts`). **That code path
   would not build against a current SDK** — worth stating explicitly in the Topic 5 write-up as a
   real-world instance of how fast this ecosystem moves.
2. Any command copied from a tutorial written before Rust 1.82 / `soroban-sdk` ~22 is stale. Topic 1's
   deploy snippet was one of them and has been corrected.

### Documents corrected

- `docs/execution-plan.md` — P0 check, P2 build gate, acceptance checklist, plus a warning note
- `01-stellar-fundamentals/README.md` — deploy command artifact path
- `03-solution-architecture/README.md` — removed the stale target name from the prior-art description

## `stellar` CLI — not installed, deliberately deferred

Not required for Topic 4: the prototype fuzzes in-process through the generated contract client and
never deploys. It **is** required for the Topic 5 demo if that demo includes a testnet deployment.

Action: install before T5-4 (`cargo install --locked stellar-cli`), or scope the demo to local
execution only and say so.

## Gate P0 verdict

**Passed.** Stable + nightly toolchains present, `wasm32v1-none` installed and building, `cargo-fuzz`
and `cargo-mutants` installed, workspace tests green. One stale assumption found and corrected
before it could cost time in P2 — which is precisely what the phase is for.

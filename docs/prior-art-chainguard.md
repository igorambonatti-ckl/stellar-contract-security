# Prior Art — ChainGuard AI

**Type:** Personal prototype (private, unpublished) · **Built:** Feb–Mar 2026 · **Author:** Igor Ambonatti

A full-stack security-analysis platform for Soroban smart contracts, built before this IDP formally
reached Topic 3. It is the single most relevant input to the solution architecture, because it
already **implemented and hit the real limits of** most of the ideas Topic 3 has to choose between.

This document is a factual inventory of what exists, so Topics 3–5 can reference concrete
engineering experience instead of speculation.

## 1. What it is

A monorepo (Turborepo) that takes Soroban Rust source and produces a security report:

```
contract source (paste / upload / GitHub webhook)
        │
        ├──▶ static analysis      15 AST detectors (Rust + syn)
        ├──▶ symbolic fuzzer      3 layers, no compilation (~16 ms)
        ├──▶ sandbox fuzzer       compiles to WASM, executes in soroban-sdk Env
        ├──▶ RAG                  pgvector similarity over an exploit corpus
        └──▶ AI analysis          Claude, structured-JSON audit report
                │
                ▼
        score 0–100 + findings + fix suggestions + downloadable fuzz harness
        (+ GitHub Check Run, PDF report, on-chain AuditRegistry attestation)
```

## 2. Components (verified from source)

| Package | Language | Size | What it does |
|---|---|---|---|
| `packages/analyzer-soroban/src/detectors/` | Rust (`syn`) | 15 files, ~1 700 LOC | SOR-001…SOR-015 static detectors |
| `packages/analyzer-soroban/src/fuzzer/` | Rust | 6 files, ~1 000 LOC | Symbolic fuzzer, Layers 1–2 |
| `packages/analyzer-soroban/src/fuzzer/scenarios/` | Rust | 20 files, ~2 000 LOC | Layer 3 — attack-scenario engine |
| `packages/soroban-fuzzer/src/main.rs` | Rust | 837 LOC | **Real dynamic fuzzer** (see §4) |
| `packages/ai-engine/` | TypeScript | — | Claude prompts, RAG service |
| `apps/api/` | NestJS | — | REST, BullMQ queue, WebSocket progress, GitHub webhook/Checks |
| `apps/web/` | React + Vite | — | Editor, live progress, report, verify-by-hash |
| `contracts/audit-registry/` | Soroban | — | On-chain attestation contract (5 tests) |

Reported test counts in `PLAN.md`: 20 detector tests + 58 fuzzer tests = 78 passing.
(Not re-run for this document — the repo has no commits and the counts are as recorded by the author.)

## 3. The static detectors (SOR-001 … SOR-015)

| ID | Detector | Severity |
|---|---|---|
| SOR-001 | Missing `require_auth` | Critical |
| SOR-002 | Incorrect invoker auth (`.invoker()` instead of `require_auth`) | Critical |
| SOR-003 | Unprotected admin function | Critical |
| SOR-004 | Unvalidated cross-contract call | High |
| SOR-005 | Integer overflow | High |
| SOR-006 | Reentrancy risk (CEI violation) | High |
| SOR-007 | Persistent vs temporary storage misuse | High |
| SOR-008 | Unbounded storage growth | Medium |
| SOR-009 | Missing TTL bump | Medium |
| SOR-010 | Hardcoded address | High/Medium |
| SOR-011 | Unhandled panic | Medium |
| SOR-012 | Missing event emit | Low |
| SOR-013 | Unused variables | Low |
| SOR-014 | No-effect function | Low |
| SOR-015 | Storage-key flow analysis | — |

SOR-001/002/003 map directly to the authorization invariants in
[Topic 2 §6](../02-security-and-fuzzing/README.md); SOR-007/008/009 map to the storage-tier and
TTL/state-archival invariants.

## 4. The dynamic fuzzer — the key architectural finding

`packages/soroban-fuzzer/src/main.rs` is described in its own header as an
"**Echidna-equivalent for Soroban contracts**", and its architecture answers the exact question
Topic 2 §5 left open (Echidna and Foundry are EVM-only — what is the Soroban equivalent?):

```
contract source → cargo build → WASM bytecode
                                     ↓
            soroban-sdk Env (testutils) — runs the WASM natively
                                     ↓
   Phase 1  boundary + random fuzzing per exported function (N cases each)
   Phase 2  DeFi attack sequences (flash loan, re-init, self-transfer, zero-amount)
   Phase 3  stateful sequences (init → deposit → overdraw)
                                     ↓
            catch panics / HostErrors → report as crashes
```

CLI: `soroban-fuzzer <wasm_path> <sigs_json> [cases]` → JSON on stdout.

**Why WASM-in-`Env` rather than a proptest harness against the Rust crate** (from
`sandbox-fuzzer.service.ts`, verbatim):

> - Works for ANY valid Soroban contract (no import/API compatibility issues)
> - WASM is what the contract is designed for — macros, `Address::from_string`, all work
> - True execution isolation: fresh `Env` per call (like fresh EVM state in Echidna)

This is a hard-won result and it is **the** load-bearing input to Topic 3's tooling decision.

## 5. The three-layer symbolic fuzzer

Documented in `docs/FUZZER.md` (620 lines). Runs without compiling the contract (~16 ms total),
which is what made it viable inside a SaaS request/response cycle:

| Layer | Approach | Cost | Compilation? |
|---|---|---|---|
| 1 — AST symbolic fuzzer | Extract `ContractProfile`, generate typed edge cases, apply 4 crash-prediction rules | ~5 ms | No |
| 2 — Proptest harness generator | Emit a `fuzz_harness.rs` the user downloads and runs locally | ~1 ms | No (generation only) |
| 3 — Scenario engine | 20 attack scenarios, each an `AttackScenario` impl returning `Option<FuzzCrash>` | ~10 ms | No |

Layer 1 edge-case tables per `ParamType` (`i128` → `0, 1, -1, MAX, MIN, MAX/2, -MAX/2`; `Address` →
zero/self/known-malicious; `String` → empty, 1000 chars, injection payloads; …) are directly
reusable as a `SorobanArbitrary`/`proptest` strategy table.

Coverage is estimated, not measured — `mod.rs` caps it at 95% with the comment
*"we never claim 100% symbolic"*. That honesty matters: it is exactly the gap real coverage-guided
fuzzing (`cargo-fuzz`) fills.

## 6. The 20 attack scenarios

Each is grounded in a real exploit, which is what makes them useful as an invariant catalogue:

| # | Scenario | Grounded in |
|---|---|---|
| S01 | Flash-loan price manipulation | Mango ($114M), Beanstalk ($182M) |
| S02 | Reentrancy / CEI violation | Cream Finance ($130M) |
| S03 | Auth bypass via `.invoker()` | Wormhole ($320M) |
| S04 | Token-transfer integer overflow | BeautyChain BEC ($900M) |
| S05 | DoS via unbounded storage iteration | EVM gas griefing |
| S06 | Admin-key takeover | Parity ($30M), Poly Network ($611M) |
| S07 | **Frozen funds via TTL expiry** | **Soroban-specific** |
| S08 | Sandwich / missing slippage | Uniswap MEV |
| S09 | Hardcoded admin address | — |
| S10 | Unbounded token mint | Cover Protocol ($8M) |
| S11 | Signature replay | Ronin ($625M) |
| S12 | Decimal-precision mismatch | Rari Capital, bZx |
| S13 | Re-initialization attack | Missing idempotency guard |
| S14 | **Temporary storage for auth/nonce state** | **Soroban-specific** |
| S15 | Upgrade without timelock | Nomad ($190M) |
| S16 | Oracle price staleness | Compound, Venus ($200M) |
| S17 | Self-transfer / same-address drain | — |
| S18 | Missing zero-value validation | Vault share inflation |
| S19 | Front-run initialization | Parity ($30M) |
| S21 | Missing two-step admin transfer | OpenZeppelin `Ownable2Step` |

S07 and S14 are the Soroban-native ones — they have no EVM analogue and come straight from the
storage-tier/TTL model described in [Topic 1 §3](../01-stellar-fundamentals/README.md).

## 7. Where the AI sits

`packages/ai-engine/src/prompts.ts` — a single system prompt that receives four inputs
(contract source, static findings, fuzz crashes, RAG-retrieved similar exploits) and returns
structured JSON (score, findings with line + snippet + concrete fix, positives, executive summary).

Notable prompt-engineering decisions, all still valid:

- *"Never speculate. Only report vulnerabilities you can demonstrate with clear evidence in the code."*
- *"False positives destroy trust. When in doubt, do NOT report."*
- Requires a **concrete working code fix**, not advice.
- Requires citing the historical exploit by name, date, and loss amount when RAG supplied one.

The AI here is a **triage and explanation layer** over deterministic analysis — it does not itself
find bugs. Topic 3's differentiator (AI *generating harnesses and proposing invariants*) is the
part ChainGuard did **not** do: Layer 2's harness generator is a `format!`-based template, not AI.

## 8. What was never finished

Honest gaps, useful because they define the risk list for Topic 4:

- Never run end-to-end — Docker/Postgres+pgvector never brought up, exploit corpus never seeded
  (12 of a target 50+ exploits curated).
- No CI, no Dockerfiles, no deployment; `AuditRegistry` never deployed to testnet.
- The repo has **zero git commits** — everything is an uncommitted working tree.
- Model pinned to `claude-sonnet-4-6` (superseded; current default is `claude-opus-5`).
- `soroban-sdk` pinned to `21`, vs `26.1.0` in this repository's workspace.

## 9. What this IDP takes from it

| Takeaway | Used in |
|---|---|
| WASM-in-`Env` is the right dynamic-fuzzing substrate for Soroban | Topic 3 §tooling |
| Symbolic pre-pass is a cheap, useful *triage* filter, not a substitute for real fuzzing | Topic 3 §pipeline |
| The 20 scenarios are a ready-made invariant catalogue | Topic 3 §invariants, Topic 4 |
| The edge-case tables per `ParamType` are reusable `proptest` strategies | Topic 4 |
| "Never speculate / no false positives / concrete fix" prompt discipline | Topic 3 §AI role |
| Estimated coverage is a real limitation — `cargo-fuzz` is what closes it | Topic 3 §tooling |
| Scope must stay small enough to actually finish and demo | Topic 3 §scope |

**Location:** `~/Downloads/ckl` (local, uncommitted).

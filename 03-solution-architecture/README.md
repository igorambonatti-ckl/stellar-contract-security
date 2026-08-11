# Topic 3 — Solution Architecture

**Status:** ✅ Done · **Due:** 2026-07-31 · **Delivered:** 2026-08-11

## 1. Objective

Design the architecture of an **AI-assisted fuzzing solution for Soroban smart contracts** —
deciding concretely what gets built in Topic 4, with what tools, against which contract, measured
how.

This document is not speculative. It is grounded in a prior working prototype
(**[ChainGuard AI](../docs/prior-art-chainguard.md)** — ~6 200 LOC of Rust analysis code plus a
NestJS/React platform) that already implemented and hit the real limits of most of the approaches
under consideration. Where a decision below cites experience rather than theory, that is why.

## 2. Problem statement

Topic 2 established the gap: the Ethereum ecosystem has mature fuzzing tooling (Echidna, Foundry
invariant testing), and Soroban does not. The Rust stack (`cargo-fuzz`, `proptest`,
`SorobanArbitrary`, `cargo-mutants`) supplies the *machinery*, but leaves three jobs to the
developer — and those three jobs are where fuzzing programs actually die:

1. **Writing the harness.** Wiring up `Env`, registering the contract, generating typed arguments,
   catching panics. Pure boilerplate, per function, per contract.
2. **Knowing what to assert.** A fuzzer that only checks "does not panic" finds shallow bugs. The
   valuable invariants (supply conservation, auth enforcement, TTL survival) must be *stated* by a
   human who understands the contract.
3. **Choosing where to look.** Random input over a large state space wastes budget on
   uninteresting paths.

**Thesis of this IDP:** an LLM is well-suited to all three — it can read a contract, emit the
harness, propose candidate invariants, and prioritise suspicious argument shapes. The human curates;
the fuzzer verifies. AI proposes, the fuzzer disposes.

### Scope boundary

This is a **methodology and demonstration**, not a product. Explicitly out of scope: a web platform,
a queue, a database, RAG, GitHub integration, PDF reports, on-chain attestation. ChainGuard already
proved those are buildable and also proved they consume all the time — it was never run end to end
because the platform work crowded out the analysis work. Topic 4 stays a **Rust workspace plus a
prompt library plus a results write-up**.

## 3. Prior art and what it settles

Full inventory: **[`docs/prior-art-chainguard.md`](../docs/prior-art-chainguard.md)**.

Three findings from it are load-bearing here:

**(a) WASM-in-`Env` is the correct dynamic-fuzzing substrate.** ChainGuard's `soroban-fuzzer`
(837 LOC, self-described as an "Echidna-equivalent for Soroban") compiles the contract to
WASM and loads the bytecode into a `soroban-sdk` `Env` with `testutils`, one
fresh `Env` per call. Its stated reasons hold: it works for *any* valid contract (no import or API
compatibility issues), WASM is the contract's real target so macros and `Address::from_string`
behave, and a fresh `Env` gives genuine state isolation — the Soroban analogue of Echidna's fresh
EVM state. **This is the answer to the open question left by Topic 2 §5.**

**(b) Static/symbolic analysis is triage, not verification.** ChainGuard's three-layer symbolic
fuzzer runs in ~16 ms without compiling anything, which is why it fit a SaaS request cycle — but its
coverage number is *estimated*, and `fuzzer/mod.rs` caps it at 95% with the comment
"we never claim 100% symbolic". Cheap pre-pass: yes. Substitute for executing the contract: no.

**(c) Scope discipline is the actual risk.** ChainGuard is feature-complete on paper and was never
run end to end — Docker was never started, the exploit corpus never seeded, nothing ever committed
to git. The architecture below is deliberately smaller than what I already know how to build.

## 4. Architecture

### 4.1 Pipeline

```
                    ┌──────────────────────────────┐
                    │  Target contract (Rust)      │
                    │  soroban-vault               │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────────────────┴───────────────────────────┐
        │                                                      │
        ▼                                                      ▼
┌───────────────────┐                              ┌──────────────────────┐
│  A. AI proposal   │  versioned prompts           │  B. Human curation   │
│                   │  ───────────────────▶        │                      │
│  · invariants     │  Claude Opus 5               │  accept / reject /   │
│  · harness code   │  (claude-opus-5)             │  rewrite each item   │
│  · input priors   │                              │  → invariants.md     │
└───────────────────┘                              └──────────┬───────────┘
                                                              │
        ┌─────────────────────────────────────────────────────┤
        │                                                     │
        ▼                                                     ▼
┌────────────────────────┐                      ┌─────────────────────────┐
│  C. proptest layer     │                      │  D. cargo-fuzz layer    │
│  cargo test, no extra  │                      │  coverage-guided,       │
│  tooling, fast, CI     │                      │  nightly, long-running  │
│  SorobanArbitrary      │                      │  libfuzzer-sys          │
└───────────┬────────────┘                      └────────────┬────────────┘
            │                                                │
            └────────────────────┬───────────────────────────┘
                                 ▼
                    ┌────────────────────────────┐
                    │  E. Findings + triage      │
                    │  minimised reproducer,     │
                    │  → regression test         │
                    └──────────────┬─────────────┘
                                   ▼
                    ┌────────────────────────────┐
                    │  F. cargo-mutants          │
                    │  did the suite actually    │
                    │  catch the bugs? (quality  │
                    │  gate on C+D)              │
                    └────────────────────────────┘
```

The loop that matters is **A → B → C/D → E → A**: findings feed back as new prompt context, so the
next AI proposal round is better informed. That loop, and evidence that it works, is the IDP's
deliverable.

### 4.2 Component decisions

| Component | Decision | Rationale |
|---|---|---|
| Target contract | Purpose-built `soroban-vault` (§5) | Needs rich, checkable invariants + deliberately seeded bugs to prove detection |
| Property testing | `proptest` + `proptest-arbitrary-interop` + `SorobanArbitrary` | Runs under plain `cargo test`, no nightly, CI-friendly. The regression net. |
| Coverage-guided fuzzing | `cargo-fuzz` + `libfuzzer-sys` (nightly) | The depth layer. Closes exactly the gap (b) above — real coverage feedback instead of estimated. |
| Execution substrate | Contract crate compiled with `testutils`, driven through the generated client in a fresh `Env` | Same isolation property as ChainGuard's WASM approach, without the compile-per-run cost, since here we own the contract and can link it directly |
| Test-quality gate | `cargo-mutants` | Answers "are these tests any good?" — mutation score is the only honest measure of a fuzzing suite |
| AI integration | Versioned prompts in `prompts/`, run interactively, outputs committed | See §6 |
| CI | GitHub Actions: `cargo test` + `cargo-mutants` on PR; `cargo-fuzz` on a nightly schedule | Fast layer gates every change; slow layer runs unattended |

**Why link the crate directly rather than fuzz the WASM.** ChainGuard had to accept arbitrary
user-supplied contracts, so compiling to WASM and loading bytecode was the only option that worked
universally. Here the contract is ours and lives in the same workspace, so `cargo-fuzz` can link it
and get **coverage instrumentation** — which the WASM path cannot provide. The trade-off is
accepted deliberately: we lose "works for any contract", we gain coverage-guided mutation. Fuzzing
the deployed WASM is recorded as future work in Topic 5.

## 5. Target contract — `soroban-vault`

A single-asset deposit/withdraw vault with shares. Small enough to finish, rich enough to have real
invariants, and it exercises every Soroban-specific hazard from Topics 1–2.

### 5.1 Interface

```rust
pub fn initialize(env: Env, admin: Address, token: Address);
pub fn deposit(env: Env, from: Address, amount: i128) -> i128;   // returns shares minted
pub fn withdraw(env: Env, from: Address, shares: i128) -> i128;  // returns amount returned
pub fn transfer_shares(env: Env, from: Address, to: Address, shares: i128);
pub fn set_admin(env: Env, new_admin: Address);
pub fn pause(env: Env);
pub fn total_shares(env: Env) -> i128;
pub fn balance_of(env: Env, who: Address) -> i128;
```

Storage layout, deliberately spanning all three tiers:

- **Instance** — `admin`, `token`, `paused`, `total_shares` (global config + accounting).
- **Persistent** — per-address share balances (core user data; must survive, must `extend_ttl`).
- **Temporary** — a short-lived per-address operation nonce (the tier most likely to be *misused*,
  per ChainGuard's SOR-007 / scenario S14).

### 5.2 Invariant catalogue

The scenarios ChainGuard grounded in real exploits map onto this contract as follows. This is the
curated set the AI proposals in Topic 4 will be measured against.

| # | Invariant | Class | Related |
|---|---|---|---|
| I1 | `sum(balance_of(a) for all a) == total_shares()` | Supply conservation | S10 |
| I2 | `total_shares() == 0` ⟺ vault holds no deposits | Supply conservation | S18 |
| I3 | `deposit` then `withdraw` of the returned shares never returns more than deposited | Value conservation | S18 (share inflation) |
| I4 | Only the current admin can `set_admin` or `pause` | Access control | SOR-003, S06 |
| I5 | `transfer_shares`/`withdraw` abort without the sender's `require_auth` | Access control | SOR-001, S03 |
| I6 | No arithmetic operation over- or underflows (`checked_*` everywhere) | Arithmetic | SOR-005, S04 |
| I7 | `amount <= 0` / `shares <= 0` is always rejected, never silently accepted | Input validation | S18 |
| I8 | `transfer_shares(a, a, n)` does not change any balance | Self-transfer | S17 |
| I9 | `initialize` is idempotent-guarded — a second call always aborts | Re-init | S13, S19 |
| I10 | A balance written in one invocation is readable in the next (persistent + `extend_ttl`) | **Soroban TTL** | SOR-009, S07 |
| I11 | Auth/nonce state is never read from a tier that can silently expire | **Soroban storage tier** | SOR-007, S14 |
| I12 | While `paused`, no state-mutating entry point succeeds | State machine | — |

I10 and I11 are the ones with no EVM analogue — they are the reason this work is Soroban research
and not a Rust port of Echidna, and they get the most attention in the write-up.

### 5.3 Seeded bugs

To prove detection rather than assert it, the contract ships with a `seeded-bugs` cargo feature.
Each seed violates exactly one invariant and is individually toggleable, giving a benchmark of
known-answer cases:

| Seed | Bug | Violates |
|---|---|---|
| `bug_overflow` | `+` instead of `checked_add` on `total_shares` | I6 |
| `bug_missing_auth` | `require_auth` dropped from `transfer_shares` | I5 |
| `bug_zero_amount` | `amount > 0` check removed from `deposit` | I7, I3 |
| `bug_self_transfer` | `from == to` not handled — balance duplicated | I8, I1 |
| `bug_no_ttl` | `extend_ttl` omitted on persistent balances | I10 |
| `bug_temp_nonce` | Nonce moved to temporary storage and trusted | I11 |
| `bug_reinit` | `initialize` idempotency guard removed | I9 |

The clean build must pass everything; each seed must be caught by at least one layer. Any seed that
survives is itself a finding — it means the harness or invariant set is inadequate, and that is
worth reporting honestly.

## 6. Where the AI fits

Three insertion points, each with a versioned prompt in `prompts/` and every output committed so
the before/after is auditable.

| # | Prompt | Input | Output | Human role |
|---|---|---|---|---|
| P1 | `propose-invariants.md` | Contract source | Ranked candidate invariants with rationale | Accept / reject / rewrite → `invariants.md` |
| P2 | `generate-harness.md` | Source + curated invariants | `proptest` + `cargo-fuzz` target code | Compile, fix, commit |
| P3 | `prioritise-inputs.md` | Source + function signatures | Per-type edge-case tables and suspicious call sequences | Fold into `Arbitrary` strategies and the corpus seed |

**Model:** Claude Opus 5 (`claude-opus-5`), run interactively. No API client is built — that was the
explicit scope decision, and it is the right one: the deliverable is *evidence that the workflow
produces better fuzzing*, not a CLI. Automating it is Topic 5 future work.

**Prompt discipline**, inherited directly from ChainGuard's system prompt, which got this right:

- Never speculate; only assert what is demonstrable from the code.
- False positives destroy trust — when in doubt, do not report.
- Always produce concrete, compiling code — not advice.
- State the assumption behind each proposed invariant, so a human can check it.

**Honest framing of the AI's role.** ChainGuard used AI as a *triage and explanation* layer over
deterministic analysis; it did not let the model find bugs, and its harness generator was a
`format!` template, not AI. This IDP moves AI one step upstream — into harness and invariant
*authoring* — while keeping the same discipline: **the fuzzer, not the model, is the oracle.** An
AI-proposed invariant is a hypothesis until execution falsifies or survives it.

## 7. Evaluation — how "AI-assisted" gets proven

An architecture that cannot be falsified is marketing. The prototype therefore runs **two arms over
the same seeded-bug benchmark**:

- **Baseline** — a hand-written harness of the kind a developer writes from the Stellar docs in an
  hour: one `proptest` per public function, asserting only "does not panic".
- **AI-assisted** — harness and invariants produced via P1–P3, then curated.

| Metric | Definition |
|---|---|
| **Detection rate** | Seeded bugs caught / 7 |
| **Time to first crash** | Wall-clock per seed, `cargo-fuzz`, fixed budget |
| **Invariant yield** | Curated-and-kept invariants vs. proposed (measures AI precision) |
| **Mutation score** | `cargo-mutants` caught / total mutants — quality of the suite independent of the seeds |
| **Authoring time** | Human minutes to a working harness, both arms |

A negative or mixed result is a legitimate outcome and will be reported as such. "AI proposed 14
invariants, 9 were sound, 3 were subtly wrong, 2 were restatements" is a more useful finding for the
write-up than an unfalsifiable claim of success.

## 8. Repository layout for Topic 4

```
04-prototype-development/
├── README.md                     # results, findings, metrics
├── contracts/
│   └── soroban-vault/
│       ├── src/lib.rs            # contract (+ #[cfg(feature)] seeded bugs)
│       ├── src/test.rs           # unit tests
│       └── tests/
│           ├── proptest_baseline.rs
│           └── proptest_ai.rs
├── fuzz/                         # cargo-fuzz workspace (nightly)
│   ├── Cargo.toml
│   └── fuzz_targets/
│       ├── vault_baseline.rs
│       └── vault_ai.rs
├── prompts/
│   ├── propose-invariants.md
│   ├── generate-harness.md
│   └── prioritise-inputs.md
├── invariants.md                 # curated set, with accept/reject notes per AI proposal
└── results/
    ├── benchmark.md              # the two-arm table
    ├── mutants.md                # cargo-mutants output
    └── crashes/                  # minimised reproducers
```

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Scope creep** — the ChainGuard failure mode | Nothing finishes | Platform work explicitly out of scope (§2). Deliverable is a Rust workspace + prompts + write-up. |
| `cargo-fuzz` needs nightly and long runs | Blocks CI | `proptest` is the CI layer; `cargo-fuzz` runs on a schedule with a fixed budget |
| `SorobanArbitrary` friction on `Address`/`Symbol` | Harness won't compile | ChainGuard's `input_generator.rs` edge-case tables are a proven fallback for hand-writing strategies |
| Seeded bugs too easy → inflated detection rate | Result is meaningless | Bugs are conditional/multi-step (self-transfer, TTL expiry), not one-line typos. Report per-seed, never just the aggregate. |
| AI proposes plausible-but-wrong invariants | False confidence | Every invariant must execute against the clean build before being kept. Rejections are recorded and counted (invariant yield). |
| Time — Topic 4 due 2026-08-31, 20 days | Slip | Cut order if needed: `cargo-mutants` first, then `cargo-fuzz` depth, then seed count. `proptest` + baseline comparison is the irreducible core. |

## 10. Open questions carried into Topic 4

1. Does `SorobanArbitrary` generate `Address` values that produce *meaningful* auth scenarios, or do
   generated addresses always fail `require_auth` uniformly (making I4/I5 trivially satisfied)?
2. Can TTL/state archival (I10, I11) actually be exercised in `Env`, or does testing archival need
   ledger-sequence manipulation the test host does not expose? **This is the highest-uncertainty
   item** — the Soroban-specific invariants are the differentiator, and if `Env` cannot advance
   ledgers far enough to trigger archival, they must be tested another way.
3. Does `cargo-mutants` cope with `#![no_std]` + `soroban-sdk` macro expansion, or does it produce
   unbuildable mutants?
4. Is coverage-guided fuzzing over the linked crate meaningfully better than random `proptest` here,
   or is the contract small enough that `proptest` saturates it?

## 11. Success indicators met

- ✅ Problem statement and an explicitly bounded scope.
- ✅ Pipeline architecture with components, data flow, and the AI feedback loop.
- ✅ Three concrete AI insertion points with defined inputs, outputs, and human checkpoints.
- ✅ Tooling decisions made *with stated rationale and trade-offs*, grounded in prior implementation.
- ✅ Target contract specified — interface, storage tiers, 12 invariants, 7 seeded bugs.
- ✅ Evaluation design that can produce a negative result.
- ✅ Repository layout, CI plan, risk register, and open questions for Topic 4.

## 12. References

Carried forward from Topics 1–2, plus:

- **Prior art:** [`docs/prior-art-chainguard.md`](../docs/prior-art-chainguard.md)
- **`cargo-fuzz`:** https://rust-fuzz.github.io/book/cargo-fuzz.html
- **Fuzzing (Stellar Docs):** https://developers.stellar.org/docs/build/guides/testing/fuzzing
- **`proptest` book:** https://proptest-rs.github.io/proptest/
- **`cargo-mutants`:** https://mutants.rs
- **`soroban-examples` — `fuzzing`:** https://github.com/stellar/soroban-examples
- **State archival (TTL):** https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival

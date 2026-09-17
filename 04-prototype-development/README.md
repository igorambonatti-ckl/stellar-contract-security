# Topic 4 — Prototype Development

**Status:** ✅ Done · **Due:** 2026-08-31 · **Delivered:** 2026-09-17 *(17 days late — see
[§9](#9-schedule-honesty))*

## 1. Objective

Build a working prototype that demonstrates AI-assisted fuzzing applied to a Soroban contract, and
**measure** whether the AI assistance actually helps — against a control, on a benchmark with known
answers, in a way that could have produced a negative result.

Design: [Topic 3 — Solution Architecture](../03-solution-architecture/README.md).
Phase plan and exit gates: [`docs/execution-plan.md`](../docs/execution-plan.md).

## 2. The headline result

| Arm | Oracle | Seeded bugs detected |
|---|---|---|
| **Baseline** — a harness written from the Stellar docs in an hour | "the call does not abort" | **1 / 7** |
| **AI-assisted** — invariants proposed by Claude Opus 5, curated by hand | "read the state back and compare it against an independent computation" | **7 / 7** |

The gap is **not** more inputs, and not a better fuzzing engine — both arms run the same `proptest`
machinery over the same contract with the same case budget. The gap is entirely the **oracle**.

That is a useful result precisely because it is unflattering to the framing "AI writes your fuzzer
for you". What the AI contributed was not automation of the harness boilerplate — that part is
mechanical and it got the SDK details wrong ([§6](#6-what-the-ai-got-wrong)). What it contributed
was *knowing what to assert*, which Topic 2 identified as the job where fuzzing programs actually
die.

## 3. What was built

```
04-prototype-development/
├── contracts/soroban-vault/     # the target: 8 entry points, 12 invariants, 7 feature-gated bugs
│   ├── src/lib.rs               #   contract + seeded bugs behind cfg
│   ├── src/test.rs              #   happy-path unit tests
│   ├── src/test_invariants.rs   #   one hand-written test per invariant — the ground truth
│   └── tests/
│       ├── proptest_baseline.rs #   control arm (P4)
│       └── proptest_ai.rs       #   AI arm (P5)
├── fuzz/                        # cargo-fuzz targets for both arms (P6)
├── prompts/
│   ├── propose-invariants.md    #   P1 — contract source → candidate invariants
│   ├── generate-harness.md      #   P2 — source + curated invariants → harness code
│   ├── prioritise-inputs.md     #   P3 — source → edge-case tables + call sequences
│   ├── inputs/                  #   exactly what each prompt was allowed to see
│   └── raw/                     #   every model output, verbatim and unedited
├── invariants.md                # the curation: accept / reject / rewrite + rationale, per proposal
├── scripts/                     # the fuzzing matrix runner and the end-to-end demo
└── results/                     # evidence per phase
```

Reproduce the headline in about two minutes:

```bash
./04-prototype-development/scripts/demo.sh bug_self_transfer
```

## 4. How the comparison was kept honest

A two-arm benchmark is worthless if the arms can see each other, or if either can see the answers.
Three mechanisms, in increasing order of how much trouble they turned out to be.

**The baseline was written first,** before any prompt was run, to a rule fixed in advance: one test
per entry point, valid-looking inputs, no assertions about resulting state. It cannot encode
knowledge of what the AI later proposed.

**The prompts never saw the seed list** — except that they nearly did. The seeded bugs live in
`src/lib.rs` as `#[cfg(feature = "bug_*")]` blocks with explanatory comments, so **22 lines of the
contract source name a seed or an invariant ID**. Handing the model the source would have handed it
the answer key twice over. The fix is
[`prompts/inputs/vault-clean.rs`](prompts/inputs/vault-clean.rs), the contract with every seed
branch resolved away, *verified by substitution* — swapped in for the real `src/lib.rs` it passes
the same 22/22.

> **This generalises.** In-place `cfg` bug seeding is a common benchmark technique and it makes the
> target un-showable to the system under test. Any benchmark built this way needs the clean view as
> a first-class, verified artifact.

**The model that authored the arm had a clean context.** The assistant driving this IDP had already
read `results/seeds.md` in order to run P0–P4, so it could not author the AI arm without importing
the answers. Each prompt was instead executed by a **separate subagent with an empty context
window**, permitted to open exactly one file. Full accounting, including the three contamination
channels this does **not** close, in [`results/ai-arm-provenance.md`](results/ai-arm-provenance.md).

Curation was deliberately done by the contaminated assistant, because curation is the *human* role
in the pipeline and a human here would also know their own codebase. Every decision is recorded with
its reasoning in [`invariants.md`](invariants.md) so a reader can audit whether a rejection was
principled or convenient.

## 5. What the AI got right

**Invariant yield: 12 kept of 16 proposed (75 %).** Against the Topic 3 §5.2 catalogue, which the
model never saw:

- **10 of 12 catalogue invariants independently re-derived** from the contract source alone.
- **2 missed** — I2 and I7.
- **3 genuinely new** invariants the catalogue did not contain (N1–N3).

The two Soroban-specific invariants are the ones worth dwelling on. I10′ (a persistent entry's TTL
must be the *extended* value, never the post-restoration minimum) and I11 (auth-critical state must
never be read from a tier that can silently expire) are the properties with no EVM analogue — the
reason this is Soroban research rather than a Rust port of Echidna. **The model produced both from
the source alone**, including the non-obvious semantics that `extend_ttl(threshold, extend_to)`
extends only when the remaining TTL is already below `threshold`. It also derived the correct test
design for I11 unprompted: run the sequence twice against two independent `Env`s, expire the
temporary entries in the second run, and assert every observable *except* `last_activity` matches.

It was also disciplined about **not** asserting things that are true of the code as written:
`set_admin` not requiring the new admin's consent, `initialize` having no `require_auth`, the
first-depositor inflation shape. Each was recorded as a design observation rather than a property —
five such observations in total, none of which anyone on this project had written down before.

## 6. What the AI got wrong

Four fixes were needed between the raw output and a passing harness. Logged in full in
[`results/p5-ai-arm.md`](results/p5-ai-arm.md) §2, because "what the AI got wrong" is a deliverable.

1. **The `try_*` failure channel** — assumed `Result<VaultError, InvokeError>`; it is
   `Result<soroban_sdk::Error, InvokeError>`, because `Vault`'s entry points abort via
   `panic_with_error!` rather than returning a typed error. **16 of the 17 compile errors, one root
   cause.** `rustc` caught all of it immediately — the cheap kind of AI error.
2. **The revoked-auth error variant** — asserted `Err(Err(InvokeError::Abort))`; a `require_auth`
   failure actually arrives as `Err(Ok(Error(Context, InvalidAction)))`. Two tests red on the clean
   build. **The model had flagged this itself**, as assumption 1 in its own output, including the
   *wrong* way to fix it: widening to `Err(_)` would have silently degraded the property into the
   weak `is_err()` oracle. Asking for an "Assumptions I could not verify" section cost one paragraph
   of prompt and turned a runtime failure into a five-minute fix with the trap pre-marked. **This is
   the most transferable finding of the phase.**
3. **The token contract's error channel** — the "token-side rejection" arm was written as
   `(Err(Err(_)), _)`, but the Stellar Asset Contract raises a *contract* error of its own, which
   travels through the same channel as a `VaultError`. A latent false positive, found only because
   proptest's shrinker walked into it.
4. A mechanical consequence of (1).

**A reject that was reasoned correctly and was still wrong.** The model actively rejected I7
("non-positive amounts are always rejected") as "a single-line restatement whose only failure mode
is a missing panic that the liveness arm already catches". The premise is false for this
benchmark — removing the guard makes the contract *accept* a zero-value call, which a liveness
oracle sees as success — but the model could not know that, because it never saw the baseline arm.
**The same wall that keeps the benchmark honest denied it the context for a judgement call.** That
cost is real and is not patched away; re-running the prompt with the baseline visible would be a
second round and would be labelled as one.

## 7. Negative and surprising results

The execution plan requires at least one clearly-labelled negative or surprising result. There are
four.

### 7.1 The AI's highest-confidence finding was wrong

The input-prioritisation round identified, as *"the highest-value truncation target in the file"*,
that `withdraw` can burn shares and pay zero when `shares · assets / total` truncates. The reasoning
was specific, cited the right lines, and was stated with more confidence than anything else in
either output.

**It is unreachable.** `assets ≥ total_shares` holds over every reachable state — provable by
induction over the four mutators — and with `assets ≥ total` the payout is never zero.

The reasoning fails in a specific, predictable way: **it analyses one expression locally and never
asks which states are reachable.** Local expression analysis is what an LLM is good at; global
reachability is what it is not. That is a transferable statement about where the human checkpoint
has to sit.

The claim was not merely rejected. The *reason* it is false became invariant **N2**
(`vault_assets() ≥ total_shares()`), which the harness now proves on every run. A refuted AI
hypothesis became a kept invariant — the A→B→C/D→E→A loop from Topic 3 §4.1 working as designed.

### 7.2 Detection coverage exceeded invariant coverage

`bug_zero_amount` targets **I7, which was missed in the proposal round and is not in the curated
set**. The AI arm detects it anyway, in three separate properties, because the harness predicts the
*exact rejection reason* for every input — so a guard that stops rejecting is caught whether or not
anyone wrote down an invariant for it.

Nobody planned this. It is the strongest argument in the whole prototype for **exact-error oracles
over property enumeration**: the enumeration was incomplete and the oracle covered the gap.

### 7.3 The classic integer-overflow bug barely exists in Soroban

Established in P3 and confirmed in P5. With `overflow-checks = true` — the Soroban project template
default — naive `+` and `*` *abort* rather than wrap, so the BeautyChain-style overflow bug has to
be seeded with explicit `wrapping_mul` to exist at all. Scenario S04 in ChainGuard's exploit
catalogue, inherited from EVM thinking, is **substantially less applicable to Soroban than to
Solidity**. That is a genuine ecosystem difference and it argues against porting EVM bug taxonomies
wholesale.

Even seeded, the bug does not fail loudly: the wrapped product trips the downstream `shares <= 0`
guard, so the contract *does* abort and `assert!(result.is_err())` passes. It is caught only because
the AI harness asserts **which** error came back — it predicted `Overflow` and got `ZeroShares`.

### 7.4 A shrunk reproducer is not necessarily an instance of your bug

proptest's shrinker minimises for "smallest failing input", not "smallest input failing for the same
reason". Under `bug_overflow` it reported a minimal input that fails on the **clean** contract too —
it had walked out of the genuine failure and into the unrelated latent false positive of §6.3.

Minimal reproducers must be re-checked against the clean build before they are believed. This is not
documented anywhere in the `proptest` or `cargo-fuzz` material consulted for Topic 2.

## 8. Tooling findings

Two obstacles cost real time and are not in any tutorial. Both are recorded in
[`results/p6-fuzzing.md`](results/p6-fuzzing.md).

**`crate-type = ["lib", "cdylib"]` blocks `cargo-fuzz` on macOS/arm64.** It is *one* Cargo target
emitting two artifacts, so every build produces both — and the cdylib link fails under
SanitizerCoverage flags, which blocks the whole fuzz build even though the fuzz target only ever
needs the rlib. Fixed by dropping to `crate-type = ["lib"]` and producing the `.wasm` on demand with
`cargo rustc --crate-type cdylib`. ASan additionally collides with `soroban-sdk`'s static
initialisers, so the fuzz layer runs `--sanitizer none`.

**`cargo fuzz --features` is silently ignored by cargo-fuzz 0.13.2.** Accepted on the command line,
never forwarded, no error. The first fuzzing matrix run reported that the AI arm had missed
`bug_self_transfer` — when the seed had simply never been compiled in. The runner now **aborts**
unless the seed forces a recompile of the contract crate.

> That near-miss is the single best argument in this project for the execution plan's rule that
> every gate must be a command with an expected result. The wrong number was plausible, it was
> quiet, and it pointed the wrong way.

## 9. Schedule honesty

Topic 4 was due 2026-08-31 and finished 2026-09-17 — **17 days late**. P0–P4 ran roughly two days
*ahead* of plan; the slip is entirely in P5–P9, and the contingency in
[`docs/execution-plan.md`](../docs/execution-plan.md) §6 ("any phase 2+ days late → apply the cut
order") was **not** applied when it should have been. Nothing was cut, so the deliverable is
complete, but the escalation rule existed precisely for this and was not honoured. Recorded rather
than smoothed over.

## 10. Phase status

| Phase | Status | Evidence |
|---|---|---|
| P0 — Environment | ✅ | [`results/p0-environment.md`](results/p0-environment.md) |
| P1 — Spikes (TTL in `Env`, `SorobanArbitrary` addresses) | ✅ 11/11 | [`results/spikes.md`](results/spikes.md) |
| P2 — `soroban-vault` contract | ✅ 22/22, WASM builds | — |
| P3 — Seeded bugs | ✅ 7/7 verified | [`results/seeds.md`](results/seeds.md) |
| P4 — Baseline arm | ✅ detects 1/7 | [`results/benchmark.md`](results/benchmark.md) |
| P5 — AI arm | ✅ detects 7/7 | [`results/p5-ai-arm.md`](results/p5-ai-arm.md) |
| P6 — `cargo-fuzz`, both arms | ✅ | [`results/p6-fuzzing.md`](results/p6-fuzzing.md) |
| P7 — `cargo-mutants` | ✅ | [`results/mutants.md`](results/mutants.md) |
| P8 — Benchmark & write-up | ✅ | [`results/benchmark.md`](results/benchmark.md) + this document |
| P9 — Acceptance | ✅ | [`results/p9-acceptance.md`](results/p9-acceptance.md) |

## 11. Success indicators met

- ✅ A working Soroban contract with 12 checkable invariants and 7 seeded bugs, each **proven** to
      break the invariant it targets.
- ✅ Two fuzzing arms over the same benchmark, differing only in the oracle, with a measured gap.
- ✅ Three versioned AI prompts, every raw output committed unedited, every curation decision
      recorded with rationale.
- ✅ An integrity discipline that was actually enforced, tested, and whose residual holes are stated.
- ✅ Invariant yield, detection rate, mutation score and coverage-guided results, all per seed.
- ✅ Negative and surprising results reported — including one where the AI was confidently wrong and
      one where the plan's own escalation rule was not followed.
- ✅ Reproducible from a clean clone: `scripts/demo.sh`.

## 12. Limitations

Carried into [Topic 5](../05-consolidation-and-presentation/README.md) rather than buried here.

1. **The contract was purpose-built around the invariant catalogue.** A model reading it is reading
   a contract whose shape already implies most of the properties. This inflates the AI arm's
   apparent insight and is inherent to any purpose-built benchmark target.
2. **Same model family authored the contract and the invariants.** What it finds natural to write,
   it finds natural to check.
3. **One contract, one model, one run.** No variance estimate. The 75 % yield and the 7/7 detection
   are single observations, not distributions.
4. **I4 and I5 are asserted weaker than stated** — "only the incumbent authorized" is tested as
   "nobody authorized", so a contract that accepted *any* signer would pass. Flagged by the model
   itself as the biggest hole in its own harness.
5. **The WASM artifact is not what gets fuzzed.** Both arms link the contract crate directly, for
   coverage instrumentation. Fuzzing the deployed bytecode is Topic 5 future work.

## 13. References

- [Topic 3 — Solution Architecture](../03-solution-architecture/README.md) — the design being executed
- [`docs/execution-plan.md`](../docs/execution-plan.md) — phase gates and acceptance checklist
- [`docs/prior-art-chainguard.md`](../docs/prior-art-chainguard.md) — the prototype that grounds the design
- `cargo-fuzz`: https://rust-fuzz.github.io/book/cargo-fuzz.html
- `proptest`: https://proptest-rs.github.io/proptest/
- `cargo-mutants`: https://mutants.rs
- Fuzzing (Stellar docs): https://developers.stellar.org/docs/build/guides/testing/fuzzing
- State archival / TTL: https://developers.stellar.org/docs/learn/encyclopedia/storage/state-archival

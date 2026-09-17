# Benchmark — the two-arm comparison

**Assembled:** 2026-09-17 · **Gate:** [execution-plan.md §P8](../../docs/execution-plan.md)

Two fuzzing arms over the same contract, the same seven seeded bugs and the same case budget,
differing **only in the oracle**.

| Arm | Oracle | Written |
|---|---|---|
| **Baseline** | "the call does not abort" | first, before any prompt was run |
| **AI-assisted** | reads state back and compares it against an independently computed expectation | after, from curated AI proposals |

Reproduce:

```bash
cargo test -p soroban-vault --test proptest_baseline                     # clean: 8/8
cargo test -p soroban-vault --test proptest_ai                           # clean: 11/11
cargo test -p soroban-vault --test proptest_<arm> --features <seed>      # per seed
scripts/p6-fuzz-matrix.sh 300                                            # coverage-guided layer
```

---

## 1. Detection, per seed

Per seed, never as an aggregate — `bug_temp_nonce` trips four distinct tests and an aggregate would
be inflated by it alone (P3 Finding 2).

| Seed | Target | `proptest` baseline | **`proptest` AI** | fuzz baseline | fuzz AI r1 | **fuzz AI r2** |
|---|---|---|---|---|---|---|
| `bug_overflow` | I6 | ❌ | ✅ | ❌ | ❌ | ✅ 113 s |
| `bug_missing_auth` | I5 | ❌ | ✅ | ❌ | ❌ | ✅ 2 s |
| `bug_zero_amount` | I7 | ❌ | ✅ | ❌ | ✅ | ✅ 2 s |
| `bug_self_transfer` | I8 | ❌ | ✅ | ❌ | ❌ | ✅ 124 s |
| `bug_no_ttl` | I10′ | ❌ | ✅ | ❌ | ❌ | ✅ 2 s |
| `bug_temp_nonce` | I11 | ✅ | ✅ | ✅ | ❌ | ✅ 2 s |
| `bug_reinit` | I9 | ❌ | ✅ | ❌ | ✅ | ✅ 2 s |
| **Total** | | **1 / 7** | **7 / 7** | **1 / 7** | **2 / 7** | **7 / 7** |

**Clean-contract control:** every arm passes on the unmodified contract — `proptest` 8/8 and 11/11;
fuzzing 470 749 and 145 564 executions with no crash. Without that, no detection above would be
attributable.

Every detection was verified by reading the assertion message, not the red/green column, against the
P3 criterion: *does the test distinguish the right failure, or merely a failure?* Per-seed
attribution in [`p5-ai-arm.md`](p5-ai-arm.md) §1 and [`p6-fuzzing.md`](p6-fuzzing.md) §2.

### Why the baseline finds exactly one

Its only oracle is *"the call does not abort"*. That partitions the seeds cleanly:

- `bug_temp_nonce` makes admin authority depend on temporary-storage state, so `pause` and
  `set_admin` **abort** on a fresh vault. An abort is the one thing this oracle can see.
- The other six are **silent accounting faults**: the contract accepts the call, returns normally,
  and is simply wrong — shares duplicated on self-transfer, supply inflated by a wrapped
  multiplication, a zero-value deposit accepted, an entry left to be auto-restored, the admin
  overwritten by a second `initialize`. Nothing aborts, so nothing is observed.

### The trap the baseline documents

To keep the correct contract passing, its generators had to be narrowed to valid ranges. That is the
realistic failure mode of unassisted fuzzing: the developer narrows the generators to silence false
alarms and walks the fuzzer away from the edge cases where the bugs live. `bug_overflow` is the
sharpest example — it needs operands near `2^100`, which a "plausible amount" generator of `1..=100_000`
can never reach.

---

## 2. Invariant yield

| Measure | Value |
|---|---|
| Proposals received | 16 |
| Accepted as proposed | 9 |
| Accepted after rewrite | 4 |
| Rejected | 3 |
| **Yield** | **13 / 16 = 81 %** |
| Catalogue invariants independently re-derived | **10 / 12** |
| Catalogue invariants missed | 2 — I2, I7 |
| Genuinely new invariants | 4 — N1–N4 |

Full accept/reject/rewrite decisions with rationale: [`../invariants.md`](../invariants.md).

The two Soroban-specific invariants — I10′ (TTL management) and I11 (temporary-tier authority) — were
both re-derived from the contract source alone, including the non-obvious conditional-extension
semantics of `extend_ttl`.

---

## 3. Mutation score

Independent of the seeds: it measures whether each suite would catch changes *nobody planted*.

| Suite | Raw | Adjusted | Genuine gaps |
|---|---|---|---|
| Hand-written unit + invariant tests | 89 % | **95 %** | 3 |
| Baseline arm alone | 32 % | **34 %** | 41 |
| AI arm alone | 92 % | **98 %** | **1** |

*Adjusted* removes 3 mutants that live in `#[cfg(feature = "bug_*")]` code and so are unreachable in
the clean build, plus 1 provably equivalent mutant. Full classification of every survivor:
[`mutants.md`](mutants.md).

Two results worth carrying forward:

- **The AI arm covers a gap in the hand-written ground truth.** `bump_instance` can be deleted
  entirely and all 22 hand-written tests still pass — including the one written specifically about
  TTL, which checks the persistent entry and not the instance entry. The AI arm catches it via N1,
  an invariant the model proposed and the Topic 3 catalogue did not contain.
- **One genuine gap survives both arms**, and each misses it for the opposite reason: the `proptest`
  arm has the right oracle and a generator that never reaches the boundary; the fuzz arm has the
  right generator and an oracle that tolerates a call which wrongly aborted. Deliberately not
  patched — killing a mutant you have just been shown is overfitting to the measurement.

---

## 4. Effort metrics

The execution plan and Topic 3 §7 both list **"authoring time — human minutes to a working harness,
both arms"**. It was **not collected**, and could not be as specified: *both arms are authored by the
AI assistant*, so wall-clock here compares LLM speed to LLM speed, which does not answer the IDP's
question. Reporting it as though it were human effort would be misleading.

**Decision (2026-09-17): replaced by the proxy metrics below.** The productivity claim this IDP
therefore *cannot* make is "AI assistance makes a developer faster". A human-authored control arm
under a timer is recorded as future work.

| Metric | Baseline | AI arm |
|---|---|---|
| Properties | 8 | 11 |
| Harness size | ~180 lines incl. rig and comments | 1 828 lines as generated |
| Compile iterations to green | 1 | 3 |
| Manual fixes after generation | — | 4 (see below) |
| Runtime, clean, default budget | ~24 s | ~11 s |

### The four fixes, which are the interesting number

| # | Fix | Cost | Model flagged it? |
|---|---|---|---|
| 1 | Wrong type for the `try_*` failure channel | 16 of 17 compile errors, one root cause | ❌ |
| 2 | Predicates to re-express the typed error patterns | consequential to #1 | — |
| 3 | Revoked-auth failure arrives as a host error, not `InvokeError::Abort` | 2 tests red on the clean build | ✅ **including the wrong way to fix it** |
| 4 | The token contract's own error read as a vault violation | latent false positive | ❌ |

Fix 3 is the transferable one: an *"Assumptions I could not verify"* section cost one paragraph of
prompt and pre-marked the exact line, the symptom, and the trap in fixing it.

---

## 5. What this benchmark does not show

- **Not a productivity measurement.** See §4.
- **Not a statistical result.** One contract, one model, one run per arm. 81 % and 7/7 are single
  observations with no variance estimate.
- **Not evidence that AI writes good harness code.** It got the SDK details wrong four times. The
  gap comes from *what to assert*, not from code generation.
- **Not free of benchmark bias.** `soroban-vault` was purpose-built around the invariant catalogue,
  so a model reading it reads a contract whose shape already implies most of the properties.

Full limitations: [Topic 5 §4.1](../../05-consolidation-and-presentation/README.md).

---

## 6. The measurement errors found along the way

Recorded because each produced a plausible wrong number that survived until something contradicted
it, and a benchmark's credibility is the sum of the checks that caught them.

| What was wrong | How it surfaced | What it would have claimed |
|---|---|---|
| `cargo fuzz --features` silently dropped by cargo-fuzz 0.13.2 | The fuzz result contradicted the `proptest` result | "the AI arm missed `bug_self_transfer`" — with the seed never compiled in |
| Round-2 fuzz target crashed on the **clean** contract | The clean-contract control | 8/8 detections, all unattributable |
| Two seeds failing on an assertion that named the wrong property | Reading the failure messages, not the counts | `bug_overflow` attributed to truncation, a hypothesis already refuted in P5 |
| Exact-payout oracle skipping on its own overflow | Tracing which assertion caught `bug_overflow` | a missed detection presented as a passing skip |
| Curation ledger accounting for 15 of 16 proposals | The same trace | yield 75 % instead of 81 % |
| `scripts/demo.sh` not executable in git | The clean-clone gate | a demo that ran only on the author's machine |

Five of the six were caught by a gate the plan specified in advance. The sixth — the assertion
naming the wrong property — was caught by reading output that had already been marked green, which
no gate required.

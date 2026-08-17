# Benchmark — baseline arm (P4)

**Run:** 2026-08-17 · **Gate:** [execution-plan.md §P4](../../docs/execution-plan.md) · **Status:** baseline complete; AI arm pending (P5)

Harness: [`tests/proptest_baseline.rs`](../contracts/soroban-vault/tests/proptest_baseline.rs)

```bash
cargo test -p soroban-vault --test proptest_baseline                      # clean: 8/8
cargo test -p soroban-vault --test proptest_baseline --features <seed>    # per seed
```

## Detection — baseline arm

| Seed | Target invariant | Baseline | Failing test |
|---|---|---|---|
| `bug_overflow` | I6 | ❌ missed | — |
| `bug_missing_auth` | I5 | ❌ missed | — |
| `bug_zero_amount` | I7 | ❌ missed | — |
| `bug_self_transfer` | I8 | ❌ missed | — |
| `bug_no_ttl` | I10′ | ❌ missed | — |
| `bug_temp_nonce` | I11 | ✅ **detected** | `fuzz_pause`, `fuzz_set_admin` |
| `bug_reinit` | I9 | ❌ missed | — |

**Baseline detection rate: 1 / 7.**

Clean contract: 8/8 passing, ~24 s at 256 cases per test.

### Validity check — the misses are not a budget artifact

The first matrix ran at `PROPTEST_CASES=64` (bounded, because shrinking on a failing property is
expensive). "Missed at 64 cases" is not the same claim as "cannot detect", so all six misses were
re-run at **256 cases**. Every one still missed. The limitation is structural, not statistical.

### Why the baseline finds exactly one

The baseline's only oracle is *"the call does not abort"*. That partitions the seeds cleanly:

- `bug_temp_nonce` makes admin authority depend on temporary-storage state, so `pause` and
  `set_admin` **abort** on a fresh vault. An abort is the one thing this oracle can see.
- The other six are **silent accounting faults**. The contract accepts the call, returns normally,
  and is simply *wrong*: shares duplicated on self-transfer, supply inflated by a wrapped
  multiplication, a zero-value deposit accepted, an entry left to be auto-restored, admin
  overwritten by a second `initialize`. Nothing aborts, so nothing is observed.

This is the control result the comparison needs: it leaves six of seven bugs available for the AI
arm to find, and it isolates *what* the AI arm has to contribute — not more inputs, but **an
oracle that inspects state** rather than only liveness.

### The trap the baseline documents

To keep the correct contract passing, the generators had to be narrowed to valid ranges (positive
amounts, affordable balances). That is the realistic failure mode of unassisted fuzzing: the
developer narrows the generators to silence false alarms, and in doing so walks the fuzzer away
from the edge cases where the bugs live. `bug_overflow` is the sharpest example — it needs operands
near `2^100`, which the "plausible amount" generator (`1..=100_000`) can never reach.

## Proxy effort metrics — baseline arm

| Metric | Value |
|---|---|
| Harness size | 8 properties, ~180 lines incl. rig + comments |
| Compile iterations to green | 1 (compiled and passed on first run) |
| Runtime, clean, 256 cases | ~24 s |

## ⚠️ Open: the authoring-time metric is not collectable as specified

Topic 3 §7 and the execution plan both list **"authoring time — human minutes to a working harness,
both arms"**. It cannot be collected as written, because **both arms are authored by the AI
assistant**. Measuring wall-clock here compares LLM speed to LLM speed, which does not answer the
IDP's question (does AI assistance help *a developer*?). Reporting it as though it were human effort
would be misleading.

Three options, pending a decision before the write-up (P8):

1. **Replace it with the proxy metrics above** — harness size, compile iterations, invariant yield.
   Loses the time axis, keeps the benchmark defensible. *(recommended)*
2. **Human-authored baseline** — Igor writes the baseline arm under a timer; only the AI arm is
   assistant-authored. The only option that genuinely measures a productivity delta, at the cost of
   his time.
3. **Keep it, marked "not collected"**, and state the gap explicitly in Topic 5.

Until this is resolved, no authoring-time figure appears in this file. The proxy metrics are
recorded regardless, since they are valid under all three options.

## Next — P5 (AI arm)

The AI arm is measured on the same seven seeds with the same case budget. Integrity rule from the
plan stands: **the prompts see the contract source, never the seed list.** A concrete curation
criterion was already derived in P3 — an invariant of the form "this must revert" is only accepted
if its test distinguishes the *right* failure, not merely *a* failure.

# P7 — Mutation testing

**Run:** 2026-09-17 · **Gate:** [execution-plan.md §P7](../../docs/execution-plan.md) ·
**Tool:** `cargo-mutants`

```bash
scripts/p7-mutants.sh          # three runs: unit, baseline, ai
```

Each suite is scored **separately**, because the phase exists to compare the two arms' quality, not
to produce one number for the repository. `PROPTEST_CASES=64` for every run — `cargo-mutants` re-runs
the suite once per mutant, and the budget is applied equally to both arms, so the comparison stands.

Raw output: [`p7-raw/`](p7-raw/).

---

## 1. Scores

| Suite | Caught | Missed | Timeout | Unviable | Raw score | **Adjusted** | Genuine gaps |
|---|---|---|---|---|---|---|---|
| Hand-written unit + invariant tests | 58 | 7 | 0 | 3 | 89 % | **95 %** | 3 |
| **Baseline arm** alone | 21 | 44 | 0 | 3 | 32 % | **34 %** | 41 |
| **AI arm** alone | 54 | 5 | 6 | 3 | 92 % | **98 %** | **1** |

*Raw score* = caught / (caught + missed + timeout). *Adjusted* additionally removes the 3 unreachable
and 1 provably-equivalent mutants identified in §3.

**This is the seed-independent measurement.** `cargo-mutants` knows nothing about the seven seeded
bugs; it mutilates the contract on its own and asks whether the suite notices. That the baseline
scores 1/7 on seeds and 34 % on mutants — and the AI arm 7/7 and 98 % — is two separate instruments
agreeing, which is the best available evidence that neither number is an artifact of how the
benchmark was designed.

### The timeouts were detections

Six AI-arm mutants timed out at 180 s. A timeout is ambiguous — the suite may have hung, or it may
have failed and spent the budget shrinking. Resolved by re-running those mutants with proptest's
shrinking capped:

```bash
PROPTEST_CASES=64 PROPTEST_MAX_SHRINK_ITERS=1 cargo mutants -p soroban-vault \
  --examine-re 'balance_of|balance_internal|set_balance|checked_add' --timeout 300 \
  -- --test proptest_ai
# → 10 mutants tested in 5m: 10 caught
```

All caught. The time was going into shrinking a failing case, not into a hang. They are counted as
caught. Scoring them as misses would have understated the AI arm by nine points, and assuming it
without checking would have been exactly the sort of unverified number this project keeps finding.

---

## 2. What the baseline misses, and why it is the same finding as everything else

44 survivors, and the shape of them is the whole story:

```
replace Vault::checked_sub -> i128 with 0        MISSED
replace Vault::checked_mul -> i128 with 1        MISSED
replace Vault::set_total_shares with ()          MISSED
replace Vault::total_shares_internal -> i128 with 0   MISSED
replace Vault::touch with ()                     MISSED
```

Every one changes the accounting and none makes the contract abort, so *"the call did not abort"*
remains true. The baseline is not a bad suite by accident — it is a suite whose oracle is
structurally blind to this entire class, and mutation testing says so in a way that owes nothing to
the seed design.

---

## 3. Survivor classification — AI arm

Five survivors. Four are not test gaps at all, and saying so requires looking at each.

### 3.1 Three unreachable mutants — an artifact of feature-gated bug seeding

```
314:18: replace < with ==  in Vault::require_positive
314:18: replace < with >   in Vault::require_positive
314:18: replace < with <=  in Vault::require_positive
```

Line 314 is inside the **seeded-bug branch**:

```rust
#[cfg(not(feature = "bug_zero_amount"))]
if value <= 0 { panic_with_error!(env, VaultError::InvalidAmount); }
#[cfg(feature = "bug_zero_amount")]
if value < 0 { panic_with_error!(env, VaultError::InvalidAmount); }   // ← line 314
```

With the clean build that code is never compiled, so **no suite can ever catch these** — they are
unreachable in the configuration under test, not undetected.

> **This generalises, and it is a cost of the benchmark technique.** In-place `cfg` bug seeding
> inflates the mutant population with mutants that live in code the build excludes. Here it is 3 of
> 65 (≈5 %) and it depresses every suite's score equally, so the *comparison* is unaffected — but a
> project reporting a single absolute mutation score this way would be understating it, silently.
> This is the second way in which `cfg` seeding turned out to interfere with measurement; the first
> was that it made the contract un-showable to the AI ([`ai-arm-provenance.md`](ai-arm-provenance.md)).

### 3.2 One provably equivalent mutant

```
172:19: replace > with >= in Vault::withdraw
```

```rust
if amount > 0 { client.transfer(&vault, &from, &amount); }
```

Relaxing to `>= 0` would transfer on a zero payout — a no-op in the token contract, hence
unobservable. But the stronger statement is available: **the branch condition is always true.**
Invariant **N2** (`assets ≥ total_shares`, which holds over every reachable state) gives
`amount = ⌊shares · A / T⌋ ≥ shares ≥ 1`, so `amount > 0` never fails and the mutation cannot change
behaviour.

Worth pausing on: N2 exists only because the AI's most confident claim — that this exact branch
hides a silent loss — was refuted, and the *reason* it was false was promoted to an invariant. That
same reasoning now classifies this mutant as equivalent. One piece of analysis, two uses.

### 3.3 One genuine gap — and neither arm covers it

```
191:25: replace < with <= in Vault::transfer_shares
```

```rust
if from_balance < shares { panic_with_error!(&env, VaultError::InsufficientBalance); }
```

Under the mutation, transferring **exactly your whole balance** fails. That is a real behavioural
change with a real user impact, and it survives.

Both AI layers were tested against it directly, and each fails for the *opposite* reason:

| Layer | Generator reaches `shares == balance`? | Oracle would notice? | Result |
|---|---|---|---|
| `proptest_ai` | ❌ `amount_strategy()` is literal- and range-based; hitting a live balance exactly is ~1 in 10⁶ per case | ✅ it predicts the exact error and would fail the catch-all | **misses** |
| `vault_ai` (fuzz, round 2) | ✅ the state-relative operand family draws `balance + 0` routinely | ❌ it wraps the call in `try_*` and asserts only on success, so an operation that *wrongly aborted* is tolerated | **misses** |

Verified, not assumed — the mutation was applied by hand and both were run against it:

```
proptest_ai   11 passed        (clean pass under the mutation)
vault_ai      27 146 runs, no crash, 90 s
```

**Each layer has half of what is needed.** The right generator sits in the arm with the wrong
oracle, and vice versa. The fix is small and obvious — predict the outcome for user operations in
the fuzz target the way it already does for admin operations — and it is deliberately **not
applied**, because patching a harness to kill a specific mutant you have just been shown is
overfitting to the measurement, the mutation-testing equivalent of tuning against the seeds. It is
recorded as future work instead.

### 3.4 Unviable mutants

```
replace Vault::admin -> Address with Default::default()          (×3 sites)
```

`soroban_sdk::Address` has no `Default`, so these do not compile. Not a test-quality signal;
excluded from every denominator.

---

## 4. Survivor classification — hand-written suite

Seven survivors: the same 3 unreachable and the same 1 equivalent, plus **3 genuine gaps**:

| Mutant | Gap |
|---|---|
| `191:25: replace < with ==` in `transfer_shares` | same boundary as §3.3, same cause |
| `191:25: replace < with <=` in `transfer_shares` | " |
| `361:9: replace Vault::bump_instance with ()` | **no hand-written test asserts the instance-entry TTL at all** |

The last one is the most interesting result in this phase.

`bump_instance` can be deleted entirely and all 22 hand-written tests — including
`i10_persistent_entries_are_ttl_managed_not_restored`, written specifically about TTL — still pass,
because they check the *persistent* balance entry and nobody checked the *instance* entry.

The AI arm catches it, via **N1** — one of the four invariants that came out of the AI round and were
not in the Topic 3 catalogue. N1 exists because the model noticed, unprompted, that `transfer_shares`
reaches no `bump_instance` path and suggested asserting an instance-TTL floor.

**So the AI arm covers a gap in the hand-written ground truth**, and mutation testing is what
surfaced it. That was not an anticipated outcome: the hand-written suite was built as the reference
the fuzzing arms are measured against, and on this axis the assisted arm is the stricter of the two.

---

## 5. Topic 3 open question 3, answered

> *Does `cargo-mutants` cope with `#![no_std]` + `soroban-sdk` macro expansion, or does it produce
> unbuildable mutants?*

**It copes.** 68 mutants generated from a `#![no_std]` contract behind `#[contract]`,
`#[contractimpl]`, `#[contracttype]` and `#[contracterror]`; 65 build. The 3 that do not are a
legitimate `Default` bound failure, not macro breakage, and `cargo-mutants` classifies them as
unviable on its own.

Two operational caveats for anyone repeating this:

1. **Run it per test target.** A single whole-workspace score would have averaged a 34 % suite with a
   98 % one into a meaningless number. `cargo mutants -- --test <target>` is what makes the phase
   answer anything.
2. **Budget for the timeouts.** A property-test suite that fails *and shrinks* can exceed a sane
   per-mutant timeout, and a timeout is not a miss. Cap shrinking when re-checking (§1).

## 6. Gate P7 verdict

**Passed.**

- ✅ Mutation score recorded separately for the baseline suite and the AI suite.
- ✅ Every survivor classified — genuine test gap vs. equivalent vs. unreachable vs. unviable.
- ✅ The ambiguous outcomes (timeouts) resolved by re-measurement rather than by assumption.
- ✅ Topic 3 open question 3 answered.

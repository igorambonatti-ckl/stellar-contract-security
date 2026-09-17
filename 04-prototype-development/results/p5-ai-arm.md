# P5 — AI arm

**Run:** 2026-09-17 · **Gate:** [execution-plan.md §P5](../../docs/execution-plan.md) ·
**Result:** ✅ harness compiles and passes clean; **detects 7 / 7 seeds**

Artifacts:

| What | Where |
|---|---|
| Prompts | [`prompts/propose-invariants.md`](../prompts/propose-invariants.md), [`generate-harness.md`](../prompts/generate-harness.md), [`prioritise-inputs.md`](../prompts/prioritise-inputs.md) |
| Raw outputs, unedited | [`prompts/raw/`](../prompts/raw/) |
| Inputs the model was allowed to see | [`prompts/inputs/`](../prompts/inputs/) |
| Curation, with accept/reject/rewrite per proposal | [`../invariants.md`](../invariants.md) |
| Integrity enforcement | [`ai-arm-provenance.md`](ai-arm-provenance.md) |
| Harness | [`tests/proptest_ai.rs`](../contracts/soroban-vault/tests/proptest_ai.rs) |

```bash
cargo test -p soroban-vault --test proptest_ai                     # clean: 11/11
cargo test -p soroban-vault --test proptest_ai --features <seed>   # each seed: red
```

---

## 1. Detection — AI arm vs. baseline

| Seed | Target | Baseline | **AI** | Failing property | Attributable? |
|---|---|---|---|---|---|
| `bug_overflow` | I6 | ❌ | ✅ | `prop_exact_share_accounting` | ✅ exact |
| `bug_missing_auth` | I5 | ❌ | ✅ | `prop_i5_no_auth_cannot_decrease_balance` | ✅ exact |
| `bug_zero_amount` | I7 | ❌ | ✅ | `prop_exact_share_accounting`, `prop_i8_transfer_shares`, `prop_sequence_state_invariants` | ✅ exact |
| `bug_self_transfer` | I8 | ❌ | ✅ | `prop_i8_transfer_shares`, `prop_sequence_state_invariants` (I1) | ✅ exact |
| `bug_no_ttl` | I10′ | ❌ | ✅ | `prop_i10_balance_ttl_on_first_write`, `prop_n1_instance_ttl`, +2 | ✅ exact |
| `bug_temp_nonce` | I11 | ✅ | ✅ | `prop_i4_admin_custody`, `prop_i12_pause_semantics`, +4 | ✅ exact |
| `bug_reinit` | I9 | ❌ | ✅ | `prop_i9_reinitialize_rejected` | ✅ exact |

**Baseline 1 / 7 → AI 7 / 7.** Clean build: 11/11 green, ~11 s.

Every detection was checked against the P3 curation criterion — *does the test distinguish the
right failure, or merely a failure?* — by reading the actual assertion message, not just the
red/green. Three are worth quoting.

### `bug_overflow` — the seed P3 predicted would separate the arms

```
deposit(170141183460469231731687303715884105727) returned Err(Ok(Error(Contract, #7)))
but the harness predicted None (T0 = 278294, A0 = 278294)
```

`#7` is `ZeroShares`. The buggy contract's `wrapping_mul` produced a non-positive product, which the
downstream `shares <= 0` guard rejected — so **the contract did abort**, and any oracle of the form
`assert!(result.is_err())` would have passed. The AI harness fails it because it predicted
*specifically* `Overflow` (its own `checked_mul` returned `None`) and got `ZeroShares` instead.

This is the exact failure mode P3 Finding 1 identified as a curation risk, arriving in P5 as a
detection. The requirement "assert **which** error, and that state did not change" — written into
the prompt because of that finding — is what converts this seed from a miss into a hit.

### `bug_zero_amount` — caught by an invariant that was never proposed

I7 was **missed** in the proposal round and is not in the curated set ([`invariants.md`](../invariants.md) §5).
It is detected anyway:

```
withdraw(0) returned Ok(Ok(0)) but the harness predicted Some(InvalidAmount) (held = 2, T = 2, A = 2)
```

The harness's closed-form error oracle predicts the rejection reason for *every* input, so a guard
that stops rejecting is caught whether or not anyone wrote down an invariant for it. **Detection
coverage exceeded invariant coverage**, which was not an anticipated result and is the strongest
argument in this phase for exact-error oracles over property enumeration.

### `bug_no_ttl` — caught by a *new* invariant as well as its target

It fails `prop_i10_balance_ttl_on_first_write` (I10′, its target) **and** `prop_n1_instance_ttl` —
N1, one of the three invariants that came out of the AI round and were not in the Topic 3 catalogue.
N1 exists because the model noticed that `transfer_shares` reaches no `bump_instance` path; that
observation led to asserting the instance TTL floor, which independently catches the seed.

---

## 2. What the AI got wrong — the fix log

The generated harness is 1 828 lines and needed **four** fixes. Logged in full because "what the AI
got wrong" is a deliverable, not an embarrassment.

| # | Fix | Severity | Found by | Predicted by the model? |
|---|---|---|---|---|
| 1 | `type VErr` was `Result<VaultError, InvokeError>`; the real failure channel is `Result<soroban_sdk::Error, InvokeError>` | **16 of 17 compile errors** | `cargo build` | ❌ no |
| 2 | Added `is_verr` / `is_verr_outer` predicates so the typed `Err(Ok(VaultError::X))` patterns could be re-expressed | consequential to #1 | — | — |
| 3 | Revoked-auth failure asserted as `Err(Err(InvokeError::Abort))`; it actually arrives as `Err(Ok(Error(Context, InvalidAction)))` | 2 tests red on the clean build | first run | ✅ **yes — its assumption #1** |
| 4 | The "token-side rejection" arm was written as `(Err(Err(_)), _)`; the Stellar Asset Contract raises a *contract* error (`Error(Contract, #10)`), so it never matched | latent false positive | proptest's shrinker | ❌ no |

**Compile iterations to green: 3.** Wall-clock from raw output to a passing clean run: under an hour.

### On fix 1 — a single wrong assumption, amplified

All 16 compile errors have one cause. `Vault`'s entry points return plain values and abort via
`panic_with_error!` rather than returning `Result<_, VaultError>`, so the SDK cannot type the
failure channel and hands back a raw `soroban_sdk::Error`. The model assumed the typed form, which
is what the SDK produces for contracts that *declare* an error return type. It is a reasonable
wrong guess about a code-generation detail, and `rustc` caught all of it immediately — the cheap
kind of AI error.

### On fix 3 — the model flagged its own bug

Assumption 1 in the raw output reads:

> **Auth failure maps to `Err(Err(InvokeError::Abort))`.** … This is asserted literally in P4 and
> P5. If the host instead reports a `Contract(code)` variant, those two `matches!` arms need
> widening to `Err(Err(_))` — but **not** to `Err(_)`, because `Err(Ok(VaultError::…))` must stay a
> failure (it would mean the call was rejected for an unrelated reason).

That is the bug, its location, its symptom, and — critically — the *wrong* way to fix it, all
written down before the code was ever compiled. The naive widening to `Err(_)` would have silently
turned I5 into the weak `is_err()` oracle. The actual fix (`is_non_contract_abort`: it must have
failed, and not with any `VaultError`) is the one the model's own warning points at.

**This is the most transferable finding of P5.** An "Assumptions I could not verify" section is
cheap to ask for and turned a runtime failure into a five-minute fix with the trap pre-marked.

### On fix 4 — the one nobody predicted, found by the shrinker

Under `bug_overflow` the first run reported a minimised failure of `deposit(i128::MAX)` at
`T0 = 1, A0 = 1`. That input is *not* a manifestation of the seed — it fails on the clean contract
too, because an unaffordable token transfer raises `Error(Contract, #10)` from the SAC, which the
harness's token-rejection arm did not match. proptest's shrinker had walked from a genuine
`bug_overflow` failure into an unrelated latent false positive and reported *that* as the minimal
input.

Two lessons, both recorded in the Topic 5 limitations:

1. **A shrunk reproducer is not necessarily an instance of the bug you found.** Shrinking optimises
   for "smallest failing input", not "smallest input failing for the same reason". The minimal
   input must be re-checked against the clean build before it is believed.
2. **In Soroban, "a contract error" is ambiguous** — it may come from the contract under test or
   from any contract it calls. An oracle that keys on the error *channel* rather than on the error
   *value* cannot tell a vault bug from a token rejection.

---

## 3. Gate P5 verdict

**Passed.**

- ✅ All three prompts committed, with raw outputs preserved unedited.
- ✅ `invariants.md` carries an accept / reject / rewrite decision and rationale for all 16 proposals.
- ✅ Invariant yield computed: **12 / 16 = 75 %**; catalogue recall **10 / 12**; 3 new invariants.
- ✅ Harness compiles and passes on the clean build (11/11).
- ✅ Detection rate recorded per seed: **7 / 7**, each attributable to its target invariant.
- ✅ Effort metrics recorded (proxy metrics, per the decision in `benchmark.md`).
- ✅ Integrity rule enforced and its enforcement documented, including what it could not close.

# P3 — Seeded-bug verification

**Run:** 2026-08-14 · **Gate:** [execution-plan.md §P3](../../docs/execution-plan.md) · **Result:** ✅ all 7 seeds break their target invariant

Reproduce:

```bash
cargo test -p soroban-vault                          # clean: 22 passed
cargo test -p soroban-vault --features <seed>        # each seed: its invariant fails
```

## Matrix

| Seed | Target | Failing test(s) | Match |
|---|---|---|---|
| `bug_overflow` | I6 | `i6_arithmetic_is_checked` | ✅ exact |
| `bug_missing_auth` | I5 | `i5_user_operations_require_sender_auth` | ✅ exact |
| `bug_zero_amount` | I7 | `i7_non_positive_amounts_rejected` | ✅ exact |
| `bug_self_transfer` | I8 | `i8_self_transfer_is_a_noop` | ✅ exact |
| `bug_no_ttl` | I10′ | `i10_persistent_entries_are_ttl_managed_not_restored` | ✅ exact |
| `bug_reinit` | I9 | `i9_reinitialization_is_rejected` | ✅ exact |
| `bug_temp_nonce` | I11 | `i11_temporary_state_is_never_authoritative`, `i12_pause_halts_all_mutations`, `pause_sets_the_flag`, `set_admin_hands_over_the_role` | ✅ hits target, **plus 3 more** |

Clean build: **22/22 passing**, no warnings, WASM builds for `wasm32v1-none`.

---

## Finding 1 — the classic integer-overflow bug is *hard to seed* in Soroban

`bug_overflow` initially failed to break anything: all 22 tests passed with the seed enabled. Two
layers were independently neutralising it.

**Layer 1 — Rust's own overflow checks.** The seed originally replaced `checked_add`/`checked_mul`
with a bare `+`/`*`. In Rust, `+` on `i128` **panics on overflow** in debug builds, and this
workspace's release profile sets `overflow-checks = true` (the Soroban project template default).
So the "buggy" contract aborted just like the correct one. The seed had to be changed to explicit
`wrapping_add`/`wrapping_mul` to represent the bug class at all.

**Layer 2 — a downstream guard, and a non-discriminating test.** Even with wrapping arithmetic the
tests still passed, because the operands happened to wrap *negative*, and the contract's
`shares <= 0` check aborted the call. The test asserted only `is_err()` — "some error occurred" —
which was satisfied by the wrong error, for the wrong reason.

The fix was to choose operands where wrapping yields a **positive, plausible** value:

```
total_shares = 2^28 + 1 ,  amount = 2^100
product      = 2^128 + 2^100  ≡  2^100  (mod 2^128)   → positive
```

That slips past the `shares <= 0` guard and mints an absurd share count, which the correct contract
refuses outright.

**Why this matters beyond the seed.** Two lessons carry into the fuzzing arms:

1. **The BeautyChain-style overflow bug largely does not exist in idiomatic Soroban.** With
   `overflow-checks = true` in the standard template, naive arithmetic aborts rather than wraps.
   Scenario S04 in ChainGuard's catalogue — inherited from EVM thinking — is substantially
   *less* applicable to Soroban than to Solidity. This is a genuine ecosystem difference and belongs
   in the Topic 5 write-up.
2. **`assert!(result.is_err())` is a weak oracle.** It passes when the contract fails for an
   unrelated reason. Any AI-proposed invariant of the form "this must revert" needs the same
   scrutiny during P5 curation: does the test distinguish the *right* failure, or merely *a*
   failure? This is a concrete curation criterion, discovered before the AI arm was written.

## Finding 2 — `bug_temp_nonce` has blast radius beyond its target

It breaks its target (I11) plus `i12`, `pause_sets_the_flag` and `set_admin_hands_over_the_role`.
That is expected rather than wrong: the seed gates admin authority on a temporary-storage value, so
every admin operation is affected, and `pause` in particular — which `i12` depends on.

**Consequence for the benchmark:** this seed is *easier* to detect than the others, because four
distinct tests trip on it. Detection rates must therefore be reported **per seed**, never as a
single aggregate — an aggregate would be inflated by this one. Recorded here so it cannot be
quietly forgotten when `results/benchmark.md` is written.

## Finding 3 — the seeds are not one-line typos

Worth stating explicitly, since Topic 3 §9 lists "seeded bugs too easy" as a risk. Of the seven:

- Three are *omissions* of a guard (`bug_missing_auth`, `bug_reinit`, `bug_no_ttl`) — the realistic
  form, since real bugs are usually a missing check rather than an added mistake.
- Two require multi-step state to expose (`bug_self_transfer` needs a prior deposit;
  `bug_temp_nonce` needs a ledger advance past the temporary TTL).
- One (`bug_overflow`) requires *specifically crafted* operands, as Finding 1 shows — a fuzzer
  that only tries `i128::MAX` and `0` will not find it, because those wrap negative and hit the
  `ZeroShares` guard. This is the one that will most sharply distinguish the two arms in P4/P5.

## Gate P3 verdict

**Passed.** Clean build green; all seven seeds compile and each fails the invariant named in
Topic 3 §5.3. Two seeds were revised during this phase — `bug_overflow` to use wrapping arithmetic,
and its invariant test to use discriminating operands — which is precisely the failure mode this
gate exists to catch: a benchmark built on seeds that do not actually represent bugs would have
measured nothing.

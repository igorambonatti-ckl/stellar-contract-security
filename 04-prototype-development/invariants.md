# Curated invariant set — `soroban-vault`

**Phase:** P5 · **Curated:** 2026-09-17 · **Source proposal:**
[`prompts/raw/propose-invariants.out.md`](prompts/raw/propose-invariants.out.md) (16 proposals, verbatim)

This file is the **human checkpoint** in the Topic 3 §6 pipeline. The AI proposed; this file records
what was kept, what was rewritten, what was thrown away, and — the part that matters — *why*. The
provenance of the proposal, and the lengths gone to keep it uncontaminated by the seeded-bug list,
are documented in [`results/ai-arm-provenance.md`](results/ai-arm-provenance.md).

Curation criterion inherited from P3, and applied throughout: **an invariant of the form "this must
revert" is accepted only if its test distinguishes the *right* failure, not merely *a* failure.**

---

## 1. Summary — the invariant-yield metric

| Measure | Count |
|---|---|
| Proposals received | 16 |
| **Accepted as proposed** | 8 |
| **Accepted after rewrite** | 4 |
| **Rejected** | 4 |
| **Yield (kept / proposed)** | **12 / 16 = 75 %** |

Against the pre-existing Topic 3 §5.2 catalogue, which the model never saw:

| Measure | Count |
|---|---|
| Catalogue invariants independently re-derived | **10 / 12** (I1, I3, I4, I5, I6, I8, I9, I10′, I11, I12) |
| Catalogue invariants **missed** | **2** — I2, I7 |
| **Genuinely new** invariants not in the catalogue | **3** — N1, N2, N3 |

Both numbers matter and they say different things. 10/12 recall on a catalogue derived from a
different process is a strong result for proposal quality. The 4 rejections, and in particular
[R2](#r2--withdraw-truncation-to-zero--the-high-confidence-false-positive), are why the human
checkpoint is not ceremonial.

---

## 2. Accepted — as proposed

These map one-to-one onto the catalogue and needed no change.

| # | Proposal | Catalogue ID | Note |
|---|---|---|---|
| A1 | 1. Share-supply conservation | **I1** | Identical to the catalogue statement, with the addition that the harness must track the address set `H` itself since the contract exposes no enumeration. That caveat is correct and was not in the catalogue. |
| A2 | 2. `transfer_shares` supply-neutral incl. self-transfer | **I8** (+ I1) | Also correctly notes that a uniformly random `to` will essentially never alias `from`, so the self-transfer case must be *forced* by the generator. The catalogue did not say this; a harness that missed it would silently never test I8. |
| A3 | 10. No balance decrease without the holder's auth | **I5** | Correctly identifies that this is only observable in a dedicated `set_auths(&[])` arm, because the main fuzzing loop runs under `mock_all_auths`. |
| A4 | 11. `admin` changes only via `set_admin`, under the incumbent's auth | **I4** | Explicitly carves out that `new_admin` need not consent — i.e. it declined to assert against the code as written. Exactly the discipline asked for. |
| A5 | 13. `initialize` is one-shot | **I9** | |
| A6 | 6. Nothing load-bearing is read from the temporary tier | **I11** | The primary Soroban-specific invariant, re-derived from the source with the right two-run differential test design (run the sequence twice, expire the temporary entries in the second run, assert every observable *except* `last_activity` matches). |
| A7 | 9. `set_balance` leaves the persistent TTL at the bumped level | **I10′** | Re-derived including the reasoning that `BUMP_THRESHOLD < BUMP_AMOUNT` is what makes the extension fire, and the correct warning not to assert on a *repeated* write, where the second `extend_ttl` is legitimately a no-op. |
| A8 | 16. Views are pure and mutually consistent | *(new, low value)* | Kept because it is nearly free to assert and would catch a view that acquired a TTL side effect. Ranked last. |

**On A6 and A7 specifically.** These are the two invariants Topic 3 identified as the Soroban
differentiator with no EVM analogue, and the model produced both from the contract source alone,
correctly, including the `extend_ttl(threshold, extend_to)` conditional-extension semantics. That is
the single most encouraging result in this phase and it is reported as such.

---

## 3. Accepted after rewrite

| # | Proposal | Catalogue ID | What was changed and why |
|---|---|---|---|
| W1 | 3. Share price monotonically non-decreasing | **I3** (strengthened) | **Kept, scope narrowed.** The cross-multiplied form `A₁·T₀ ≥ A₀·T₁` is strictly stronger than the catalogue's round-trip formulation and is the property that actually catches a mispricing. But it needs three exclusions the proposal only partly got right: `T₀ > 0`, `T₁ > 0`, and a skip when either product overflows `i128`. Rewritten to compute both products with `checked_mul` in the harness and **skip** — not fail — on overflow. The model flagged its own uncertainty here (confidence `medium`, "the exclusions are what I am least sure of"); that flag was accurate and is why this one got scrutiny rather than a rubber stamp. |
| W2 | 14. Arithmetic never wraps; non-negativity | **I6** | **Clause (c) kept, clauses (a) and (b) demoted.** The model correctly observed that with `overflow-checks` enabled, (a) and (b) are *loud* — they abort — and therefore add nothing over the baseline's liveness oracle. It kept (c), `balance_of(a) ≥ 0 ∧ total_shares() ≥ 0`, as the silent-detecting clause. That analysis is right and matches P3 Finding 1 independently. The rewrite only makes the demotion explicit and pins the generator to the operand shape that makes a wrap land *positive* — see [§5](#5-what-the-model-did-not-know-and-could-not-have-known). |
| W3 | 12. `paused` is monotone and blocks every mutator | **I12** (strengthened) | **Kept and strengthened.** Part (b) is the catalogue's I12. Part (a) — monotonicity, "there is no `unpause`, so `is_paused()` never transitions `true → false`" — is **new** and is a better property than I12 because it is silent where I12 is loud. Also kept the model's observation that both `is_paused` and `require_not_paused` default to `false` via `unwrap_or`, so a vanished instance entry silently *un*-pauses the vault. Rewritten to assert monotonicity via a harness-side shadow boolean. |
| W4 | 8. Instance-entry TTL floor, and the `transfer_shares` asymmetry | **N1 (new)** | **Kept as two separate things.** The assertion — every bumping mutator leaves the instance TTL ≥ `BUMP_THRESHOLD` — is kept. The *observation* that `transfer_shares` reaches `bump_instance` on **no** path, so a vault whose only activity is share transfers lets its instance TTL decay monotonically while every holder's persistent entry stays alive, is recorded as a **finding**, not an assertion, exactly as the model recommended. It is real, it is not in the Topic 3 catalogue, and nobody on this project had noticed it. Rewritten to split assertion from metric so the clean contract does not fail. |

---

## 4. Rejected

### R1 — "Persistent balances must never silently become zero through archival" (proposal 5)

**Rejected: cannot fail.** This is the original I10, and P1 Spike A already established why it is a
useless fuzzing target: protocol 23 auto-restores archived persistent entries and the test `Env`
models that restoration, so "the balance is still readable after an arbitrary ledger advance" is
**always true**. An invariant that cannot fail consumes budget and reports success forever.

It is replaced by I10′ — proposal 9, accepted as A7 — which keys on the *TTL value* rather than on
data presence, and is falsifiable.

Credit where due: the model did not assert this blindly. Its **Assumption** row reads "if the test
`Env` does *not* model auto-restore, this assertion tests the harness rather than the contract and
will produce a false alarm — that behaviour must be confirmed on the clean contract before the
invariant is enabled." It identified the exact thing that had to be checked. It simply could not
check it, because the answer is in the host, not the source. **That is the correct division of
labour and it worked.**

### R2 — "Withdraw truncation to zero" — the high-confidence false positive

This one is not from the invariant proposal but from the **input-prioritisation** output
([`prompts/raw/prioritise-inputs.out.md`](prompts/raw/prioritise-inputs.out.md) §A3), where it is
called **"the highest-value truncation target in the file"**:

> In `withdraw`, `amount = shares * assets / total` can truncate to `0`, and the `if amount > 0`
> guard then **skips the transfer entirely while the shares have already been burned**. Shares
> destroyed for zero assets, no error.

**It is unreachable.** The scenario requires `shares · assets < total`, which requires
`assets < total`. But `assets ≥ total` is invariant over every reachable state:

- **Base.** The first deposit takes the `total == 0` branch, so `shares = amount` and
  `assets = assets_before + amount ≥ amount = total`.
- **`deposit`, `total > 0`.** `shares = ⌊amount · total / assets⌋ ≤ amount` whenever `assets ≥ total`.
  So `total` grows by at most `amount` while `assets` grows by exactly `amount`. The gap cannot close.
- **`withdraw`.** `amount = ⌊shares · assets / total⌋ ≤ shares · assets / total`. Burning `shares`
  and paying at most the pro-rata share leaves `assets/total` non-decreasing.
- **`transfer_shares`.** Touches neither quantity.

With `assets ≥ total`, `⌊shares · assets / total⌋ ≥ shares ≥ 1`. The payout is never zero.

**How it was handled:** the claim is rejected as an input prior, and the *reason* it is false —
`vault_assets() ≥ total_shares()` — is promoted to a new invariant, **N2**, and asserted. The
harness now proves on every run the thing that makes the AI's finding impossible. A refuted AI
hypothesis became a kept invariant, which is the A→B→C/D→E→A loop working as designed.

This is the most instructive item in the phase. The reasoning was specific, mechanically plausible,
cited the right line numbers, and was stated with more confidence than anything else in either
output — and it is wrong, because it reasons locally about one expression and never asks which
states are reachable. **Local expression analysis is exactly what an LLM is good at, and global
reachability is exactly what it is not.** That is a transferable finding about where to place the
human checkpoint, and it is carried into the Topic 5 write-up.

### R3 — "`total_shares` must never read as 0 while a nonzero balance exists" (proposal 7)

**Rejected: not drivable through the public API.** The scenario needs the instance entry absent
while persistent balances survive. Instance storage shares the contract-instance entry's lifetime,
and the test `Env` gives no supported way to archive the instance while leaving persistent entries
live. The model said as much itself — "whether the harness can actually drive instance data to
absent is the open question" — and rated it `medium`.

Its *consequence* is nonetheless worth recording, because it is sharp: a zero `total_shares` read
makes `deposit` take the `total == 0` branch and mint 1:1 against a vault that already holds assets,
silently diluting every existing holder. Carried to Topic 5 as a hazard that is real on-chain but
not reachable in the test host — i.e. a **limitation of the substrate**, not a non-issue.

### R4 — "Asset movement matches the reported amount exactly" (proposal 4)

**Rejected as an invariant; kept as a harness assertion.** The statement is true and worth checking,
but it is not a property of `Vault` — it is a property of the *token contract*, restated. With the
SDK's own Stellar Asset Contract as the token, it holds by construction; with a fee-on-transfer or
rebasing token it fails for reasons that have nothing to do with this vault's logic. The model
itself listed "the token client is well-behaved" as the assumption.

It stays in the harness as a **cheap consistency check on the fixture** — if it ever fires, the test
rig is broken, not the contract. Counted as rejected for yield purposes because it does not enter
the invariant catalogue.

---

## 5. What the model did not know, and could not have known

Two catalogue invariants were **missed**:

- **I2** — `total_shares() == 0` ⟺ the vault holds no deposits. Not proposed in any form. Proposal 7
  is adjacent but is about archival, not about the biconditional.
- **I7** — non-positive amounts are always rejected. Actively **rejected** by the model, in its
  "considered and rejected" section, as "a single-line restatement whose only failure mode is a
  missing panic that the liveness arm already catches."

**The I7 rejection is defensible reasoning that happens to be wrong here**, and it is worth being
precise about why. The model's premise — "the baseline liveness arm catches it" — is false for this
benchmark, but the model could not know that, because it never saw the baseline arm. Removing the
`amount > 0` guard does not make the contract panic; it makes it *accept* a zero-value call, which
the liveness oracle sees as success. The invariant is silent, not loud. The model mis-classified it
because it was reasoning about a control arm it had no access to.

This is a genuine cost of the isolation discipline: the same wall that keeps the benchmark honest
also denies the model context that would have improved a judgement call. Recorded rather than
patched — re-running the prompt with the baseline arm visible would be a second round, and would be
labelled as one.

---

## 6. The curated set — what the harness asserts

`tests/proptest_ai.rs` implements the following. IDs `I*` are the Topic 3 §5.2 catalogue; `N*` are
new from this phase.

| ID | Property | Class | Silent? | Origin |
|---|---|---|---|---|
| I1 | `Σ_{a∈H} balance_of(a) == total_shares()` | supply conservation | silent | A1 |
| I3 | `A₁·T₀ ≥ A₀·T₁` over `deposit`/`withdraw`, `T₀,T₁ > 0` | value conservation | silent | W1 |
| I4 | `admin` changes only via `set_admin` under the incumbent's auth | access control | silent | A4 |
| I5 | no balance decreases without the holder's auth | access control | silent | A3 |
| I6 | `balance_of(a) ≥ 0 ∧ total_shares() ≥ 0` | arithmetic | silent | W2 |
| I8 | `transfer_shares(a,a,n)` changes nothing; supply-neutral for `a≠b` | self-transfer | silent | A2 |
| I9 | a second `initialize` always fails and changes nothing | re-init | silent | A5 |
| I10′ | after a balance write, `get_ttl(Balance(a)) ≥ BUMP_AMOUNT` | Soroban TTL | silent | A7 |
| I11 | expiring every temporary entry changes no other observable | Soroban storage tier | silent | A6 |
| I12 | `is_paused` never goes `true→false`; while paused, mutators change nothing | state machine | silent (a) | W3 |
| **N1** | every bumping mutator leaves instance TTL ≥ `BUMP_THRESHOLD` | Soroban TTL | silent | W4 |
| **N2** | `vault_assets() ≥ total_shares()` | value conservation | silent | R2 |
| **N3** | views are pure | state machine | silent | A8 |

**I2** and **I7** are not in the AI harness. They remain covered by the hand-written unit tests in
`src/test_invariants.rs`, and their absence here is a measured result, not an oversight — see §5.

Findings recorded but deliberately **not** asserted, because the clean contract exhibits them by
design:

1. `transfer_shares` never bumps the instance TTL (W4).
2. `set_admin` does not require the new admin's consent; the role can be handed to an address that
   can never sign, permanently disabling `pause` and `set_admin`.
3. `initialize` has no `require_auth` — the first caller wins.
4. `transfer_shares` does not `touch` the recipient, so `last_activity(to)` stays stale after `to`
   receives shares.
5. The first depositor after a donation mints 1:1 against an already-funded vault (the classic
   first-depositor inflation shape).

All five came from the AI outputs. None is a bug in the sense the benchmark measures, and all five
are real design observations about the contract that nobody had written down before this phase.

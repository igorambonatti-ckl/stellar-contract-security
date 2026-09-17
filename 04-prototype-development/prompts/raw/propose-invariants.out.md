---
prompt: propose-invariants v1.0
date: 2026-09-17
model: claude-opus-5[1m] (Opus 5, 1M context)
target: prompts/inputs/vault-clean.rs (`soroban-vault`, contract `Vault`)
---

# Invariant catalogue — `soroban-vault`

Scope note: every invariant below is derived only from the source of `vault-clean.rs`. Where I rely on
host behaviour I cannot read (archival semantics, auth enforcement, the token contract's own
correctness, reentrancy policy), it is stated in the **Assumption** row.

Notation used throughout:
- `H` = the set of `Address`es the harness has ever passed to `deposit`, `withdraw`, or
  `transfer_shares` (as `from` or `to`). The harness must track this set itself; the contract
  exposes no enumeration.
- `T` = `Vault::total_shares(env)`.
- `B(a)` = `Vault::balance_of(env, a)`.
- `A` = `token::TokenClient::new(&env, &token).balance(&vault_address)` — the vault's holding of the
  underlying asset, read directly from the token contract, not from the vault.

---

## 1. Share-supply conservation

| Field | Content |
|---|---|
| **Statement** | At every quiescent point (between top-level contract calls), `Vault::total_shares(env) == Σ_{a ∈ H} Vault::balance_of(env, a)`. This must hold after *any* interleaving of `deposit`, `withdraw`, `transfer_shares`, `set_admin`, `pause`, and ledger-sequence advances, including after calls that panicked and rolled back. |
| **Class** | supply conservation |
| **How a harness observes a violation** | Maintain `H` in the harness. After each successful or failed call to any entry point, read `total_shares()` once and `balance_of(a)` for every `a ∈ H`; assert equality of the sum. The three entry points that can move the equation are `deposit` (adds `shares` to both sides), `withdraw` (subtracts `shares` from both sides), `transfer_shares` (moves between two terms of the right-hand side, leaves the left untouched). |
| **Silent or loud** | **Silent.** All three mutators return normally; the mismatch is only visible by summing. This is the single highest-value property in the catalogue because every arithmetic, ordering, or rounding defect in `deposit`/`withdraw`/`transfer_shares` lands here. |
| **Assumption** | That `Balance(Address)` persistent entries and the `TotalShares` instance entry are the *only* representations of share supply, i.e. no other code path writes them. Verified by inspection: writes occur only in `set_balance` and `set_total_shares`. Also assumes the harness's `H` is complete — an address that received shares outside the tracked set would produce a false alarm, so `H` must be seeded from the fuzzer's own address pool. |
| **Confidence** | **high** — directly readable from the three mutators; no host behaviour involved. |

---

## 2. `transfer_shares` is supply-neutral, including the self-transfer path

| Field | Content |
|---|---|
| **Statement** | For any `from`, `to`, `shares`, let `T₀ = total_shares()`, `bf₀ = balance_of(from)`, `bt₀ = balance_of(to)`. After a successful `transfer_shares(from, to, shares)`: (a) `total_shares() == T₀` unconditionally; (b) if `from != to`, `balance_of(from) == bf₀ - shares` **and** `balance_of(to) == bt₀ + shares`; (c) if `from == to`, `balance_of(from) == bf₀` exactly. |
| **Class** | supply conservation / state machine |
| **How a harness observes a violation** | Drive `transfer_shares` with `to` drawn from a pool that deliberately includes `from` itself with non-trivial probability (a uniform random address will essentially never collide, so the self-transfer case must be forced). Read `total_shares`, `balance_of(from)`, `balance_of(to)` immediately before and after. |
| **Silent or loud** | **Silent.** The self-transfer case is the classic silent-inflation shape: `from_balance` and `to_balance` are read into separate locals (lines 163, 173) and written back sequentially (lines 174–175), so if the `from == to` early return at line 168 were absent or ordered after the reads, the second `set_balance` would overwrite the first and mint `shares` out of nothing while returning `()` normally. Invariant 1 would also catch it, but this one localises the fault. |
| **Assumption** | That `Address`'s `PartialEq` is value equality on the underlying account/contract id, so `from == to` genuinely identifies the aliasing case, and that `DataKey::Balance(a)` keys are equal iff `a` is equal. |
| **Confidence** | **high** — all three clauses are read straight off lines 157–177. |

---

## 3. Share price is monotonically non-decreasing across `deposit` and `withdraw`

| Field | Content |
|---|---|
| **Statement** | Define the price ratio as the pair `(A, T)`, compared cross-multiplied to avoid division. For any single successful `deposit` or `withdraw` where `T₀ > 0` and `T₁ > 0` (before and after), it must hold that `A₁ * T₀ >= A₀ * T₁`. Equivalently: no depositor may buy shares below the prevailing price and no withdrawer may redeem above it. The rounding in both formulas is truncating integer division, and both truncations favour the vault. |
| **Class** | value conservation / arithmetic |
| **How a harness observes a violation** | Before the call, read `A₀` from the token client (`balance(&vault_address)`) and `T₀` from `total_shares()`. After, read `A₁`, `T₁`. Assert `A₁ * T₀ >= A₀ * T₁` using `i128::checked_mul` in the harness and skipping (not failing) the case where either product overflows. Applies to `deposit` and `withdraw`; `transfer_shares` leaves both quantities fixed so the assertion trivially holds there too and can be asserted globally. |
| **Silent or loud** | **Silent.** Both `deposit` and `withdraw` return a plausible `i128` while having mispriced. A wrong rounding direction, a stale `assets_before` read, or reading the token balance *after* the transfer in `deposit` (instead of before, line 91) all show up only here. |
| **Assumption** | (a) That the token contract is a faithful SEP-41 token whose `balance` reflects transfers immediately and whose `transfer` moves exactly the requested amount — the harness should use the SDK's own Stellar Asset Contract to make this true by construction. (b) That nobody donates tokens to the vault address *during* the measured call. (c) That `T₀ > 0` — when `T₀ == 0` the price is undefined and `deposit` takes the `shares = amount` branch (line 95) which deliberately ignores `assets_before`, so the assertion must be skipped there. |
| **Confidence** | **medium** — the property follows from the two formulas, but the `T₀ == 0` and `T₁ == 0` boundaries and the overflow skip must be excluded correctly or this will produce false alarms. The exclusions above are what I am least sure of. |

---

## 4. Asset movement matches the reported amount exactly

| Field | Content |
|---|---|
| **Statement** | For a successful `deposit(from, amount) -> shares`: the vault's token balance increases by exactly `amount` and `from`'s token balance decreases by exactly `amount`. For a successful `withdraw(from, shares) -> amount`: the vault's token balance decreases by exactly the returned `amount` and `from`'s increases by exactly it; when the returned `amount == 0` no transfer occurs at all and both token balances are unchanged (line 148 guard). |
| **Class** | value conservation |
| **How a harness observes a violation** | Read `token.balance(&vault)` and `token.balance(&from)` before and after each `deposit`/`withdraw`, and compare the deltas against the call's return value. Note `deposit` returns *shares*, not assets, so the asset delta is compared against the `amount` argument; `withdraw` returns *assets*, so the asset delta is compared against the return value. |
| **Silent or loud** | **Silent.** A transfer of the wrong quantity, or a transfer in the wrong direction, returns normally. |
| **Assumption** | The token client is well-behaved (as in invariant 3) and `from != vault_address` — if the fuzzer ever passed the vault's own address as `from`, both deltas would net to zero and the assertion would need special-casing. I recommend the harness exclude the vault address from its actor pool rather than complicate the assertion. |
| **Confidence** | **high** — reads directly off lines 109 and 148–150. |

---

## 5. Persistent balances must never silently become zero through archival

| Field | Content |
|---|---|
| **Statement** | For any address `a` with `balance_of(a) == b > 0`, advancing the ledger sequence by any amount `Δ` and then reading `balance_of(a)` must still yield `b`. In particular `balance_internal`'s `unwrap_or(0)` (line 277) must never be the branch taken for an address that has a live nonzero balance, no matter how long it sits idle. |
| **Class** | Soroban storage tier / Soroban TTL |
| **How a harness observes a violation** | Deposit for `a`, record `b = balance_of(a)`. Advance `env.ledger()` past `BUMP_AMOUNT` (1_036_800) and well past any plausible persistent TTL — several multiples. Read `balance_of(a)` again and assert it equals `b`. Then attempt `withdraw(a, b)` and assert it succeeds and that invariant 1 still holds afterwards. The same sequence must be run for an address that *received* shares only via `transfer_shares` as `to`, since that path also goes through `set_balance` and therefore through `extend_ttl`. |
| **Silent or loud** | **Silent, and maximally damaging** — the read is `get(...).unwrap_or(0)`, so a vanished entry is indistinguishable from "never had shares". The holder's balance reads as 0, `total_shares` still counts it, and invariant 1 breaks. There is no panic. |
| **Assumption** | That the protocol auto-restores archived **persistent** entries at rent cost and that the SDK test `Env` models this restoration rather than returning `None`. If the test `Env` does *not* model auto-restore, this assertion tests the harness rather than the contract and will produce a false alarm — that behaviour must be confirmed on the clean contract before the invariant is enabled. This is exactly the class of thing I cannot verify from the source. |
| **Confidence** | **medium** — the contract-side reasoning is solid; the uncertainty is entirely in whether the test `Env` reproduces archival/restoration faithfully. |

---

## 6. Nothing load-bearing is read from the temporary tier

| Field | Content |
|---|---|
| **Statement** | The value of `last_activity(a)` — including its being `None` — must have no effect on the result of any other entry point. Formally: for any call sequence `S`, running `S` and running `S` with arbitrary additional ledger advances that expire the `LastActivity(a)` temporary entries must produce identical `total_shares`, identical `balance_of` for all `a ∈ H`, identical `is_paused`, identical `admin`, and identical return values from `deposit`/`withdraw`. |
| **Class** | Soroban storage tier |
| **How a harness observes a violation** | Run a recorded sequence twice against two fresh `Env`s. In the second run, between operations advance the ledger by more than `TEMP_TTL` (17_280) so the `LastActivity` entries lapse. Assert that every observable *other than* `last_activity` itself matches between the two runs. Additionally assert directly that `last_activity(a)` returning `None` never blocks or changes a subsequent `deposit`/`withdraw`/`transfer_shares`. |
| **Silent or loud** | **Silent.** Temporary entries are not restored by the protocol; a contract that started branching on `last_activity` would take a different path after expiry and return normally. In the source as written, `touch` (line 289) only writes and `last_activity` (line 217) only reads for external telemetry — so this invariant should hold, and its value is as a regression trap. |
| **Assumption** | That `env.storage().temporary()` genuinely expires entries in the test `Env` once the ledger advances past the extended TTL, and that no code path I have read consumes `LastActivity`. Inspection confirms the latter: the only `temporary()` accesses are lines 218, 292, 294. |
| **Confidence** | **high** for the contract-side claim (grep-complete over the file); **medium** that the test `Env` models temporary expiry at all. |

---

## 7. `total_shares` must never read as 0 while a nonzero balance exists

| Field | Content |
|---|---|
| **Statement** | If `∃ a ∈ H : balance_of(a) > 0`, then `total_shares() > 0`. Equivalently, the `unwrap_or(0)` in `total_shares_internal` (line 265) must never be the branch taken while persistent balances are live. |
| **Class** | Soroban storage tier / Soroban TTL |
| **How a harness observes a violation** | Deposit for several addresses. Then exercise *only* `transfer_shares` for a long stretch of ledger time — this is the interesting case, because `transfer_shares` is the one mutator that never calls `set_total_shares` and therefore never calls `bump_instance` (see invariant 8). Advance the ledger far beyond `BUMP_AMOUNT` and assert `total_shares() > 0` and that invariant 1 still holds. |
| **Silent or loud** | **Silent and consequential.** A zero `total_shares` read makes `deposit` take the `total == 0` branch at line 94 and mint `shares = amount` 1:1 against a vault that already holds assets — an instant, silent, unbounded dilution of every existing holder. Nothing panics. |
| **Assumption** | That instance storage shares the contract-instance entry's TTL and is subject to archival/restoration like a persistent entry, so that `TotalShares` is either present with its true value or the whole instance (including `Admin`) is gone. If instance data can *never* be observed absent in the test `Env`, this invariant is untestable but harmless. |
| **Confidence** | **medium** — the contract-side implication is certain; whether the harness can actually drive instance data to absent is the open question. |

---

## 8. Every state-mutating call keeps the instance entry's TTL above the operating floor

| Field | Content |
|---|---|
| **Statement** | After any successful `deposit`, `withdraw`, `set_admin`, `pause`, or `initialize`, the instance entry's remaining TTL is at least `BUMP_THRESHOLD` (518_400). Note the asymmetry that makes this worth asserting: `transfer_shares` performs no `bump_instance` — it neither calls `set_total_shares` nor bumps directly — so a vault whose only activity is share transfers lets its instance TTL decay monotonically toward zero while `set_balance` keeps every individual holder's persistent entry alive for `BUMP_AMOUNT`. |
| **Class** | Soroban TTL |
| **How a harness observes a violation** | Inside `env.as_contract(&contract_id, || ...)`, read the instance TTL (`env.storage().instance().get_ttl()`) before and after each mutator. Assert the post-condition above for the bumping entry points. Separately, assert the negative observation for `transfer_shares`: its instance TTL after equals before minus the ledgers elapsed — this documents the asymmetry rather than failing on it, so it should be recorded as a metric, not an assertion, unless the team decides the asymmetry is itself a defect. |
| **Silent or loud** | **Silent.** TTL decay produces no return-value change until the entry is actually gone, at which point invariant 7 fires. |
| **Assumption** | That `get_ttl()` is exposed on instance/persistent storage in the SDK version in use and returns the remaining TTL in ledgers; and that the host's `extend_ttl(threshold, extend_to)` semantics are as the task states (extend only when remaining < threshold, to `extend_to`). The comment at lines 16–18 asserts the constants are chosen to fire against a 4096-ledger floor; I take that as the author's claim, not as verified fact. |
| **Confidence** | **medium** — the call-graph reasoning (which paths reach `bump_instance`) is high-confidence and re-derivable from lines 75, 112–113, 145–146, 185, 192, 270; the TTL-reading API and exact numeric floor are the uncertain parts. |

---

## 9. `set_balance` leaves the holder's persistent TTL at the bumped level

| Field | Content |
|---|---|
| **Statement** | Immediately after any call that writes `a`'s balance (`deposit(a, ..)`, `withdraw(a, ..)`, `transfer_shares(a, to, ..)` for both `a` and `to`), the remaining TTL of `DataKey::Balance(a)` is at least `BUMP_AMOUNT` (1_036_800) — because `BUMP_THRESHOLD < BUMP_AMOUNT`, the `extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT)` at line 285 must fire on a fresh entry whose default TTL is below the threshold. |
| **Class** | Soroban TTL |
| **How a harness observes a violation** | `env.as_contract(&id, || env.storage().persistent().get_ttl(&DataKey::Balance(a)))` after each balance-writing call. Assert `>= BUMP_AMOUNT`. The subtle case to include: a holder whose balance is written repeatedly in quick succession — the second `extend_ttl` is a no-op because remaining TTL is already above `BUMP_THRESHOLD`, which is correct and must not be asserted against. |
| **Silent or loud** | **Silent.** Under-extension shortens the window before archival; it never changes a return value. |
| **Assumption** | Same as invariant 8 regarding `get_ttl` availability, plus the assumption that the host's `min_persistent_entry_ttl` is below `BUMP_THRESHOLD` so a newly created entry actually qualifies for extension. If it is not, the first write would leave TTL at the host default and this assertion would false-alarm; the threshold should be lowered to "`>= min(BUMP_AMOUNT, observed default)`" if that proves to be the case. |
| **Confidence** | **medium** — the arithmetic relation `BUMP_THRESHOLD < BUMP_AMOUNT` is certain from lines 25–27; the host floor is not. |

---

## 10. No address's balance may decrease without that address's authorization

| Field | Content |
|---|---|
| **Statement** | For any address `a`, `balance_of(a)` decreases only within a call in which `a.require_auth()` succeeded. Concretely: `withdraw(a, ..)` and `transfer_shares(a, to, ..)` are the only balance-decreasing paths and both call `from.require_auth()` first (lines 82, 121, 158). Under `env.set_auths(&[])` (or with auth for a *different* address only), any call that would decrease `a`'s balance must fail and leave `balance_of(a)`, `balance_of(to)`, and `total_shares()` all unchanged. |
| **Class** | access control |
| **How a harness observes a violation** | Use `env.set_auths(&[])` rather than `env.mock_all_auths()` for a dedicated arm of the fuzzer. Call `withdraw(victim, n)` and `transfer_shares(victim, attacker, n)` with auth mocked for `attacker` only. Assert both fail and assert the full state triple is byte-identical before and after. Run the same arm against `deposit` — it too requires `from`'s auth and moves `from`'s *tokens*. |
| **Silent or loud** | **Loud if the `require_auth` is present** (it panics), but the *absence* of one is silent from the caller's perspective: the call returns normally and the victim is drained. Because the whole fuzzer is usually run under `mock_all_auths`, this invariant is only observable in a separate no-auth arm — which is why it must be an explicit arm and not a by-product. |
| **Assumption** | That `require_auth` under `set_auths(&[])` actually rejects in the test `Env`, and that a panic in the guest rolls back all storage writes made earlier in the same top-level invocation (so the "state unchanged" half of the assertion is meaningful). Both are standard Soroban behaviour but neither is visible in this file. |
| **Confidence** | **high** for the contract-side mapping of paths to guards; **medium** that the "state unchanged after panic" half holds without relying on rollback semantics I cannot see here. |

---

## 11. `admin` changes only through `set_admin`, and only under the incumbent admin's auth

| Field | Content |
|---|---|
| **Statement** | `Vault::admin(env)` is constant across `deposit`, `withdraw`, `transfer_shares`, and `pause`. It changes only via `set_admin(new_admin)`, and only when the *current* value of `admin` authorized the call (`require_admin` reads `Admin` first, then calls `require_auth` on it — lines 239–242). After a successful `set_admin(x)`, `admin() == x`. Note that `new_admin` is **not** required to authorize, so the admin role can be assigned to an address that never consented; that is the code as written and must not be asserted against. |
| **Class** | access control / state machine |
| **How a harness observes a violation** | Record `admin()` before and after every call. For non-`set_admin` entry points assert equality. For `set_admin`, run one arm under auth for the incumbent (assert it succeeds and the value updates) and one arm under auth for a non-admin (assert it fails and the value is unchanged). Include the sequence `set_admin(B)` then `set_admin(C)` authorized by `A` — the second must fail, because the guard reads the *current* `Admin`. |
| **Silent or loud** | **Silent** in the failure mode that matters: an admin transfer that leaves the old admin still effective, or a `pause` path that clobbers `Admin`, returns normally. |
| **Assumption** | That `require_auth` on the incumbent is the complete access-control story for `pause` and `set_admin` — confirmed, `require_admin` is the only guard on both (lines 183, 190). |
| **Confidence** | **high** — fully derivable from lines 182–193 and 239–242. |

---

## 12. `paused` is monotone and blocks every mutator

| Field | Content |
|---|---|
| **Statement** | (a) Monotonicity: once `is_paused() == true`, no entry point in this contract sets it back to `false` — there is no `unpause`. So `is_paused()` is a non-decreasing boolean over any call sequence. (b) Blocking: while `is_paused() == true`, every call to `deposit`, `withdraw`, and `transfer_shares` fails and leaves `total_shares()` and all `balance_of` unchanged. `set_admin` and `pause` remain callable (they do not consult `Paused`), and the views remain callable. |
| **Class** | state machine / access control |
| **How a harness observes a violation** | Track a harness-side shadow boolean. Assert `is_paused()` never transitions `true -> false`. After a successful `pause()`, fuzz the three mutators and assert each one fails and that the full state snapshot (`total_shares` + all `balance_of`) is identical before and after each attempt. Also assert `pause()` is idempotent and that `set_admin` still works while paused — those are the code as written. |
| **Silent or loud** | Part (b) is **loud** in the correct contract (`VaultError::Paused` panic) and therefore weaker on its own — but the *state-unchanged* half is silent-detecting: a mutator that performed its writes and *then* checked `paused` would panic while having already moved value only if rollback failed, and more usefully a mutator that stopped checking `paused` entirely would return normally with mutated state. Part (a) is **silent**: an accidental unpause writes `false` and returns `()`. |
| **Assumption** | That `is_paused`'s `unwrap_or(false)` (line 213) and `require_not_paused`'s `unwrap_or(false)` (line 249) agree, which they do by inspection — but note both default to *unpaused*, so a vanished instance entry silently un-pauses the vault. That coupling is the real reason to keep this invariant alongside invariant 7. |
| **Confidence** | **high** for (a) and for the blocking set; the monotonicity claim is a grep-complete statement over this file (`Paused` is written only at lines 73 and 191). |

---

## 13. `initialize` is one-shot while the instance lives

| Field | Content |
|---|---|
| **Statement** | While `DataKey::Admin` is present in instance storage, every subsequent `initialize(admin', token')` fails and leaves `admin()`, the token address, `is_paused()`, and `total_shares()` unchanged. Note that `initialize` itself carries **no** `require_auth` on `admin` (line 66) — the first caller wins unconditionally — and the guard checks `Admin` only, not `Token`. |
| **Class** | state machine / access control |
| **How a harness observes a violation** | After a successful `initialize`, fuzz repeated `initialize` calls with fresh random `admin`/`token` addresses interleaved into the operation stream, including under `set_auths(&[])`. Assert each fails and that the four instance-backed observables are unchanged. The high-value composite case: pair this with invariant 7's long-idle scenario and assert that a re-`initialize` after a long gap *cannot* reset `TotalShares` to 0 while persistent balances survive — that combination would silently zero every holder's claim while leaving their balances readable. |
| **Silent or loud** | **Silent** if the guard were weakened: a second `initialize` returns `()` and resets `TotalShares` to `0` and `Paused` to `false` while every `Balance(a)` persists untouched, breaking invariant 1 with no error. |
| **Assumption** | That `has(&DataKey::Admin)` on instance storage returns `false` only when the instance entry is genuinely absent (archived or never written), not transiently. And that instance entries are archivable at all — if they are, the composite case above is reachable in production, which is the point of asserting it. |
| **Confidence** | **high** for the in-lifetime claim (lines 67–69); **low** for the reachability of the post-archival re-initialization, since I cannot see the host's instance-archival rules from this file. |

---

## 14. Arithmetic never wraps and never divides by zero

| Field | Content |
|---|---|
| **Statement** | For all inputs: (a) no `i128` operation in the contract produces a wrapped result — all additions, subtractions, and multiplications on balances and supply go through `checked_add`/`checked_sub`/`checked_mul`, which map failure to `VaultError::Overflow`; (b) neither division is ever reached with a zero divisor — `deposit`'s `numerator / assets_before` is guarded by the `assets_before <= 0` check at line 99, and `withdraw`'s `... / total` is guarded by the `total == 0` branch at line 138; (c) consequently `balance_of(a) >= 0` and `total_shares() >= 0` always. |
| **Class** | arithmetic |
| **How a harness observes a violation** | Fuzz `amount` and `shares` over the full `i128` range including `i128::MIN`, `i128::MAX`, and values near `i128::MAX / total`. After each call assert `total_shares() >= 0` and `balance_of(a) >= 0` for all `a ∈ H`. A wrap would show up as a large-magnitude negative balance or supply. Also drive the specific shape that reaches the guarded division: a vault with `total_shares > 0` whose token balance has been driven to `0` (e.g. every holder withdrew but supply remains, or an external transfer drained it), then call `deposit` — assert it fails with `InvalidAmount` rather than trapping on a division by zero. |
| **Silent or loud** | **Loud** by construction — the workspace enables `overflow-checks`, so even a bare `+` would abort rather than wrap, and the explicit `checked_*` helpers panic with `VaultError::Overflow`. A division by zero is also a trap. That makes (a) and (b) weak as pure liveness properties. The clause worth keeping is **(c)**, the non-negativity postcondition, which is **silent**: a sign error that produced a negative balance without overflowing would return normally. |
| **Assumption** | That `overflow-checks` is genuinely enabled for the profile the harness builds (stated in the task, not visible in this file), and that `require_positive` (line 255) excludes `i128::MIN` from ever reaching `checked_sub` as a negation — it does, since `i128::MIN <= 0`. |
| **Confidence** | **high** — every arithmetic site in the file is accounted for (lines 98, 102, 112–113, 141, 145–146, 174–175, 303–316). |

---

## 15. Withdrawal payout is the exact pro-rata floor

| Field | Content |
|---|---|
| **Statement** | For a successful `withdraw(from, shares)` with pre-call `total_shares = T₀ > 0` and vault asset balance `A₀`, the returned `amount` equals exactly `floor(shares * A₀ / T₀)`. In particular `amount <= A₀` (a holder can never be paid more than the vault holds) and `amount >= 0`. When `T₀ == 0` the return is `0` and no transfer occurs. |
| **Class** | value conservation / arithmetic |
| **How a harness observes a violation** | Read `T₀` and `A₀` before the call; compute the expected value in the harness with `i128` checked arithmetic; compare against the return value and against the observed token-balance delta from invariant 4. Skip the case where `shares * A₀` overflows `i128` (the contract panics there via `checked_mul`, which is the correct behaviour and should be asserted as a failure, not a wrong value). |
| **Silent or loud** | **Silent.** A mis-ordered operand, a division before multiplication (which would truncate to zero for small `shares`), or a rounding-up would all return a plausible number. Note that a legitimate consequence of this formula is that `withdraw` can burn shares and return `0` when `shares * A₀ < T₀`; the harness must treat that as correct, not as a loss bug. |
| **Assumption** | That `A₀` read from the token contract at line 135 is the vault's balance *at that instant* and no concurrent transfer intervenes within the call — true in a single-threaded test `Env`. |
| **Confidence** | **high** — it restates lines 134–142 as a checkable numeric identity against independently-read quantities, which is what makes it more than a restatement of one line. |

---

## 16. Views are pure and mutually consistent

| Field | Content |
|---|---|
| **Statement** | `total_shares`, `balance_of`, `admin`, `is_paused`, and `last_activity` do not mutate observable state: calling any of them any number of times, in any order, leaves `total_shares()`, every `balance_of(a)`, `admin()`, and `is_paused()` unchanged. Additionally `is_paused()` agrees with the guard used by `require_not_paused` — i.e. if `is_paused()` returns `false`, a `deposit` with valid inputs and auth must not fail with `VaultError::Paused`. |
| **Class** | state machine |
| **How a harness observes a violation** | Snapshot full state, call every view a randomised number of times, re-snapshot, assert equality. For the consistency half, immediately after asserting `is_paused() == false`, attempt a well-formed `deposit` and assert the failure (if any) is not `Paused`. |
| **Silent or loud** | **Silent.** A view that bumped a TTL or wrote a cache entry would return the right value while changing storage and rent. Note that none of the views in this file call `extend_ttl` — `balance_of` in particular reads without extending (line 273), which is exactly why invariant 5 matters. |
| **Assumption** | That reading via `storage().get` has no TTL side effect in the host. If reads *do* implicitly extend, the TTL-decay scenarios in invariants 5 and 7 become harder to reach and those invariants may never fire — worth confirming before investing in them. |
| **Confidence** | **medium** — the purity claim is clear from the source; the read-side-effect assumption about the host is the uncertain part, and it is load-bearing for two other invariants. |

---

# Properties I considered and rejected

**Reentrancy / checks-effects-interactions ordering.** `withdraw` deliberately applies effects (lines 145–146) before the token `transfer` (line 149), while `deposit` transfers *before* updating shares (line 109 precedes 111–113). It is tempting to assert "no state is observable mid-call from a malicious token." I rejected it because Soroban's host disallows reentrancy into the same contract by default, so a harness assertion here would test the host, not the contract — and I cannot verify that policy from this file. If the team wants it, it belongs in a separate arm using a deliberately malicious token contract, and the result would be a finding about the platform rather than about `Vault`.

**First-depositor share inflation.** When `total_shares == 0` but the vault already holds donated assets, `deposit` takes the `shares = amount` branch (line 95) and ignores `assets_before` entirely, so the first depositor after a donation mints 1:1 against an already-funded vault. This is a real economic hazard, but it is the code as written — asserting against it would flag the *correct* contract on every run. It is a design finding, not an invariant. I have instead scoped invariant 3 to `T₀ > 0` precisely to avoid this false positive.

**`transfer_shares` does not `touch` the recipient.** Only `from` is touched (line 176); `to` gets no `LastActivity` entry. Asserting "every address whose balance changed has a `last_activity`" would fail on the clean contract. Rejected as a false positive. It is worth recording as an observation about telemetry completeness, not as an assertion.

**`set_admin` does not require the new admin's consent.** Line 182 takes `new_admin` with no `require_auth`, so the role can be handed to an address that never agreed and, if that address is unspendable, the admin role is permanently lost. A real hazard, but again the code as written — invariant 11 explicitly carves it out rather than asserting against it.

**`initialize` has no `require_auth`.** Anyone can be the first caller and set themselves as admin. Front-runnable in production, but not a property violation of the deployed code; it is a deployment-procedure concern. Folded into invariant 13 as a documented non-assertion.

**"`deposit` always returns a positive value" / "`withdraw` always panics on insufficient balance."** Both are single-line restatements whose only failure mode is a missing panic that the liveness arm already catches. Rejected per the brief's preference for multi-quantity properties. The `shares <= 0` check at line 105 is subsumed by invariant 3.

**Gas / CPU-instruction budget bounds.** Observable via `env.budget()`, and a sudden blow-up would be a real regression, but it is a performance property, not a correctness invariant, and it is too environment-sensitive to encode as a hard assertion in a fuzzer without producing noise.

**Event emission.** The contract emits no events at all — there is no `env.events().publish` anywhere in the file — so there is nothing to assert. Worth flagging to the team as an observability gap, but not an invariant.

**Exact TTL numeric values after `extend_ttl`.** I considered asserting `get_ttl() == BUMP_AMOUNT` exactly rather than `>=`. Rejected: the host may apply a maximum cap (the comment at line 27 mentions a 6_312_000 host maximum) and the ledger advances during the call, so an exact-equality assertion is brittle. Invariants 8 and 9 use lower bounds for that reason.

**Cross-address isolation ("a call by `a` never changes `b`'s balance").** Nearly true but false for `transfer_shares`, where `to`'s balance changes under `from`'s auth alone — which is intended. Stating the correct version requires enumerating the exception, at which point it collapses into invariants 2 and 10. Rejected as redundant.

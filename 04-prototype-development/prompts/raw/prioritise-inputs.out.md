---
prompt: prioritise-inputs v1.0
date: 2026-09-17
model: claude-opus-5[1m] (Claude Opus 5, 1M context)
target: soroban-vault (vault-clean.rs)
---

# Input prior for the `soroban-vault` fuzzing campaign

## 0. Orientation — where the reachable state space actually is

Before the tables, the structural facts that determine which inputs are worth budget. Everything below is derived from these.

**A0. The amount/shares guard is `value <= 0` → `InvalidAmount`.** So the entire negative half of `i128`, plus `0`, collapses to a single equivalence class for `deposit.amount`, `withdraw.shares`, `transfer_shares.shares`. Uniform sampling over `i128` spends ~50% of its budget re-deriving `InvalidAmount` and ~50% on magnitudes that die in `checked_mul` or in the token contract. The productive band is `1 ..= vault-token-balance-ish`, plus a thin shell of deliberately-chosen giant values.

**A1. The first deposit is unbounded and sets the scale of everything.** With `total == 0`, `shares = amount` verbatim — no cap, no relation to `assets_before`. So `total_shares` after call #1 is *exactly* an attacker-chosen `i128`. This is the single most important lever in the contract: it is how the fuzzer gets `total` up to `2^64` or `i128::MAX` so that the *second* deposit's `checked_mul(amount, total)` sits on the overflow boundary. Reachability is gated only by whether the token contract will actually transfer that much (see A6).

**A2. `total == 0` does not imply `assets_before == 0`.** Two ways to reach "zero shares, non-zero assets": (i) direct token transfer to `env.current_contract_address()` before anyone deposits; (ii) withdraw every share while `shares * assets / total` truncates down, leaving dust. In state (ii) the next depositor takes the `total == 0` branch and mints `shares = amount` against a pool that already holds assets — the exchange rate is silently reset and the residual assets are donated to them. This is a value-conservation property, not a panic, so the fuzzer must be *oracled* on it, not just on aborts.

**A3. Division truncates toward zero and there is no minimum-shares floor.** In `deposit`, `shares = amount * total / assets_before`; if `amount * total < assets_before` the result is `0` and the call aborts with `ZeroShares` — but at `amount * total` just ≥ `assets_before` it returns `1`. That `1`-vs-`0` cliff is the classic share-inflation setup. In `withdraw`, `amount = shares * assets / total` can truncate to `0`, and the `if amount > 0` guard then **skips the transfer entirely while the shares have already been burned** (lines 145–150). Shares destroyed for zero assets, no error. This is the highest-value truncation target in the file.

**A4. Ordering of guards inside `deposit` is observable.** `checked_mul(amount, total)` runs *before* the `assets_before <= 0` check. So in the state `total > 0 && assets_before <= 0`, a large `amount` yields `Overflow (6)` and a small `amount` yields `InvalidAmount (3)`. Any property that asserts "empty-vault deposit ⇒ error 3" is falsifiable by input magnitude alone.

**A5. `transfer_shares` moves balances but never touches `total_shares`** — correct, and the invariant `Σ balances == total_shares` is the one to assert. The routes that can break it are `withdraw`'s pair of `checked_sub`s and the `from == to` early return (line 168–171), which returns *after* the `InsufficientBalance` check but *before* any arithmetic. Note the self-transfer is checked against balance first, so `transfer_shares(u, u, balance + 1)` must error and `transfer_shares(u, u, balance)` must be a pure no-op. Also note `to` is never `touch`ed, so `last_activity(to)` stays stale/absent after receiving shares.

**A6. The token client is an external call and a fuzzable oracle in its own right.** `deposit` reads `client.balance(&vault)` *before* transferring (correct), but credits shares from the *requested* `amount`, not from the delta actually received. A fee-on-transfer or rebasing token breaks accounting without any panic. If the harness can substitute a mock token, `balance()` return value is effectively a fuzzable argument — see the pseudo-argument table.

**A7. `overflow-checks = true` changes the failure mode, not the reachability.** All the explicit `checked_*` helpers convert overflow into a clean `VaultError::Overflow (6)`. The *unguarded* native operators are the two `/` divisions (deposit line 102, withdraw line 141) and the implicit ones inside the SDK. Division by zero is guarded on both paths (`assets_before <= 0`, `total == 0`), and `i128::MIN / -1` is unreachable because `require_positive` filters the negatives. So a bare panic (unreachable/abort, not error 6) from arithmetic is a *finding*, not expected behaviour — worth a dedicated oracle: "every abort must carry a `VaultError` code in 1..=7".

**A8. `initialize` has no `require_auth` on `admin`.** Any caller can claim the vault. Also `set_admin` does not `require_auth` on `new_admin`, so the admin role can be handed to a non-signer address (including the token contract or the vault itself) and become permanently unexercisable — `pause` and `set_admin` then both dead-end.

**A9. `pause` is one-way.** There is no `unpause`. Once `pause` fires, `deposit`/`withdraw`/`transfer_shares` all abort with `Paused (5)` forever. For a sequence fuzzer this is an absorbing state: seeds that call `pause` early waste the rest of their budget. Put `pause` **last** in almost every seed, except the one or two seeds whose whole point is testing the paused guard.

**A10. `last_activity` lives in the temporary tier** with `TEMP_TTL = 17_280` used as *both* threshold and extend-to. Since `extend_ttl` only fires when remaining TTL is already below the threshold, and it extends to the same 17_280, the entry's TTL is effectively pinned at 17_280 and will expire ~1 day after the last touch. Any property of the form "after a deposit, `last_activity(u).is_some()`" is ledger-dependent and will flake unless the seed controls ledger advance. That makes ledger advance a first-class fuzz dimension, not a nuisance.

---

## Part 1 — Per-argument edge-case tables

### 1.1 `initialize(env, admin: Address, token: Address)`

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `admin` | `Address` | `pool[0]` (canonical admin) | Baseline; establishes the only principal that can `pause`/`set_admin`. |
| `admin` | `Address` | `pool[1]` (a plain user) — call `initialize` from a *different* principal | No `require_auth` on `admin` (line 66–76). Any caller can install any admin. Property: "the caller of `initialize` must be authorized" is violated by construction. |
| `admin` | `Address` | `pool[5]` = the vault's own `current_contract_address()` | Admin is a contract that cannot sign → `pause`/`set_admin` permanently unreachable. Locks the vault into a no-admin state. |
| `admin` | `Address` | `pool[4]` = the token contract address | Same lock-out, plus aliasing `admin == token`, which any code assuming distinctness will trip on. |
| `admin` | `Address` | same value as `token` | Aliasing edge: `DataKey::Admin` and `DataKey::Token` hold identical values; exercises anything that compares them. |
| `token` | `Address` | registered Stellar-Asset-Contract address | The only value that makes `deposit`/`withdraw` do anything; nearly every deep seed needs it. |
| `token` | `Address` | `pool[1]` — a *non-contract* account address | `token::TokenClient::new` succeeds lazily; the failure surfaces at the first `client.balance()` inside `deposit`. Tests that the abort is a host error, not a `VaultError` — relevant to the A7 oracle. |
| `token` | `Address` | vault's own address | `client.balance(&vault)` becomes self-referential; `transfer(&from, &vault, ..)` on a non-token contract. |
| `token` | `Address` | mock token whose `balance()` is fuzz-controlled | Turns `assets_before` into a directly-steerable argument (see 1.6). Highest leverage substitution in the whole harness. |
| *(call ordering)* | — | `initialize` twice; `initialize` never (call `deposit` first) | Second call ⇒ `AlreadyInitialized (1)`. Note the re-entry guard checks **only** `DataKey::Admin`; a hypothetical path that sets `Token` without `Admin` would be re-initializable. Skipping `initialize` ⇒ `NotInitialized (2)` from `token_address`, but **only after** `require_auth`, `require_not_paused` and `require_positive` have run — so `deposit(u, -1)` on an uninitialized vault returns `InvalidAmount (3)`, not `NotInitialized (2)`. That error-precedence pair is worth an explicit seed. |

### 1.2 `deposit(env, from: Address, amount: i128) -> i128`

`amount` is the single most important scalar in the campaign. Tables split by *why* the value matters.

#### (a) Type boundaries

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `amount` | `i128` | `0` | Exact boundary of `require_positive` (`value <= 0`). Must give `InvalidAmount (3)`. |
| `amount` | `i128` | `-1` | First value below the guard; cheapest negative representative. |
| `amount` | `i128` | `i128::MIN` = `-170141183460469231731687303715884105728` (`-2^127`) | The value with no positive counterpart. If any future refactor negates or takes `abs`, this aborts under `overflow-checks`. Currently must be a clean `InvalidAmount (3)`. |
| `amount` | `i128` | `i128::MAX` = `170141183460469231731687303715884105727` (`2^127 - 1`) | Maximum admissible. As a *first* deposit (`total == 0`) it sets `total_shares = i128::MAX`, arming every subsequent `checked_mul`/`checked_add` to overflow. Gated only by whether the token will move that much. |
| `amount` | `i128` | `1` | Minimum admissible; the inflation-attack seed value. |
| `amount` | `i128` | `2` | Smallest value where `total == 0` gives `total_shares = 2`, making `/ 2` truncation reachable in one step. |

#### (b) Contract-guard boundaries

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `amount` | `i128` | `ceil(assets_before / total)` | The exact `shares == 1` boundary. With `total = 1`, `assets_before = 1_000_000_000`: `amount = 1_000_000_000` ⇒ `shares = 1`. |
| `amount` | `i128` | `ceil(assets_before / total) - 1` | The exact `shares == 0` boundary ⇒ `ZeroShares (7)`. With the same state: `amount = 999_999_999` ⇒ `999_999_999 * 1 / 1_000_000_000 = 0`. The one-unit difference between these two rows is the whole `ZeroShares` guard. |
| `amount` | `i128` | `assets_before / total` when `total > assets_before` | Any `amount < assets_before/total` truncates to 0. With `total = 10^9`, `assets_before = 1`: every `amount` from `1` upward gives `amount * 10^9 / 1` — huge; invert the state (`total = 1`, `assets_before = 10^18`) and every `amount < 10^18` gives `ZeroShares`. Shows the guard is *state*-selected, not value-selected. |
| `amount` | `i128` | `1` while `total > 0 && assets_before == 0` | Hits A4's short branch: `checked_mul(1, total)` succeeds, then `assets_before <= 0` ⇒ `InvalidAmount (3)` — an error code that does not describe the amount at all. Misleading-error finding. |
| `amount` | `i128` | `i128::MAX` while `total > 1 && assets_before == 0` | Same state, different code: `checked_mul` overflows first ⇒ `Overflow (6)`. The A4 error-ordering divergence. |

#### (c) Values chosen so an *intermediate* lands on a boundary

All of these are about `numerator = amount * total` (deposit line 98) and `balance + shares` / `total + shares` (lines 112–113). `total` is set by an earlier call — see the state column.

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `amount` | `i128` | `amount = 2^63 = 9223372036854775808`, with state `total = 2^64 = 18446744073709551616` | Product is exactly `2^127 = 170141183460469231731687303715884105728` = `i128::MAX + 1`. Overflows by **exactly one unit** — the tightest possible `checked_mul` boundary. Must give `Overflow (6)`, never a wrap or an abort. |
| `amount` | `i128` | `amount = 2^63 - 1 = 9223372036854775807` (`i64::MAX`), state `total = 2^64` | Product `= 2^127 - 2^64` — the largest product that still *fits*. The "just under" partner of the row above; proves the boundary is at the right place and not off by one. |
| `amount` | `i128` | `amount = 2^63`, state `total = 2^64 - 1` | Product `= 2^127 - 2^63`. Second "just under" witness from the other operand. |
| `amount` | `i128` | `amount = 2`, state `total = i128::MAX` | Product `= 2 * (2^127 - 1)` — overflow by the widest margin with the smallest possible amount. Demonstrates that after a max first-deposit, *every* `amount >= 2` is dead. |
| `amount` | `i128` | `amount = 1`, state `total = i128::MAX`, `assets_before = i128::MAX` | Product `= i128::MAX` exactly — the largest non-overflowing product, and `shares = 1`. The single surviving deposit in a maxed-out vault. |
| `amount` | `i128` | `amount = 2^100 = 1267650600228229401496703205376`, state `total = 2^27 = 134217728` | Product `= 2^127` — overflow by exactly one unit again, from a very differently-shaped operand pair. Useful because mutators that flip high bits reach `2^100` far more easily than `2^63`. |
| `amount` | `i128` | `amount = 2^126 = 85070591730234615865843651857942052864`, state `total = 1` | Product `= 2^126`, fits; `shares = 2^126 / assets_before`. Then `checked_add(total, shares)` with `total = 1` approaches `i128::MAX` — pushes the *addition* to the boundary rather than the multiplication. |
| `amount` | `i128` | `amount` s.t. `balance + shares == i128::MAX` exactly | Targets `checked_add` at line 112. Reach it by: first deposit `amount = 2^126` (⇒ `balance = 2^126`, `total = 2^126`, `assets = 2^126`), then a second deposit of `amount = 2^126 - 1` ⇒ `shares = (2^126 - 1) * 2^126 / 2^126 = 2^126 - 1`, so `balance = 2^127 - 1 = i128::MAX` — the exact maximum, no overflow. One more unit (`amount = 2^126`) overflows both the balance add and the total add. |
| `amount` | `i128` | `10_000_000` (`10^7`) | One whole unit of a 7-decimal Stellar asset. The realistic-magnitude anchor; keeps some of the corpus in the band where the token contract actually cooperates. |
| `amount` | `i128` | `9_223_372_036_854_775_807` (`i64::MAX`) | Classic Stellar assets top out at `i64::MAX`; a wrapped classic asset will start rejecting around here, so this is the boundary between "vault rejects" and "token rejects". |
| `amount` | `i128` | `170141183460469231731687303715884105727 / 2` (`= 2^126 - 1`) and `2^126` | Halves of the range: two deposits of these sizes sum to exactly `i128::MAX`/overflow respectively. |
| `from` | `Address` | `pool[1]` (never deposited before) | `balance_internal` returns the `unwrap_or(0)` default; first write to the persistent tier. |
| `from` | `Address` | `pool[5]` = the vault's own address | `client.transfer(&vault, &vault, &amount)` — self-transfer inside the token; `assets_before` unchanged by the transfer. Vault holds shares in itself. |
| `from` | `Address` | `pool[4]` = the token contract address | The token transferring to the vault from itself-as-account; aliasing edge in the token client. |
| `from` | `Address` | unauthorized / unmocked principal | `require_auth` rejects before any state is read — confirms the auth guard is genuinely first (line 82), ahead of `require_not_paused`. Worth one seed to pin the precedence: on a *paused* vault, an unauthorized caller must fail on auth, not on `Paused (5)`. |

### 1.3 `withdraw(env, from: Address, shares: i128) -> i128`

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `shares` | `i128` | `0`, `-1`, `i128::MIN` | `require_positive` boundary and its below-boundary neighbours; same reasoning as deposit. |
| `shares` | `i128` | `balance` (exact) | Full exit. Drives the holder to 0 and, if sole holder, `total_shares` to 0 while `assets` may stay > 0 by truncation ⇒ sets up state A2. The most productive single value in the file. |
| `shares` | `i128` | `balance + 1` | Exact `InsufficientBalance (4)` boundary (line 126, `balance < shares`). |
| `shares` | `i128` | `balance - 1` | The largest value that leaves non-zero dust; maximises truncation residue. |
| `shares` | `i128` | `i128::MAX` | Guaranteed `InsufficientBalance (4)` for any realistic balance — cheap, and confirms the balance check runs *before* `checked_mul`, so no `Overflow (6)` leaks out first. Order: `require_positive` → balance check → mul. |
| `shares` | `i128` | `1` with state `total > assets` | `amount = 1 * assets / total = 0` ⇒ **shares burned, no transfer** (lines 145–150). Concrete state: deposit `10^18` (⇒ `total = assets = 10^18`), have the token drain the vault to `assets = 1` (or use a fee-on-transfer/mock token), then `withdraw(u, 1)` ⇒ `1 * 1 / 10^18 = 0`. Loss of shares for zero assets, returns `Ok(0)`, no error. |
| `shares` | `i128` | largest `shares` with `shares * assets < total` | The full "burn for nothing" band, not just its smallest member: with `assets = 1`, `total = 10^18`, **every** `shares` in `1 ..= 10^18 - 1` transfers nothing. A property "`withdraw` returning 0 must not decrease `total_shares`" fails across that whole band. |
| `shares` | `i128` | `shares = 2^63`, state `assets = 2^64` | `checked_mul(shares, assets)` = `2^127` ⇒ `Overflow (6)` by exactly one unit — the withdraw-side twin of the deposit boundary. Reaching `assets = 2^64` requires a first deposit (or a direct token transfer) of that size. |
| `shares` | `i128` | `shares = 2^63 - 1`, state `assets = 2^64` | The fitting neighbour: product `2^127 - 2^64`. |
| `shares` | `i128` | `shares = 3`, state `total = 3`, `assets = 10` | `3 * 10 / 3 = 10` — exact, no dust. Contrast seed: with `total = 3`, `assets = 10`, `withdraw(u, 1)` thrice yields `3 + 3 + 3 = 9`, so 1 unit is stranded. **Splitting a withdrawal loses value versus doing it in one call** — a clean, easily-asserted non-monotonicity. |
| `shares` | `i128` | `shares = total` while another holder still has shares | Only reachable if balances and `total` have desynced; if it succeeds, `checked_sub(total, shares)` drives `total` to 0 with balances outstanding. Any success here is a direct `Σ balances == total` violation and should be an oracle, not just a crash check. |
| `from` | `Address` | address with zero balance | `balance_internal` default 0; `0 < shares` ⇒ `InsufficientBalance (4)`. Baseline. |
| `from` | `Address` | recipient of a `transfer_shares` who never deposited | Withdraws assets it never contributed — exercises the balance/total decoupling and the fact that `transfer_shares` never `touch`ed the recipient. |
| `from` | `Address` | the vault's own address (after a self-deposit) | The vault withdrawing to itself: `client.transfer(&vault, &vault, &amount)` with `assets` read before the burn. |

### 1.4 `transfer_shares(env, from: Address, to: Address, shares: i128)`

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `shares` | `i128` | `0`, `-1`, `i128::MIN` | `require_positive` boundary. Note negative would otherwise *steal* (sub-negative = add), so this guard is load-bearing — assert it hard. |
| `shares` | `i128` | `from_balance` exactly | Drains the sender to 0; the persistent entry is written as `0` rather than deleted, so `balance_of` still reads 0 but the entry exists and keeps getting TTL-extended. |
| `shares` | `i128` | `from_balance + 1` | `InsufficientBalance (4)` boundary (line 164). |
| `shares` | `i128` | `from_balance + 1` **with `from == to`** | Ordering probe: the balance check (line 164) precedes the self-transfer early-return (line 168). Must error, *not* silently no-op. If the two were ever reordered, a self-transfer of an impossible amount would succeed — exactly the kind of reorder a mutation would introduce. |
| `shares` | `i128` | `from_balance` **with `from == to`** | Must be an exact no-op that still calls `touch` — `last_activity` updates, `balance_of` unchanged, `total_shares` unchanged. Note it returns *before* touching `to`, which is the same address, so the observable is identical; the interesting assertion is that no balance write happened at all. |
| `shares` | `i128` | value s.t. `to_balance + shares == i128::MAX` | Targets `checked_add` at line 175. Build it: user A first-deposits `2^126`, user B first-deposits... (not possible — second deposit is rate-scaled), so instead A first-deposits `i128::MAX`, transfers `1` to B, then transfers `i128::MAX - 1` to B ⇒ B's balance hits `i128::MAX` exactly. One more unit ⇒ `Overflow (6)`. This is the only clean route to a balance-side overflow, since `transfer_shares` can concentrate all supply into one address. |
| `shares` | `i128` | `1`, repeated many times between the same pair | Cheap sequence filler that stresses `set_balance`'s `extend_ttl` call on every write and the persistent-tier write amplification. |
| `to` | `Address` | `pool[5]` = vault's own address | Shares stranded in the vault itself; the vault can only withdraw them if something can authorize as the contract. Supply becomes unredeemable while still counted in `total_shares` — breaks "total redeemable == total_shares". |
| `to` | `Address` | `pool[4]` = token contract address | Same stranding, different aliasing. |
| `to` | `Address` | `pool[0]` = admin | Admin accumulating shares; combine with `pause` for a griefing sequence. |
| `to` | `Address` | fresh address never seen before | First persistent write for `to` via a path that is *not* `deposit`; the recipient is never `touch`ed, so `last_activity(to) == None` despite a non-zero balance. Assert the invariant "non-zero balance ⇒ recent activity" and watch it fail here. |
| `from`/`to` | `Address` | `from == to` where both are the vault address | Double aliasing; combines the self-transfer return with the contract-address case. |

### 1.5 Admin and view entry points

| Entry point / Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|
| `set_admin.new_admin` | `Address` | current admin (self-reassignment) | Idempotence; must not break `require_admin`. |
| `set_admin.new_admin` | `Address` | vault's own address / token address / any non-signable contract | No `require_auth` on `new_admin` (line 182–186) ⇒ the admin role is irrecoverably transferred to something that cannot sign. `pause` and `set_admin` become permanently unreachable. One-way state change with no recovery path. |
| `set_admin.new_admin` | `Address` | a pool member, called *twice in a row* by the old admin | The second call must fail `require_admin` — verifies the role actually moved and that `bump_instance` didn't mask a failed write. |
| `set_admin` | — | called on an **uninitialized** vault | `require_admin` → `admin_address` → `NotInitialized (2)`. Cheap, but pins that the error is 2 and not an auth abort. |
| `pause` | — | called by admin, then any mutator | Absorbing state (A9). Every seed containing `pause` should place it last or second-to-last. |
| `pause` | — | called twice | Idempotent; second call re-runs `bump_instance`. |
| `pause` | — | called by a non-admin | `admin.require_auth()` fails — note it requires auth *from the admin*, not from the caller, so in a harness with blanket `mock_all_auths` this guard evaporates entirely. **Use scoped auth mocking, not `mock_all_auths`, or every access-control property is vacuously true.** This is the single most likely way for this campaign to produce false green. |
| `balance_of.who` | `Address` | never-seen address | `unwrap_or(0)`; must not panic and must not create an entry. |
| `last_activity.who` | `Address` | never-seen address | `None`. |
| `last_activity.who` | `Address` | address touched > 17_280 ledgers ago | `None` again, because the temporary entry expired (A10). The *same* address gives `Some` or `None` depending purely on ledger position — a genuine flake source for naive properties. |
| `total_shares` / `admin` / `is_paused` | — | before `initialize` | `total_shares` ⇒ `0` (silent default), `is_paused` ⇒ `false` (silent default), `admin` ⇒ `NotInitialized (2)` (panic). Inconsistent treatment of "uninitialized": two views lie, one errors. Worth a seed that calls all three on a virgin vault. |

### 1.6 Pseudo-arguments (not in any signature, but fuzzable and decisive)

These are the hidden inputs. If the harness does not expose them, exposing them is the highest-value harness change available.

| Pseudo-argument | Reached via | Values worth trying | Why |
|---|---|---|---|
| `assets_before` (vault token balance) | direct token transfer to `env.current_contract_address()`, or a mock token's `balance()` | `0` | Selects the A4 branch: with `total > 0`, `deposit` gives `InvalidAmount (3)` or `Overflow (6)` depending on `amount`. |
| `assets_before` | same | `1` | Maximally amplifies `amount * total / 1` — division is a no-op, so the product's full magnitude survives into `shares`, pushing `checked_add(total, shares)` to overflow with modest `amount`. |
| `assets_before` | same | `total + 1` | Minimal donation that makes `shares < amount` for the next depositor — the first click of the inflation ratchet. |
| `assets_before` | same | `10^9` with `total = 1` | The canonical inflation state: any deposit below `10^9` mints 0 shares (`ZeroShares`), and a deposit of `2 * 10^9` mints 2 shares against a pool the attacker half-owns. |
| `assets_before` | same | `2^64`, `2^127 - 1` | Withdraw-side `checked_mul(shares, assets)` overflow boundaries (see 1.3). |
| `assets_before` | same | strictly *less* than what the vault owes | Makes `withdraw`'s final `client.transfer(&vault, &from, &amount)` fail after state has already been mutated. Effects-before-interaction means the whole tx reverts, so this should be safe — assert that it is. |
| ledger sequence | `env.ledger().set_sequence_number` between calls | `0`, `1` | `touch` writes `sequence()` as `u32`; sequence `0` is indistinguishable from "absent-then-defaulted" in any comparison that uses `unwrap_or(0)`. |
| ledger sequence | same | `+17_279`, `+17_280`, `+17_281` after a `touch` | Exact `TEMP_TTL` expiry boundary for `last_activity` (A10). Three-point probe around the cliff. |
| ledger sequence | same | `+518_399`, `+518_400`, `+518_401` | `BUMP_THRESHOLD` boundary — the point at which `extend_ttl` actually fires for persistent balances and the instance. Below threshold: no-op. Probes whether a balance can be archived between two calls in a sequence. |
| ledger sequence | same | `+1_036_800` and `+1_036_801` after the last `set_balance` | `BUMP_AMOUNT` horizon: persistent balance entries expire. A balance that vanishes while `total_shares` (instance tier, separately bumped) survives is a live `Σ balances != total_shares` divergence caused purely by *time*. The most interesting ledger-driven finding available. |
| ledger sequence | same | `u32::MAX = 4294967295` and `u32::MAX - 1` | `sequence()` is `u32`; near-max values probe any `sequence + ttl` arithmetic in the host and the `Option<u32>` round-trip. |
| auth set | harness auth mocking | admin-only, user-only, empty, all | See the `pause` row in 1.5 — auth scope is an input, and blanket mocking destroys Part 2 entirely. |

---

## Part 2 — Address arguments

### 2.1 The pool

Fuzz an index `u8 % POOL_LEN` (or `u32 % POOL_LEN`) rather than an `Address`. Eight slots, chosen so that every *aliasing* relation the contract can observe is representable:

| Index | Principal | Auth available? | Why it must be in the pool |
|---|---|---|---|
| `0` | **Admin** — the address passed to `initialize` | yes | The only principal that passes `require_admin`. Every `pause`/`set_admin` seed needs it. |
| `1` | **User A** — ordinary depositor | yes | The default actor; first depositor in most seeds. |
| `2` | **User B** — ordinary depositor | yes | Needed for every multi-holder property: proportional withdrawal, share dilution, `transfer_shares` between distinct holders. |
| `3` | **User C / attacker** — ordinary depositor with a large token balance | yes | The inflation-attack actor: needs to both deposit `1` and donate a large amount directly to the vault. Keep it distinct from A/B so the oracle can attribute value movement. |
| `4` | **Token contract address** | no | Aliasing target. `deposit(from = token)`, `transfer_shares(to = token)`, `initialize(admin = token)`. Exercises the contract's assumption that principals and the token are disjoint. |
| `5` | **Vault's own address** (`current_contract_address()`) | no | The most dangerous alias: `deposit(from = vault)` becomes a token self-transfer with `assets_before` measured on the same account; `transfer_shares(to = vault)` strands supply; `set_admin(vault)` bricks admin. |
| `6` | **Unauthorized principal** — a valid address for which auth is *never* mocked | no | The negative control for every `require_auth`. Without it, no auth property is falsifiable. |
| `7` | **New admin** — a principal never used as depositor | yes | Clean target for `set_admin`, so admin-rotation seeds don't confound with balance state. |

Two harness requirements that follow:

- **Do not use `mock_all_auths`.** Use `mock_auths` scoped per invocation, driven by the same index, so that index `6` genuinely fails. Otherwise `require_auth`, `require_admin`, and therefore `pause`/`set_admin` are all untested and the campaign reports false coverage (A8, and the `pause` row of 1.5).
- Seed the token balances of indices `1,2,3` asymmetrically (e.g. `10^7`, `10^12`, `10^18`) so that magnitude and identity are independent dimensions; otherwise the fuzzer cannot separate "this failed because of who" from "this failed because of how much".

### 2.2 Index combinations worth prioritising

Ranked. `(from, to)` pairs for `transfer_shares`; single indices elsewhere.

| Rank | Combination | Why |
|---|---|---|
| 1 | `(1, 2)` and `(2, 1)` — distinct ordinary holders | The baseline non-trivial transfer; both directions, because the sender is `touch`ed and the recipient is not, so the pair is asymmetric in observable state. |
| 2 | `(1, 1)` — self-transfer | The early-return branch (line 168). Must no-op *and* still `touch`. Pair with `shares = balance` and `shares = balance + 1` (see 1.4). |
| 3 | `(3, 5)` — user → vault | Strands shares in an address that can never `withdraw` them. `total_shares` still counts them. |
| 4 | `(1, 6)` — holder → unauthorized principal | Shares land on a principal that can never move or redeem them; combined with the auth-scoped harness this creates permanently frozen supply. |
| 5 | `(6, 1)` — unauthorized sender | Must fail at `require_auth` (line 158) *before* any balance is read. Negative control. |
| 6 | `(0, 1)` — admin as an ordinary holder | Verifies the admin has no special path through `transfer_shares`; also sets up "admin holds shares then pauses" griefing. |
| 7 | `(1, 4)` — holder → token contract | Aliasing; the token contract now holds vault shares. |
| 8 | `deposit(from = 5)` — vault deposits into itself | `client.transfer(&vault, &vault, &amount)` while `assets_before` was read from that same account. Value accounting where source and sink coincide. |
| 9 | `set_admin(new_admin = 5)` then `pause()` | Admin handed to a non-signer, then the old admin tries to act. Irrecoverable-lockout probe. |
| 10 | `initialize(admin = 1, token = 1)` — admin aliased to token, neither a real token | Degenerate init; every later `deposit` fails at the client call. Confirms the failure is a host abort, not a silent success. |
| 11 | `(2, 3)` where `2` has zero balance | `InsufficientBalance (4)` from a holder-shaped but empty account. |
| 12 | Any pair where both indices resolve to index `5` | Self-transfer *and* contract-address aliasing simultaneously. |

Weighting suggestion: draw the index with a skew, not uniformly — roughly `{1: 25%, 2: 20%, 3: 15%, 0: 15%, 5: 10%, 6: 8%, 4: 4%, 7: 3%}`. Indices 4/5/7 are rare-but-high-signal; uniform sampling over eight slots wastes a third of the budget on aliasing cases that mostly abort early.

---

## Part 3 — Call sequences

Ranked by expected yield per unit of budget. Notation: `U1 = pool[1]`, `U2 = pool[2]`, `U3 = pool[3]`, `ADM = pool[0]`, `V = pool[5]`. "donate X" = a direct token transfer to the vault address, outside the contract. "advance N" = ledger sequence `+N`.

| # | Sequence | What state it builds | What it would expose |
|---|---|---|---|
| 1 | `initialize(ADM, tok)` → `deposit(U3, 1)` → donate `10^9` → `deposit(U1, 10^9)` | `total = 1`, `assets = 10^9 + 1`, single attacker holder, rate inflated ~10^9× | The `ZeroShares (7)` cliff (A3). `10^9 * 1 / (10^9 + 1) = 0` ⇒ victim's deposit reverts. Bump the victim to `2*10^9 + 2` and it mints exactly `2` shares against a pool it funded ~2/3 of ⇒ direct value transfer to U3. The canonical vault bug and it is reachable in four calls. |
| 2 | `initialize` → `deposit(U1, 10^18)` → `withdraw(U1, 10^18)` → `deposit(U2, 1000)` | `total` returns to `0` while `assets` may retain truncation dust; U2 then takes the `total == 0` branch | State A2. If any dust remains, U2 mints `shares = 1000` against a pool holding `1000 + dust`, silently absorbing the residue; and the `total == 0` branch means the exchange rate is reset with no reference to `assets_before` at all. Assert `assets == 0` after step 3 — if it isn't, the invariant "total==0 ⇒ assets==0" is already broken. |
| 3 | `initialize` → `deposit(U1, 10^18)` → donate to make `assets = 1` (or mock-token drain) → `withdraw(U1, 1)` | `total = 10^18`, `assets = 1` | `amount = 1 * 1 / 10^18 = 0` ⇒ the `if amount > 0` guard skips the transfer **after** `checked_sub` already burned the share (lines 145–150). Returns `Ok(0)`. Shares destroyed, nothing paid, no error raised. The clearest silent-loss path in the contract. |
| 4 | `initialize` → `deposit(U1, 3)` → donate `7` (so `assets = 10`, `total = 3`) → `withdraw(U1, 1)` → `withdraw(U1, 1)` → `withdraw(U1, 1)` | Non-divisible rate `10/3` | Splitting the exit yields `3 + 3 + 3 = 9`; a single `withdraw(U1, 3)` yields `10`. Truncation makes withdrawal **non-additive**, and the lost unit is stranded with `total = 0`, feeding straight into sequence #2's state. A differential oracle (split vs. whole) catches this without needing to know the "right" answer. |
| 5 | `initialize` → `deposit(U1, 2^64)` → `deposit(U2, 2^63)` | `total = 2^64` after the unbounded first deposit (A1) | Second deposit computes `checked_mul(2^63, 2^64) = 2^127` ⇒ `Overflow (6)` by exactly one unit. Neighbour seeds `amount = 2^63 - 1` (fits) and `2^63 + 1` (overflows) bracket the boundary. Verifies the overflow surfaces as error 6, not as an `overflow-checks` abort (A7). |
| 6 | `initialize` → `deposit(U1, i128::MAX)` → `transfer_shares(U1, U2, 1)` → `transfer_shares(U1, U2, i128::MAX - 1)` | U2's balance walks up to exactly `i128::MAX` | Targets `checked_add` at line 175 from both sides: the last transfer lands the recipient on the exact maximum (must succeed), and one more unit must give `Overflow (6)`. `transfer_shares` is the only route that can concentrate the entire supply on one address, so this is the only way to reach the balance-add boundary. |
| 7 | `initialize` → `deposit(U1, 10^12)` → `deposit(U2, 10^12)` → `transfer_shares(U1, U2, balance(U1))` → `withdraw(U2, balance(U2))` | Two holders, then full concentration, then full exit by a principal who acquired most shares without depositing them | The core conservation property: U2 should receive at most what U1 + U2 put in. Interleaves distinct principals through all three mutators and exercises `transfer_shares`'s non-update of `total_shares` (A5) against `withdraw`'s update of both. Any mismatch shows up as `total_shares != 0` or residual assets at the end. |
| 8 | `initialize` → `deposit(U1, 10^9)` → advance `1_036_801` ledgers → `withdraw(U1, 10^9)` | Persistent balance entry has outlived `BUMP_AMOUNT`; instance entry (holding `total_shares`) was bumped separately | A10 / the `BUMP_AMOUNT` row of 1.6. If the balance entry is archived while `total_shares` survives, `balance_internal` returns its `unwrap_or(0)` default and the withdrawal fails with `InsufficientBalance (4)` against a `total_shares` that still counts the position — funds unreachable, invariant broken by elapsed time alone. Probe `+518_399 / +518_400 / +1_036_800 / +1_036_801` as separate seeds to bisect which TTL constant governs. |
| 9 | `initialize` → `deposit(U1, 10^9)` → advance `17_281` → `last_activity(U1)` → `deposit(U1, 1)` → `last_activity(U1)` | Temporary entry expires, then is recreated | The `TEMP_TTL` cliff (A10). `None` → `Some` transition driven purely by ledger position; pins that `touch`'s `extend_ttl(TEMP_TTL, TEMP_TTL)` cannot actually extend beyond one TTL window, since threshold == extend-to. Any property phrased "after deposit, activity is recorded" must be ledger-scoped. |
| 10 | `initialize` → `deposit(U1, 10^9)` → `pause()` (as ADM) → `withdraw(U1, 10^9)` → `transfer_shares(U1, U2, 1)` | Absorbing paused state with live deposits outstanding (A9) | Every exit path returns `Paused (5)`; there is no `unpause`. Funds are permanently locked by a single admin call. Also verifies `require_not_paused` runs *after* `require_auth` in all three mutators, so an unauthorized caller on a paused vault fails on auth first. |
| 11 | `initialize(ADM, tok)` → `set_admin(V)` (as ADM) → `pause()` (as ADM) → `pause()` (as V) | Admin role moved to a non-signable contract address | A8. The first `pause` must now fail (role moved) and the second can never be authorized ⇒ the vault is permanently unpausable and the admin role is unrecoverable. Two one-way doors composing into a dead end. |
| 12 | `deposit(U1, -1)` → `deposit(U1, 1)` → `initialize(ADM, tok)` → `deposit(U1, 1)` | Uninitialized vault probed before init | Error-precedence pinning (1.1, last row): call 1 gives `InvalidAmount (3)` because `require_positive` precedes `token_address`, while call 2 gives `NotInitialized (2)`. Two different errors for the same uninitialized vault, selected by the *amount*. Also confirms a failed pre-init deposit leaves no state that blocks `initialize`. |
| 13 | `initialize` → `deposit(U1, 10^7)` → `deposit(V, 10^7)` → `withdraw(V, balance(V))` | The vault holds shares in itself | Aliasing: `client.transfer(&vault, &vault, ..)` with `assets_before` read from the same account, so the deposit's rate calculation uses a balance that its own transfer does not change. Value accounting where source and sink coincide. |
| 14 | `initialize` → `deposit(U1, 10^7)` → `transfer_shares(U1, U2, 10^7)` → `withdraw(U2, 10^7)` → `last_activity(U2)` | U2 holds and redeems shares it never deposited | `transfer_shares` never `touch`es `to` (A5), so between calls 3 and 4 U2 has a non-zero balance and `last_activity(U2) == None`. Falsifies "non-zero balance ⇒ recorded activity". Also the minimal end-to-end value path that never has the recipient interact with `deposit`. |
| 15 | `initialize` → `deposit(U1, 2^126)` → `deposit(U2, 2^126 - 1)` → `transfer_shares(U2, U1, 1)` | Balances summing to exactly `i128::MAX` | The `checked_add` at line 112 lands on the exact maximum (must succeed with `total_shares == i128::MAX`), then the transfer pushes U1 over ⇒ `Overflow (6)`. Exercises the *addition* boundary rather than the multiplication one, across two different helpers. |
| 16 | `initialize` → `deposit(U1, 10^9)` → `deposit(U2, 10^9)` → `pause()` → `set_admin(U2)` → (as U2) `pause()` | Admin rotation while paused, with live balances | Ordering of instance-tier writes: `set_admin` and `pause` both write instance state and both call `bump_instance`. Verifies the pause flag survives admin rotation and the new admin inherits control of an already-paused vault. Cheap, but it is the only seed that composes both admin mutators. |

### Budget allocation

Rough split for the corpus: **40%** on sequences 1–4 (rate manipulation and truncation — the structurally likely faults), **20%** on 5–7 and 15 (arithmetic boundaries, where the `checked_*` helpers make the expected outcome unambiguous and therefore any deviation is a clear finding), **15%** on 8–9 (ledger/TTL, the dimension a naive harness omits entirely), **15%** on 10–11 and 16 (admin/auth, and only meaningful with scoped auth mocking), **10%** on 12–14 (initialization order and aliasing).

Mutation policy on top of the seeds: keep the *sequence skeleton* fixed and mutate only the `i128` operands and the pool indices, drawing the `i128` from a weighted set — `{0, 1, 2, -1, i128::MIN, i128::MAX, 10^7, 10^9, 10^12, 10^18, i64::MAX, 2^63, 2^63 - 1, 2^64, 2^100, 2^126, 2^127 - 1}` at ~60%, `current_balance + {-1, 0, +1}` at ~25%, and free random `i128` at ~15%. The `current_balance ± 1` family is state-relative and cannot be expressed as a literal; it is what puts the fuzzer exactly on the `InsufficientBalance` and `ZeroShares` edges on every single call rather than once in a billion draws.

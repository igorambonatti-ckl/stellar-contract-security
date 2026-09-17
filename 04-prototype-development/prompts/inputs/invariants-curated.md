# Curated invariants for `soroban-vault`

The properties the harness must assert. Derived from an AI proposal round and curated by hand; this
file is the handoff into harness generation. Statements use:

- `T` = `total_shares()`
- `B(a)` = `balance_of(a)`
- `A` = the vault's balance of the underlying token, read from the token contract
- `H` = the set of principals the harness has driven (the contract exposes no enumeration, so the
  harness must track this itself)

| ID | Property |
|---|---|
| **I1** | At every quiescent point, `T == Σ_{a∈H} B(a)` — after any interleaving of `deposit`, `withdraw`, `transfer_shares`, `set_admin`, `pause` and ledger advances, including after calls that aborted. |
| **I3** | For any single successful `deposit` or `withdraw` with `T₀ > 0` and `T₁ > 0`: `A₁·T₀ ≥ A₀·T₁` (cross-multiplied, to avoid division). Compute both products with `checked_mul` in the harness and **skip** the case — do not fail — if either overflows. Skip when `T₀ == 0`, where the price is undefined. |
| **I4** | `admin()` is constant across `deposit`, `withdraw`, `transfer_shares` and `pause`. It changes only via `set_admin`, and only when the **incumbent** admin authorized the call. After a successful `set_admin(x)`, `admin() == x`. `new_admin` is *not* required to authorize — do not assert against that. |
| **I5** | `B(a)` decreases only inside a call in which `a` authorized. Under revoked auth, any call that would decrease `B(a)` must fail and leave `B(a)`, `B(to)` and `T` all unchanged. Only observable in a dedicated no-auth arm, since the main loop runs under `mock_all_auths`. |
| **I6** | `B(a) ≥ 0` for all `a ∈ H`, and `T ≥ 0`, always. (The overflow-aborts case is deliberately *not* the property — that failure is loud and already covered elsewhere. The non-negativity postcondition is the silent one.) |
| **I8** | After a successful `transfer_shares(from, to, shares)`: `T` is unchanged unconditionally; if `from != to` then `B(from)` fell by exactly `shares` and `B(to)` rose by exactly `shares`; if `from == to` then `B(from)` is exactly unchanged. The generator must **force** the `from == to` case with non-trivial probability — a random pair essentially never aliases. |
| **I9** | While the vault is initialized, every further `initialize(admin', token')` fails and leaves `admin()`, `is_paused()` and `T` unchanged. |
| **I10′** | Immediately after any call that writes `a`'s balance, the remaining TTL of that persistent entry is at least `BUMP_AMOUNT`. Do **not** assert this on a *repeated* write in quick succession, where the second `extend_ttl` is legitimately a no-op because the remaining TTL already exceeds `BUMP_THRESHOLD`. |
| **I11** | The value of `last_activity(a)` — including its being absent — has no effect on any other entry point. Test differentially: run the same sequence twice, and in the second run advance the ledger past `TEMP_TTL` between operations so the temporary entries lapse. Every observable other than `last_activity` itself must match between the two runs. |
| **I12** | (a) `is_paused()` never transitions `true → false` — there is no `unpause`. (b) While paused, `deposit`, `withdraw` and `transfer_shares` each fail and leave `T` and every `B(a)` unchanged. `set_admin` and `pause` remain callable, and `pause` is idempotent. |
| **N1** | After any successful `deposit`, `withdraw`, `set_admin`, `pause` or `initialize`, the instance entry's remaining TTL is at least `BUMP_THRESHOLD`. Note `transfer_shares` reaches no bumping path — that asymmetry is a recorded observation, **not** an assertion; do not fail on it. |
| **N2** | `A ≥ T` at every quiescent point. This is what makes a zero-payout `withdraw` unreachable, so it is worth proving on every run rather than assuming. |
| **N3** | The views (`total_shares`, `balance_of`, `admin`, `is_paused`, `last_activity`) are pure: calling them any number of times in any order leaves `T`, every `B(a)`, `admin()` and `is_paused()` unchanged. |

## Notes for the harness author

- Principals come from a **fixed pool**, fuzzed by index. A freshly generated `Address` cannot be
  authorized in the test host, so fuzzing raw address bytes collapses every access-control property
  into "an unknown caller is rejected".
- Exclude the vault's own address and the token contract address from the actor pool.
- Where the only possible assertion is "this call must abort", assert **which** error came back and
  that state did not change. "Some error occurred" is not an acceptable oracle.
- Ledger advance is a first-class fuzz dimension, not a nuisance: I10′, I11 and N1 all depend on it.

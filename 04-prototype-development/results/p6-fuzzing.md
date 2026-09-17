# P6 — Coverage-guided fuzzing

**Run:** 2026-09-17 · **Gate:** [execution-plan.md §P6](../../docs/execution-plan.md)

```bash
scripts/p6-fuzz-matrix.sh 300                                  # both arms, 8 configurations each
P6_ARMS=vault_ai P6_OUT=results/p6-round2.tsv scripts/p6-fuzz-matrix.sh 300
```

Budget: **300 s per arm per configuration**, fixed and equal. The plan proposed 900 s; 300 s was
chosen once the first cell's throughput was known (≈1 500 exec/s for the baseline) and then held
constant for every cell. Each cell starts from an **empty corpus**, so one arm's accumulated corpus
cannot flatter the other and time-to-first-crash is measured from a cold start.

Raw data: [`p6-round1.tsv`](p6-round1.tsv), [`p6-round2.tsv`](p6-round2.tsv).
Minimised reproducers: [`crashes/`](crashes/).

---

## 1. The clean-contract control

Every arm is run against the **unmodified contract** as well as the seven seeds. A crash there is a
false positive, and until it is resolved no detection from that arm is attributable — the seed
crashes might all be the same harness bug.

This is not a formality. It fired, and §4 is what it caught.

---

## 2. Results

| Seed | Baseline | AI round 1 | AI round 2 | R2 TTFC | R2 runs | Attributed to |
|---|---|---|---|---|---|---|
| *(clean — control)* | ✅ no crash | ✅ no crash | ✅ no crash | — | 145 564 | — |
| `bug_overflow` | ❌ | ❌ | ✅ | 113 s | 65 982 | **I6/N4** — payout returned where the exact product overflows `i128` |
| `bug_missing_auth` | ❌ | ❌ | ✅ | 2 s | 578 | **I5** — revoked auth did not reject |
| `bug_zero_amount` | ❌ | ✅ | ✅ | 2 s | 677 | **I7** — `withdraw(0)` succeeded and paid 0 |
| `bug_self_transfer` | ❌ | ❌ | ✅ | 124 s | 74 891 | **I8** — self-transfer changed the balance |
| `bug_no_ttl` | ❌ | ❌ | ✅ | 2 s | 398 | **N1** — instance TTL 15, expected ≥ 518 400 |
| `bug_temp_nonce` | ✅ | ❌ | ✅ | 2 s | 538 | **I5** — `set_admin` failed with `NotInitialized` instead of on auth |
| `bug_reinit` | ❌ | ✅ | ✅ | 2 s | 613 | **I9** — a second `initialize` returned `Ok` |
| **Total** | **1 / 7** | **2 / 7** | **7 / 7** | | | |

Every detection was checked by reading the assertion message, not the pass/fail column. Two are
worth spelling out because the attribution is indirect:

- **`bug_overflow`** is caught by the `None` arm of the exact-payout oracle (§5): a withdrawal
  succeeded and returned `1` where `shares · A₀` exceeds `i128`. A correct contract aborts there;
  this one returned a wrapped value.
- **`bug_temp_nonce`** is caught by the *auth* property, not by a TTL one. The seed gates admin
  authority on temporary-tier state, so under revoked authorization `set_admin` fails with the
  contract's own `NotInitialized` rather than on auth. The oracle demands the failure be external
  to the contract — so a rejection for the wrong reason fails it. A weaker `is_err()` oracle would
  have passed, which is the P3 Finding 2 criterion earning its keep for the second time.

Throughput, clean build, 300 s: baseline ≈ 1 570 exec/s; AI round 1 ≈ 590 exec/s; AI round 2
≈ 460 exec/s. The assisted arm is slower per execution because it reads state back after every step
— which is the entire point of it, and is why executions are the wrong unit to compare.

---

## 3. Round 1 → round 2: what changed, and why it is not circular

Round 1 of the AI fuzz target detected **2 of 7**, and *lost* `bug_temp_nonce`, which the cruder
baseline caught. Two structural causes, neither of them about the oracle's content:

1. **Operands came straight from the fuzzer's bytes.** Uniform `i128` is almost always a magnitude
   the contract rejects in its first guard, so the fuzzer could never assemble the multi-call state
   the interesting properties need. The only seed it found unaided was the one reachable in a single
   call with a zero byte.
2. **Every call went through `try_*` and was inspected only on success.** An operation that aborted
   when it should have succeeded was silently tolerated — which is exactly how the assisted arm lost
   a seed the "must not abort" control caught.

### This was a gap in execution, not a tuning opportunity

Topic 3 §6 specifies **three** AI insertion points. The third, `prioritise-inputs`, produces
"per-type edge-case tables and suspicious call sequences" to be *"folded into the `Arbitrary`
strategies and the corpus seed"*. It was written, run in P5 by a clean-context subagent, and
committed verbatim to [`../prompts/raw/prioritise-inputs.out.md`](../prompts/raw/prioritise-inputs.out.md).

**And then never used.** Round 1 was built without opening it.

Round 2 implements it. The distinction that keeps the benchmark honest:

- The prior was authored by a model that **never saw the seed list**, months of context away from
  the round-1 results.
- No change was keyed to a seed. Everything traces to a numbered section of that output.
- Round 1 is **kept and reported**, not overwritten. The delta between the rounds is the measurement
  of what the third prompt contributes — a number that would not exist had the target simply been
  replaced.

Had the generator been adjusted after seeing which seeds round 1 missed, the result would be
circular and worthless. The integrity rule in the execution plan says so for the invariant prompt;
it applies just as much here.

### What the prior actually specified

| Round 1 | Round 2 | Prior |
|---|---|---|
| `amount: i128` straight from the input bytes | ~60 % from a boundary-literal table, ~25 % state-relative (`balance ± δ`), ~15 % free | §"Mutation policy" |
| 3 anonymous actors | 7 slots incl. the token, the vault itself, and a never-authorized principal, drawn with a skew | §2.1, §2.2 |
| Uniform token balances | Asymmetric, so magnitude and identity are independent dimensions | §2.1 |
| No way to move assets without shares | A `Donate` step — a direct token transfer | §1.6, pseudo-arguments |
| `AdvanceLedger { by: u32 }`, uniform | Advances drawn from a three-point probe around each TTL threshold | §1.6 |
| `mock_all_auths` throughout | A revoked-auth step with a discriminating oracle | §1.5, §2.2 |

The state-relative operand family is the one that matters most and the one nobody writes. The prior
says why: it *"cannot be expressed as a literal; it is what puts the fuzzer exactly on the
`InsufficientBalance` and `ZeroShares` edges on every single call rather than once in a billion
draws."*

### The generic half is now a crate

Everything in that table except the vault's own constants is contract-independent, so it was
extracted into [`soroban-fuzzkit`](../fuzzkit/) — operand policy, principal pool, TTL cliff table,
ledger pinning, and error attribution. 32 tests, no mention of `soroban-vault`. The vault's fuzz
target is a thin adapter over it.

---

## 4. The clean-contract crash — a real finding that must not be reported

Round 2's first complete run crashed on the **clean** contract after 181 s:

```
I3 violated by deposit: A1*T0=1000000000000000000 < A0*T1=1000000066000000000
                        (A0=1000000000 T0=1000000000 A1=1000000000 T1=1000000066)
```

`T` grew by 66 while `A` did not move: a deposit minted shares without bringing in any asset. The
cause is aliasing. When `from` is **the vault's own address**, `client.transfer(&vault, &vault, ..)`
is a self-transfer inside the token — the vault's balance is unchanged — and the shares are minted
anyway. Value created from nothing.

The input prior predicted this case exactly (§2.2, rank 8: *"`deposit(from = 5)` — vault deposits
into itself … value accounting where source and sink coincide"*), which is why the slot was in the
pool at all.

**And it is still not reportable.** `deposit` calls `from.require_auth()`, and no external caller can
forge the vault's authorization. The path exists only because the harness mocks all authorization —
it is a **false red manufactured by the harness's own auth model**, the mirror image of the false
green the prior warns about in §1.5.

The fix was not to weaken the oracle but to correct the model of who can call. Contract addresses
stay in the pool as **counterparties** — value stranded in an address that can never sign is a
genuine hazard — and leave the **caller** position, where they cannot sign. That is now
`Pool::index_caller` in the kit, with the case documented, and it generalises to any Soroban
contract using `require_auth`.

Three consequences:

1. The detections from that run were discarded. **A detection only counts once the arm passes clean
   on the correct contract**, and it did not.
2. Its two slowest "detections" (117 s and 129 s, against 181 s for the clean crash) were most
   likely the same false positive rather than the seeds.
3. The `proptest` AI arm never had this problem, because the invariant proposal had **already said
   so** — proposal 4's assumption row reads *"I recommend the harness exclude the vault address from
   its actor pool rather than complicate the assertion."* That advice was followed in the `proptest`
   harness and not in the fuzz target.

---

## 5. Two oracles that named the wrong property

Both were found by reading the failure messages rather than the pass/fail column. Neither changed a
count; both would have put a wrong sentence in the write-up.

**`bug_zero_amount` and `bug_overflow` failed on the same assertion**, one reading *"the §R2
truncation case is reachable after all"*. Neither was truncation: the first was `withdraw(0)`
slipping past the positivity guard (I7), the second a `wrapping_mul` producing a wrong payout (I6).
Split into three distinct assertions, each naming what it checks.

**The exact-payout oracle skipped the sharpest case it had.** `shares · A₀` is computed in the
harness with `checked_mul` and the comparison skipped on overflow — the obvious way to write it, and
wrong: where the harness's multiplication overflows, the *contract's* overflows too, so a correct
contract must abort. A call that returned a value instead returned a **wrapped** one. Turning that
skip into an assertion is what makes `bug_overflow` attributable to arithmetic rather than to a
truncation hypothesis that was refuted in P5.

Round 2 was therefore measured three times as these were corrected. Only the final measurement is
reported; the intermediate ones are described here rather than tabulated, because an oracle that
names the wrong property produces a number that cannot be interpreted.

---

## 6. Tooling findings

Neither of these is in the `cargo-fuzz` book or the Stellar fuzzing guide, and both cost real time.

### 6.1 `crate-type = ["lib", "cdylib"]` blocks `cargo-fuzz` on macOS/arm64

`crate-type` is **one** Cargo target emitting two artifacts, so every build produces both. Under
`cargo-fuzz`'s SanitizerCoverage flags the cdylib link fails —

```
ld: multiple errors: initializer pointer has no target in ... soroban_vault.rcgu.o
```

— and that failure blocks the whole fuzz build, even though the fuzz binary only ever needs the
rlib. Isolated by bisecting the flags: plain `--release` links fine, `-Cpasses=sancov-module` alone
reproduces it.

**Fix:** `crate-type = ["lib"]`, and produce the `.wasm` on demand:

```bash
cargo rustc -p soroban-vault --target wasm32v1-none --release --crate-type cdylib
```

ASan additionally collides with `soroban-sdk`'s static initialisers (`ctor`) on this platform, so
the fuzz layer runs `--sanitizer none`. Coverage instrumentation is unaffected — the runs below
reach ~4 000 edges — and ASan buys little here, since the contract is safe Rust inside a managed
host.

### 6.2 `cargo fuzz --features` is silently ignored — the near-miss

`cargo-fuzz` 0.13.2 accepts `--features`, never forwards it to the underlying `cargo build`, and
reports no error. `cargo fuzz build -v --features bug_x` shows every crate `Fresh`. Plain
`cargo build --features bug_x` in the same directory honours it correctly, which is how the fault was
localised.

The first matrix run therefore reported that the AI arm had **missed `bug_self_transfer`** — when the
seed had never been compiled in. The number was quiet, plausible, and pointed the wrong way. It was
caught only because it contradicted the `proptest` arm.

The runner now selects the seed through the `default` feature and **verifies** it with
`cargo tree -e features -i soroban-vault`, aborting if what cargo resolved is not what was asked for.
Two weaker checks were tried first and both produced false alarms of their own — "the contract must
recompile" fails when a feature set is already cached, and "the second arm must recompile too" fails
because it correctly reuses the first arm's build. Only the resolved feature set is authoritative.

> This is the single best argument in the project for the execution plan's rule that **every gate is
> a command with an expected result**. A benchmark whose numbers nobody cross-checks reports whatever
> the tooling felt like reporting.

---

## 7. Open question 4, answered

> *Is coverage-guided fuzzing over the linked crate meaningfully better than random `proptest` here,
> or is the contract small enough that `proptest` saturates it?*

**Neither, as posed.** The `proptest` arm reaches 7/7 in ~11 s of `cargo test`; the coverage-guided
arm needs a tuned generator to reach the same set, and up to ~2 minutes for the arithmetic seeds.
Coverage guidance is not adding depth here — it is *recovering* ground that hand-written `proptest`
strategies get for free, because those strategies encode the valid-input structure that byte-level
mutation has to rediscover.

The question assumed the alternative to saturation was depth. The actual answer is that on a
contract with a narrow validity funnel, **the binding constraint is input structure, not search
strategy** — and a coverage-guided fuzzer pays for its structural blindness before its feedback loop
can help. What the coverage layer does buy is the ability to run unattended for hours on a schedule,
where `proptest`'s fixed case budget stops.

The honest recommendation for a contract of this shape: **`proptest` is the primary layer**, and
`cargo-fuzz` is the overnight one — which inverts the emphasis Topic 3 §4.2 gave them.

## 8. Gate P6 verdict

- ✅ Both targets build and run under nightly (`--sanitizer none`, §6.1).
- ✅ Time-to-first-crash recorded per seed per arm, or "not found within budget".
- ✅ Every crash minimised via `fuzz tmin` and saved to [`crashes/`](crashes/).
- ✅ A clean-contract control run per arm, and a false positive on it treated as blocking (§4).
- ⚠️ **Crashes are not converted into permanent `proptest` regression tests.** Each seed's crash is
  already covered by a hand-written invariant test and by the AI `proptest` arm, so a converted
  reproducer would add a third copy of the same assertion. The one crash that was *not* a seed —
  the clean-contract aliasing case in §4 — is a harness fault, not a contract fault, and is
  regression-tested in `soroban-fuzzkit` instead (`index_caller_only_returns_slots_that_can_actually_sign`).
  Recorded as a deliberate deviation from the plan's wording rather than silently skipped.

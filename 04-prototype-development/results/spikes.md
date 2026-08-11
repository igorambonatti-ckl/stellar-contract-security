# P1 — De-risking spikes

**Run:** 2026-08-11 · **Gate:** [execution-plan.md §P1](../../docs/execution-plan.md) · **Result:** ✅ both questions answered · **Tests:** 11/11 passing

Code: [`contracts/spike/`](../contracts/spike/) — `cargo test -p spike`.

Both spikes were run against `soroban-sdk` 26.1.0 (protocol 23) before writing `soroban-vault`,
because both could invalidate large amounts of downstream work. Both changed the architecture.

---

## Spike A — is TTL / state archival observable in the test `Env`?

**Question (Topic 3 open question 2):** invariants I10 and I11 are the Soroban-specific
differentiator of this IDP. Can entry expiry be observed inside `Env` at all?

**Answer: yes, and better than expected — but the finding inverts I10.**

### A-1. Everything needed is exposed

`soroban_sdk::testutils` gives full control and full observability:

| API | Use |
|---|---|
| `env.ledger().with_mut(...)` | Set `sequence_number`, `min_persistent_entry_ttl`, `min_temp_entry_ttl`, `max_entry_ttl` |
| `env.ledger().set_sequence_number(n)` | Advance the ledger past an entry's TTL |
| `env.storage().persistent().get_ttl(&key)` | Read remaining TTL directly (inside `env.as_contract`) |
| `env.storage().temporary().get_ttl(&key)` | Same, for the temporary tier |

So TTL does not have to be inferred from whether a read fails — it can be asserted numerically.
The SDK explicitly recommends this, and it is what tests `a1`, `a3` and `a4` do.

### A-2. **Persistent entries are auto-restored — data loss is unreachable**

This is the headline finding. Protocol 23 introduced automatic entry restoration, and the test host
emulates it. `soroban-sdk`'s own migration note (`src/_migrating/v23_archived_testing.rs`) states it
plainly:

> Prior to protocol 23 the SDK used to emulate the failure when an archived ledger entry was
> accessed in tests. […] In protocol 23 automatic entry restoration has been introduced […] the SDK
> has been changed to emulate automatic restoration in tests as well.

Verified in `a2`: a persistent entry whose TTL has fully lapsed still reads back its value.

**Consequence — I10 as originally written is not falsifiable.** Topic 3 stated it as *"a balance
written in one invocation is readable in the next (persistent + `extend_ttl`)"*. Under protocol 23
that is **always true**, `extend_ttl` or not. An invariant that cannot fail cannot find bugs, and
would have produced a fuzzing target that looks like it works and proves nothing.

**What replaces it.** Restoration is not free — it costs rent, and it is *detectable*. Test `a3`
shows the restored entry's TTL resets to `min_persistent_entry_ttl - 1`, distinguishable from a
freshly-extended entry. So the real, checkable property is:

> **I10′ — a contract that manages TTL correctly never silently relies on auto-restoration.**
> After the expected access pattern, a persistent entry's TTL must be the extended value, not the
> post-restoration minimum.

This shifts the hazard from *data loss* to *unexpected rent cost*, which is the accurate risk model
for protocol 23, and it stays falsifiable.

### A-3. **Temporary entries genuinely disappear — I11 survives intact**

Test `a4`: after the ledger advances past a temporary entry's TTL, the read returns `None`. No
restoration, no recovery. Test `a5` asserts both tiers side by side from the same expiry event:
persistent restored, temporary lost.

**Consequence:** I11 (*auth/nonce state is never read from a tier that can silently expire*) is now
the **primary** Soroban-specific invariant of this IDP, not a secondary one. It is the tier
distinction that has real, unrecoverable consequences.

### A-4. Incidental finding — **`extend_ttl` is threshold-gated and often a silent no-op**

Not part of the spike's question, found while debugging a test that passed for the wrong reason.

`extend_ttl(threshold, extend_to)` extends **only if the remaining TTL is already below
`threshold`**. The host default `min_persistent_entry_ttl` is **4096**, so a new entry starts at TTL
4095. The idiom used throughout the Stellar tutorials — and in this repo's own `increment` contract
— is:

```rust
env.storage().instance().extend_ttl(50, 100);
```

With a starting TTL of 4095, that call **does nothing for the first ~4000 ledgers of the entry's
life**. It is not wrong, but it is inert far longer than the code suggests, and it only starts
working near the end of the entry's life. Asserted in `a1b`.

**Why this matters for Topic 4:** a "missing TTL bump" invariant naively written as *"calling
`extend_ttl` increases the TTL"* would be **false on a correct contract** and produce false
positives. The seeded bug `bug_no_ttl` and its invariant must be written against the
threshold semantics, and the test harness must pin the ledger TTL floors explicitly — relying on
defaults is what made two of this spike's own tests initially pass for the wrong reason.

### Gate A verdict

**A-pass.** Archival is observable; no fallback needed. I10 is reframed as I10′, I11 is promoted.

---

## Spike B — does `SorobanArbitrary` produce usable `Address` values?

**Question (Topic 3 open question 1):** if every generated address fails `require_auth` uniformly,
invariants I4/I5 are trivially satisfied and access-control fuzzing proves nothing.

**Answer: mixed — generated addresses are fine as data, useless as principals. The predicted
fallback is the right design.**

### B-1. Generation works and is well-distributed

`<Address as SorobanArbitrary>::Prototype` implements `Arbitrary`; `proptest-arbitrary-interop`'s
`arb::<T>()` bridges it into `proptest`. Test `b1`: 200 generated prototypes yielded **> 100
distinct** addresses. Test `b4`: they work fine as contract arguments — storage keyed by them reads
and writes correctly.

### B-2. But they cannot be *authorized*

`MockAuth` requires an address the host knows about. An arbitrarily-generated address can be passed
in, but cannot be made to pass `require_auth`. Left alone, every access-control property would
reduce to "unknown address is rejected" — true, uniform, and worthless as a fuzzing signal
(test `b2` shows this baseline).

### B-3. The design that does work — index into a principal pool

Confirmed in `b3` and `b5`: register a small fixed pool of `Address::generate(&env)` principals, and
**fuzz an index into that pool** rather than raw address bytes. Then `mock_auths` authorizes one
principal while the fuzzer varies who actually acts, and the property becomes genuinely two-sided:

```rust
prop_assert_eq!(result.is_ok(), actor_idx == owner_idx);
```

This is the fallback Topic 3 §9 anticipated, and it matches the shape ChainGuard's
`input_generator.rs` arrived at independently (zero / self / known-malicious address classes). It is
strictly better for access control: it explores *who acts vs. who is authorized*, which is the
actual bug class (SOR-001/002/003, scenarios S03/S06).

### Gate B verdict

**B-fail on the literal question, with the fallback confirmed working.** Harness design decision:
`Address` inputs are fuzzed as pool indices; raw `SorobanArbitrary` addresses are used only where an
address is data (storage keys, transfer targets), not a principal.

---

## Architecture changes required

| Change | Where |
|---|---|
| I10 → I10′ (TTL-value assertion, not survival) | Topic 3 §5.2 |
| I11 promoted to primary Soroban-specific invariant | Topic 3 §5.2 |
| `bug_no_ttl` must target threshold semantics, not "no extend call" | Topic 3 §5.3 |
| Harness pins ledger TTL floors explicitly; never relies on host defaults | Topic 4 P2/P4/P5 |
| `Address` principals fuzzed as pool indices | Topic 4 P4/P5 |

## Gate P1 verdict

**Passed.** Both open questions answered empirically, with tests committed as evidence. Two changes
to the invariant set were forced by the results — which is exactly the point of spiking before
building: the same discovery made during P5 would have invalidated a completed harness.

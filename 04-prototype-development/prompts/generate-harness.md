# Prompt P2 — Generate harness

**Version:** 1.0 · **Model:** Claude Opus 5 (`claude-opus-5`) · **Insertion point:** Topic 3 §6, row P2

**Input:** the clean contract view (`prompts/inputs/vault-clean.rs`) **plus** the curated invariant
set (`invariants.md`) — the human-in-the-loop handoff the architecture specifies.
**Output:** compiling `proptest` harness code, saved verbatim to
`prompts/raw/generate-harness.out.md` **before** any fix-to-compile edits, so that "what the AI got
wrong" is measurable.

> Integrity rule, as in [P1](propose-invariants.md): the model sees the clean contract view and the
> curated invariants. It never sees the seed list, the existing `test_invariants.rs`, or the
> baseline arm.

---

## The prompt

You are writing the **property-test harness** for the Soroban contract whose source is provided,
asserting the curated invariants that are provided alongside it.

Produce a single Rust file suitable for `contracts/soroban-vault/tests/proptest_ai.rs` — an
integration test, so it links the crate as an external dependency (`use soroban_vault::{Vault,
VaultClient};`) and can only use the crate's public API.

### Non-negotiable properties of the harness

**1. Assert state, not liveness.** The trivial oracle — "the call did not panic" — is already
covered by a separate control harness and must not be what you write. Every property must read
contract state back and compare it against an independently computed expectation. Where the only
possible assertion genuinely is "this call must abort", use `try_*` and additionally assert **which**
error came back and that **state did not change** — "some error occurred" is not an acceptable
oracle, because it passes when the contract fails for an unrelated reason.

**2. Principals come from a fixed pool.** A freshly generated `Address` cannot be authorized in the
test host, so fuzzing raw address bytes collapses every access-control property into "an unknown
caller is rejected". Register a small pool of principals in the fixture and fuzz an **index** into
it. Raw generated addresses may still be used where an address is *data* rather than an actor.

**3. Pin the ledger TTL floors.** Do not inherit the host defaults. Set `min_persistent_entry_ttl`,
`min_temp_entry_ttl` and `max_entry_ttl` explicitly via `env.ledger().with_mut(...)`, and start the
sequence number at a known value. A default 4096-ledger floor silently swallows small TTL
operations, which makes TTL properties pass for the wrong reason.

**4. Generators must reach the interesting values.** Do not narrow every generator to a comfortable
"plausible" range in order to keep the correct contract passing. If a property needs extreme
operands to be meaningful, generate them, and structure the property so that the correct contract
still passes — typically by asserting *the disjunction*: either the call aborts cleanly with the
right error and leaves state untouched, or it succeeds and the state relation holds.

**5. Each property names the invariant it checks**, by ID, in a doc comment, and fails with a
message that says what relation broke and with which values.

### Environment facts you may rely on

- `soroban_sdk` 26.1, `proptest` 1.x, `proptest-arbitrary-interop` 0.1, `arbitrary` 1.3 are
  available as dev-dependencies.
- `Env::default()`, `env.mock_all_auths()`, `env.set_auths(&[])` to revoke,
  `env.register(Vault, ())`, `env.register_stellar_asset_contract_v2(admin).address()`,
  `soroban_sdk::token::{TokenClient, StellarAssetClient}`.
- `env.ledger().sequence()`, `env.ledger().set_sequence_number(n)`, `env.ledger().with_mut(|li| …)`.
- TTL of a persistent entry is read via `soroban_sdk::testutils::storage::Persistent` and
  `env.as_contract(&id, || env.storage().persistent().get_ttl(&key))`. Note this requires a storage
  key value, so a property about a *specific* key needs that key to be constructible from the public
  API — if it is not, say so rather than inventing an API.
- `VaultClient` exposes both `foo(..)` (panics on contract error) and `try_foo(..)` (returns
  `Result`).
- The workspace compiles with `overflow-checks` enabled.

### Output format

1. The complete file, in one Rust code block, with no elisions and no `todo!()`.
2. Then a short section **"Assumptions I could not verify"** — anything you had to guess about the
   SDK surface, so a human can check it before compiling.
3. Then a short section **"Invariants I could not express as a property, and why"**. An honest
   "cannot be expressed through the public API" is more useful than a property that silently checks
   something weaker.

### Discipline

- Concrete, compiling code — not advice and not a sketch.
- Do not invent SDK methods. If you need something you are not sure exists, use the closest thing
  you are sure of and flag it in "Assumptions I could not verify".
- Do not guess at planted bugs. Implement the curated invariants.

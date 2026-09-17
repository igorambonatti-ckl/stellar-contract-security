# Prompt P1 — Propose invariants

**Version:** 1.0 · **Model:** Claude Opus 5 (`claude-opus-5`) · **Insertion point:** Topic 3 §6, row P1

**Input:** `contracts/soroban-vault/src/lib.rs` — the contract source, and nothing else.
**Output:** a ranked list of candidate invariants with rationale, saved verbatim to
`prompts/raw/propose-invariants.out.md` before any curation.

> **Integrity rule.** The model that runs this prompt must not see `results/seeds.md`,
> `src/test_invariants.rs`, `src/test.rs`, `results/benchmark.md`, or any other file that reveals
> which bugs were seeded or which invariants were already curated. Otherwise the benchmark measures
> recall of a leaked answer key, not the model's ability to read a contract. See
> `results/ai-arm-provenance.md` for how this was enforced in practice.

---

## The prompt

You are a smart-contract security engineer specialising in Soroban (Stellar's Rust/WASM smart
contract platform). You have been handed the full source of one contract and asked to produce the
**invariant catalogue** that a fuzzing harness for it should assert.

Read the contract source provided. Then propose the properties that must hold for **every** possible
sequence of calls, for any inputs, at any ledger sequence.

### What counts as a good invariant here

An invariant is only useful to us if it can be turned into an executable assertion inside a
`soroban_sdk::Env` test harness. For each one you must be able to say how a harness would observe a
violation. Prefer properties that:

- relate **two or more observable quantities** (a sum, a before/after comparison, a conservation
  law) over properties that restate a single line of code;
- can fail **silently** — i.e. the contract returns normally but the resulting state is wrong. A
  property whose only failure mode is "the call panics" is weak, because liveness checking alone
  already catches it;
- exercise the platform's own hazards, not just generic application logic.

### Soroban-specific ground you are expected to cover

This contract uses all three Soroban storage tiers. Consider, at minimum:

- **Instance / persistent / temporary tiers** and what each guarantees. Which tier can silently
  disappear? What must therefore never be read from it?
- **TTL and state archival.** `extend_ttl(threshold, extend_to)` extends an entry's time-to-live
  only when the remaining TTL is already **below** `threshold`. Persistent entries that expire are
  auto-restored by the protocol at a rent cost, and a restored entry's TTL resets to the host's
  `min_persistent_entry_ttl - 1`. Temporary entries are **not** restored.
- **Authorization.** `require_auth()` on an `Address`, and which entry points are missing it.
- **Arithmetic.** Note that the workspace enables `overflow-checks`, so a bare `+` aborts rather
  than wrapping — say so if it affects your reasoning.

### Format

Produce a numbered, **ranked** list — most valuable first. For each invariant give exactly:

| Field | Content |
|---|---|
| **Statement** | The property, stated formally enough to implement. Use the contract's own identifiers. |
| **Class** | supply conservation / value conservation / access control / arithmetic / input validation / state machine / Soroban storage tier / Soroban TTL |
| **How a harness observes a violation** | The concrete calls and reads. Name the entry points. |
| **Silent or loud** | Does violating it panic (loud), or return normally with wrong state (silent)? |
| **Assumption** | The thing you are taking on faith from the source, so a human can check it. |
| **Confidence** | high / medium / low, with one clause of justification. |

### Discipline

- **Never speculate.** Assert only what is demonstrable from the code in front of you. If you are
  reasoning about host behaviour you cannot see, mark it as an assumption.
- **False positives destroy trust.** An invariant that does not actually hold on the correct
  contract is worse than a missing one, because it burns curation time and produces a false alarm.
  When in doubt, still list it — but mark the confidence `low` and say precisely what you are unsure
  about.
- Do **not** propose fixes, refactors, or a threat model narrative. The output is the catalogue.
- Do **not** guess at what bugs might have been deliberately planted. Derive everything from the
  code.

End with a short section titled **"Properties I considered and rejected"**, listing anything you
deliberately left out and why. That section is as valuable to us as the list itself.

# AI-arm provenance — how the integrity rule was actually enforced

**Written:** 2026-09-17 · **Phase:** P5 · **Gate:**
[execution-plan.md §P5](../../docs/execution-plan.md)

The execution plan states the integrity rule for the AI arm in one line:

> **the prompts see the contract source, never the seed list.**

Enforcing it turned out to be harder than the sentence suggests, and the two problems found are
themselves results. This file records exactly what the model that authored the AI arm was allowed to
see, so a reader can decide for themselves whether the benchmark is circular.

---

## Problem 1 — the contract source *is* the seed list

`contracts/soroban-vault/src/lib.rs` carries the seeded bugs as `#[cfg(feature = "bug_*")]` blocks
in place, with explanatory comments beside each one:

```rust
// I9 — re-initialization must always abort. Removing this guard is the
// `bug_reinit` seed, and it is the Parity / front-run-init bug class
// (scenarios S13, S19).
#[cfg(not(feature = "bug_reinit"))]
if env.storage().instance().has(&DataKey::Admin) {
```

Twenty-two lines in that file name a seed, and the comments additionally name the invariant IDs
(I1–I12) from the Topic 3 catalogue. Handing that file to the model would have handed it the answer
key twice over: the bug list *and* the curated invariant list it was supposed to independently
re-derive. "Show it the source, not the seeds" is not achievable when the seeds live in the source.

This is a general lesson about feature-gated bug seeding as a benchmark technique, not a quirk of
this repo: **in-place `cfg` seeding makes the target un-showable to the system under test.** Any
future benchmark built this way needs the clean view produced as a first-class artifact, not as an
afterthought.

### The fix — a verified clean view

[`prompts/inputs/vault-clean.rs`](../prompts/inputs/vault-clean.rs) is the contract as it exists
with **no seed features enabled**: every `#[cfg(not(feature = "bug_*"))]` branch resolved and
inlined, every `#[cfg(feature = "bug_*")]` branch deleted, and every comment that names a seed or an
invariant ID rewritten to be neutral. It is what a developer with a correct contract would hand to
an assistant.

It is not trusted on inspection — it is **verified by substitution**. Swapping it in for the real
`src/lib.rs` and running the existing suite:

```bash
cp contracts/soroban-vault/src/lib.rs /tmp/lib.rs.bak
cp prompts/inputs/vault-clean.rs contracts/soroban-vault/src/lib.rs
printf '\n#[cfg(test)]\nmod testkit;\nmod test;\nmod test_invariants;\n' \
  >> contracts/soroban-vault/src/lib.rs
cargo test -p soroban-vault --lib      # → 22 passed; 0 failed
cp /tmp/lib.rs.bak contracts/soroban-vault/src/lib.rs
```

**22/22, identical to the real clean build.** The clean view is behaviourally the same contract, so
nothing the model was asked to reason about was distorted by the scrubbing.

---

## Problem 2 — the assistant driving the session was already contaminated

The IDP is executed conversationally with an AI assistant, and by the time P5 began that assistant
had already read `results/seeds.md`, `src/test_invariants.rs` and `results/benchmark.md` in order to
run P0–P4. It could not author the AI arm without importing knowledge of the answer key —
unconsciously at best, decisively at worst.

### The fix — clean-context subagents

Each prompt was executed by a **separate subagent with an empty context window**, launched with a
hard instruction that the only repository file it was permitted to open was
`prompts/inputs/vault-clean.rs`. The subagents had no access to this conversation, to the seed list,
to the existing invariant tests, or to the baseline results.

| Prompt | Executed by | Input it could see | Raw output |
|---|---|---|---|
| P1 `propose-invariants.md` | clean-context subagent | `vault-clean.rs` only | [`raw/propose-invariants.out.md`](../prompts/raw/propose-invariants.out.md) |
| P3 `prioritise-inputs.md` | clean-context subagent | `vault-clean.rs` only | [`raw/prioritise-inputs.out.md`](../prompts/raw/prioritise-inputs.out.md) |
| P2 `generate-harness.md` | clean-context subagent | `vault-clean.rs` + curated `invariants.md` | [`raw/generate-harness.out.md`](../prompts/raw/generate-harness.out.md) |

P2 legitimately sees the curated invariants — that is the human-in-the-loop handoff the architecture
specifies (Topic 3 §6). It still never sees the seeds.

**Curation was done by the contaminated assistant, deliberately.** Curation is the *human* role in
the pipeline, and a human in this position would also know their own codebase. The decision that
must stay uncontaminated is *what the AI proposes*, and that is what the subagent isolation
protects. Every curation decision is recorded with its rationale in
[`invariants.md`](../invariants.md) so the reader can audit whether a rejection was principled or
convenient.

---

## Residual contamination — stated plainly

Three channels remain open, and none of them is closed by the above:

1. **The clean view was authored by the contaminated assistant.** It was verified to be
   *behaviourally* equivalent (22/22), but the choice of which comments to keep was made by someone
   who knew the answers. A neutral comment can still steer attention. Mitigation: the file is
   committed and diffable against `src/lib.rs`.
2. **The contract was designed around the invariant catalogue in the first place.** `soroban-vault`
   was purpose-built in Topic 3 to carry I1–I12. A model reading it is reading a contract whose
   shape already implies most of those properties. This inflates the AI arm's apparent insight and
   is an inherent limit of any purpose-built benchmark target.
3. **Model-family overlap.** The same model family authored the contract (Topic 3/P2) and proposes
   the invariants (P5). Whatever it finds natural to write, it also finds natural to check.

These are limitations of the measurement, not defects in the run, and they are carried into the
Topic 5 limitations section rather than buried here.

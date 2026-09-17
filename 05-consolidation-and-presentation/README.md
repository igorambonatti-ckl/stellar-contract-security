# Topic 5 — Consolidation & Presentation

**Status:** ✅ Done · **Due:** 2026-09-30 · **Delivered:** 2026-09-17

Deliverables: **[presentation deck](../docs/deck.md)** · **[end-to-end demo](../04-prototype-development/scripts/demo.sh)** ·
this document.

---

## 1. What the IDP set out to do, and what it produced

> **Developing Smart Contract Skills on Stellar with a Focus on Security and AI-Assisted Fuzzing**

Five topics, from Stellar fundamentals to a measured prototype. The thing that had to be true at the
end was not "I built something" — ChainGuard, the prior art, was feature-complete and never ran once
end to end. It was **"the claim can be checked by someone else."**

| Topic | Delivered | The one thing it settled |
|---|---|---|
| [1 — Fundamentals](../01-stellar-fundamentals/README.md) | Doc + `increment` contract | SCP, the ledger, the three storage tiers, and how a contract is written, deployed and tested |
| [2 — Security & fuzzing](../02-security-and-fuzzing/README.md) | Doc | Echidna and Foundry are EVM-only; Soroban's stack is `cargo-fuzz` / `proptest` / `SorobanArbitrary` / `cargo-mutants`, and the hard part is **knowing what to assert** |
| [3 — Architecture](../03-solution-architecture/README.md) | Design + 12 invariants + 7 seeded bugs | A two-arm benchmark that *can* produce a negative result, and a scope small enough to finish |
| [4 — Prototype](../04-prototype-development/README.md) | Rust workspace, prompt library, benchmark, reusable fuzzing kit | **Baseline 1/7 → AI-assisted 7/7** on seeds, **34 % → 98 %** on mutants, with the gap attributable entirely to the oracle |
| 5 — This | Deck, demo, consolidation | Every claim traces to a committed artifact, and the demo runs from a clean clone |

Every number in this document is produced by a command in the repository. The commands are in
[`docs/execution-plan.md`](../docs/execution-plan.md) §4 and re-run in
[`results/p9-acceptance.md`](../04-prototype-development/results/p9-acceptance.md).

---

## 2. Consolidated learnings

### 2.1 The AI's contribution was the oracle, not the harness

The framing this IDP started from — *"AI can scaffold `cargo-fuzz` targets, reducing the boilerplate
of wiring up `Env`, clients and `arbitrary` inputs"* (Topic 2 §8) — turned out to be **the least
valuable of the three insertion points.**

Harness boilerplate is mechanical, and the model got the mechanical parts wrong: 16 of its 17
compile errors came from one incorrect assumption about the SDK's generated `try_*` signature. That
class of error is caught by `rustc` in seconds and costs nothing.

What it contributed instead was **job 2 from Topic 2 §5** — knowing what to assert. Thirteen usable
invariants from sixteen proposals, including ten of the twelve in a catalogue it had never seen, and
both of the Soroban-specific ones (I10′ TTL management, I11 temporary-tier authority) derived from
source alone.

**Restated as advice:** do not buy AI assistance for the code generation. Buy it for the property
enumeration, and expect to fix the code.

### 2.2 The oracle is the whole ballgame

Both arms run the same engine, the same contract, the same budget. The baseline catches 1 of 7; the
AI arm catches 7 of 7. The single difference is that one asks *"did the call abort?"* and the other
reads state back and compares it against an independent computation.

Six of the seven seeded bugs are **silent**: the contract accepts the call, returns normally, and is
wrong. A liveness oracle is structurally blind to them. This is not a subtle finding, but it is
worth stating plainly because the tutorial example that every Soroban developer starts from —
including the one quoted in Topic 2 §5 — asserts exactly liveness.

### 2.3 "Assert which error" is worth more than it sounds

Two of the three sharpest results in Topic 4 come from one rule, written into the harness prompt
because of a P3 finding: *where the only assertion available is "this must abort", assert **which**
error came back and that state did not change.*

- **`bug_overflow` is only detectable because of it.** The wrapped product trips a downstream guard,
  so the buggy contract *does* abort — `assert!(result.is_err())` passes. The harness fails it
  because it predicted `Overflow` and got `ZeroShares`.
- **`bug_zero_amount` is caught by an invariant nobody wrote down.** I7 was missed in the proposal
  round and is absent from the curated set. The exact-error oracle catches it anyway, in three
  separate properties, because it predicts the rejection reason for *every* input.

**Detection coverage exceeded invariant coverage.** For a fuzzing program, that argues for investing
in a closed-form oracle over lengthening the invariant list.

### 2.4 Where the LLM's reasoning fails is predictable

The model's single most confident claim — that `withdraw` can burn shares and pay zero through
integer truncation, *"the highest-value truncation target in the file"* — is **false**. The payout
is never zero, because `assets ≥ total_shares` holds over every reachable state.

The failure is structural, not random: it **analysed one expression in isolation and never asked
which states are reachable.** Everything it needed was in the file; what was missing was the global
induction.

That is a usable rule for placing the human checkpoint:

| The model is reliable at | The model is unreliable at |
|---|---|
| Reading one expression and enumerating how it can go wrong | Deciding whether that state is reachable |
| Mapping code paths to guards (which function calls `require_auth`) | Whole-program invariants over sequences |
| Recalling platform semantics (`extend_ttl` conditional extension) | Its own confidence calibration |

Note the last row. The refuted claim was stated with *more* confidence than anything else in either
output. Confidence is not a usable signal for triage.

### 2.4b Two instruments, one answer

The seeded-bug benchmark and mutation testing are independent: `cargo-mutants` knows nothing about
the seven planted bugs, mutilates the contract on its own, and asks whether the suite notices.

| | Seeds | Mutants (adjusted) |
|---|---|---|
| Baseline arm | 1 / 7 | 34 % |
| AI arm | 7 / 7 | 98 % |

Two instruments built on different principles agreeing this closely is the strongest available
evidence that **neither number is an artifact of how the benchmark was designed** — which is the one
objection a purpose-built seeded-bug benchmark can never answer on its own.

It also produced the phase's most unexpected result: **the AI arm covers a gap in the hand-written
ground truth.** `bump_instance` can be deleted from the contract entirely and all 22 hand-written
tests still pass — including `i10_persistent_entries_are_ttl_managed_not_restored`, written
specifically about TTL, which checks the persistent entry while nobody checked the instance entry.
The AI arm catches it through N1, an invariant the model proposed unprompted and the Topic 3
catalogue did not contain. The reference the arms were supposed to be measured *against* turned out
to be the weaker of the two on that axis.

### 2.5 EVM bug taxonomies do not port to Soroban

`overflow-checks = true` is the Soroban project-template default, so naive `+` and `*` abort rather
than wrap. The BeautyChain-style integer-overflow bug had to be seeded with an explicit
`wrapping_mul` to exist at all. Scenario S04 in ChainGuard's exploit catalogue — inherited straight
from EVM thinking — is substantially **less** applicable to Soroban than to Solidity.

Conversely, the two bug classes with no EVM analogue (TTL/archival mismanagement, authority read
from a tier that can silently expire) are where the real Soroban-specific risk sits, and they are
absent from every EVM-derived checklist.

### 2.6 Protocol 23 changed what a TTL invariant can even say

The original I10 — *"a balance written in one invocation is readable in the next"* — is **always
true** and cannot fail, because protocol 23 auto-restores archived persistent entries and the test
host emulates it. It was a useless fuzzing target and the P1 spike caught it before any effort was
spent on it.

The falsifiable property is I10′: a correct contract never *silently relies* on restoration, which
is observable because a restored entry's TTL resets to `min_persistent_entry_ttl - 1`. **The hazard
moved from data loss to unexpected rent cost.** Temporary entries are not restored, which is why
I11 — not I10 — is the primary Soroban-specific invariant.

### 2.7 Benchmark integrity is harder than stating the rule

The rule was one line: *the prompts see the contract source, never the seed list.* Enforcing it took
two mechanisms and left three holes.

- **The contract source was the seed list.** In-place `cfg` bug seeding makes the target
  un-showable. Required a scrubbed clean view, verified by substitution.
- **The assistant running the project was contaminated** by having executed the earlier phases.
  Required clean-context subagents with single-file access.
- **Three channels remain open** and are documented, not hidden:
  [`ai-arm-provenance.md`](../04-prototype-development/results/ai-arm-provenance.md).

And the isolation had a **cost**: the model rejected I7 with reasoning that was sound given what it
could see ("the liveness arm already catches it") and wrong given what it could not. The same wall
that keeps the benchmark honest withholds context that would improve judgement calls.

### 2.8 The tooling will lie to you quietly

`cargo fuzz --features` is accepted by cargo-fuzz 0.13.2, silently dropped, and reports no error.
The first fuzzing matrix produced a plausible, quiet, wrong number: *"the AI arm missed
`bug_self_transfer`"* — when the seed had never been compiled in.

It was caught only because the result contradicted the `proptest` arm. The runner now aborts unless
the seed forces a recompile of the contract crate.

**This is the strongest vindication of the execution plan's design rule** — every gate is a command
with an expected result, and nothing is done because it feels done. A benchmark that reports numbers
nobody cross-checks is a benchmark that reports whatever the tooling felt like.

### 2.9 What carried over from ChainGuard

The prior prototype's real lesson was scope, and it held: Topic 3 explicitly excluded the platform,
the queue, the database, the RAG layer and the reports — everything ChainGuard built instead of
running its analysis. Topic 4 is a Rust workspace, a prompt library and a write-up, and it runs.

Two of its technical findings also held: that a fresh `Env` per call is the right isolation
primitive, and that its `input_generator.rs` pattern — fuzz an *index into a pool of known
principals* rather than raw address bytes — is exactly what P1 Spike B independently concluded was
necessary.

---

## 3. Topic 3 open questions — answered

All five questions carried into Topic 4 ([Topic 3 §10](../03-solution-architecture/README.md#10-open-questions-carried-into-topic-4)),
with an answer or an explicit "still open".

### Q1 — Does `SorobanArbitrary` generate `Address` values that produce meaningful auth scenarios?

**Answered: no.** (P1, Spike B — [`results/spikes.md`](../04-prototype-development/results/spikes.md).)
Generated addresses cannot be authorized via `MockAuth`, so every access-control property would
collapse into "an unknown address is rejected". Resolved by fuzzing an **index into a fixed pool** of
registered principals. Raw generated addresses remain useful where an address is *data* rather than
an actor — the AI harness uses them for exactly that, in the re-`initialize` property.

### Q2 — Can TTL / state archival be exercised in `Env`?

**Answered: yes, but not the way it was designed.** (P1, Spike A.) The host exposes full ledger
control and `get_ttl()`. But protocol 23 auto-restores persistent entries, which forced I10 → I10′
and promoted I11 to the primary Soroban invariant. See §2.6.

### Q3 — Does `cargo-mutants` cope with `#![no_std]` + `soroban-sdk` macro expansion?

**Answered: yes.** (P7 — [`results/mutants.md`](../04-prototype-development/results/mutants.md).)
68 mutants generated from a `#![no_std]` contract behind `#[contract]`, `#[contractimpl]`,
`#[contracttype]` and `#[contracterror]`; 65 build. The 3 that do not are a legitimate `Default`
bound failure, not macro breakage, and the tool classifies them as unviable itself.

Two operational caveats came out of it. **Run it per test target** — a single whole-workspace score
would have averaged a 34 % suite with a 98 % one into a meaningless number, and the whole point of
the phase is the comparison. And **a timeout is not a miss**: a property suite that fails *and
shrinks* can blow through a sane per-mutant timeout, so six AI-arm mutants had to be re-measured
with shrinking capped before they could be scored. All six were detections.

### Q4 — Is coverage-guided fuzzing meaningfully better than `proptest` here, or is the contract small enough that `proptest` saturates it?

**Answered: neither, as posed.** (P6 — [`results/p6-fuzzing.md`](../04-prototype-development/results/p6-fuzzing.md) §7.)

The `proptest` arm reaches 7/7 in about 11 seconds of `cargo test`. The coverage-guided arm reaches
the same set only after its generator is given the input prior — and up to ~2 minutes for the
arithmetic seeds. Coverage guidance is not adding depth here; it is **recovering ground that
hand-written `proptest` strategies get for free**, because those strategies already encode the
valid-input structure that byte-level mutation has to rediscover.

The question assumed the alternative to saturation was depth. The real answer is that on a contract
with a narrow validity funnel, **the binding constraint is input structure, not search strategy** —
and a coverage-guided fuzzer pays for its structural blindness long before its feedback loop can
help. Round 1 of the fuzz arm, with unshaped `i128` operands, found 2 of 7 despite running 180 000
executions per seed; the `proptest` arm found 7 of 7 in a few hundred cases.

This **inverts the emphasis Topic 3 §4.2 gave them.** `proptest` is the primary layer for a contract
of this shape; `cargo-fuzz` is the overnight one, earning its keep by running unattended for hours
where `proptest`'s fixed case budget stops.

### Q5 — Does `cost_estimate()` make a better TTL oracle than storage reads?

**Still open, and deliberately not pursued.** The hypothesis (from Spike A) was that the SDK's
`write_entries` and `persistent_entry_rent_bumps` resource counters jump when a restoration occurs,
making them a cheaper signal than reading TTLs.

It was not tested because the direct approach turned out to be sufficient: `get_ttl()` inside
`env.as_contract(..)` detects both I10′ and N1 cleanly, and `bug_no_ttl` is caught by four separate
properties. Adding a second, less direct oracle for the same bug class would have cost budget
without a measurable question attached.

**Why it might still matter:** a resource-counter oracle is *contract-agnostic* — it needs no
knowledge of which storage keys exist — so it would apply to a contract the harness author has not
read. That makes it interesting for the "fuzz an arbitrary contract" direction in §4, and useless
for the case actually benchmarked here. Recorded as future work rather than as a gap.

---

## 4. Limitations and future work

### 4.1 Limitations of the measurement

These bound what the 1/7 → 7/7 result is allowed to mean.

| # | Limitation | Why it matters |
|---|---|---|
| L1 | **The contract was purpose-built around the invariant catalogue** (Topic 3 §5) | A model reading `soroban-vault` reads a contract whose shape already implies most of the properties. This inflates apparent insight and is inherent to any purpose-built target. |
| L2 | **Same model family authored the contract and proposed the invariants** | What it finds natural to write, it finds natural to check. |
| L3 | **One contract, one model, one run** | 81 % yield and 7/7 detection are *single observations*, not distributions. No variance estimate, no significance claim. |
| L4 | **The seeds were designed by someone who knew the invariants** | They are not one-line typos (P3 Finding 3), but they are not field-collected bugs either. |
| L5 | **Both arms are AI-authored**, so "authoring time" could not be collected as specified | Replaced by proxy metrics — harness size, compile iterations, invariant yield. The productivity claim this IDP *cannot* make is "AI makes a developer faster". |
| L6 | **I4 and I5 are asserted weaker than stated** | "Only the incumbent authorized" is tested as "nobody authorized", so a contract accepting *any* signer would pass. Flagged by the model in its own harness. |
| L7 | **The deployed WASM is not what gets fuzzed** | Both arms link the contract crate directly, to get coverage instrumentation. The bytecode that ships is not the artifact under test. |
| L8 | **Instance-tier archival is not reachable in the test host** | Proposal 7 (a zero `total_shares` read silently diluting every holder) is a real on-chain hazard that could not be driven from `Env` — a limitation of the substrate, not a non-issue. |

### 4.2 Future work, in the order I would actually do it

1. **Fuzz the deployed bytecode.** Load the `.wasm` into `Env` rather than linking the crate — the
   approach ChainGuard's `soroban-fuzzer` used. It loses coverage instrumentation and gains "this is
   what actually ships", and it closes L7. It also generalises to contracts the harness author did
   not write, which is where Q5's contract-agnostic oracle becomes interesting.
2. **Turn single observations into distributions** (L3). More contracts, more models, repeated runs
   with different seeds. Until then, no statistical claim is defensible.
3. **A human-authored control arm** (L5). The only way to measure a real productivity delta is for a
   developer to write the baseline under a timer while only the AI arm is assistant-authored.
4. **Automate the A→B→C/D→E→A loop.** Findings currently feed back into the next prompt round by
   hand. The human should stay in the *decision* path and leave the *transport* path. This was
   explicitly out of scope for Topic 3 and remains the obvious next build.
5. **Formal methods where fuzzing saturates.** If P6 shows coverage-guided fuzzing adds nothing over
   `proptest` on a contract this small, that is a saturation signal, and bounded model checking
   (Kani) is the tool that answers "is it *exhausted*?" rather than "did we find anything?".
6. **A second round of the invariant prompt, with the first round's results as context.** Labelled
   as a second round, per the integrity rule. The interesting question is whether the model corrects
   its own refuted claim (§2.4) when shown the counterexample.

### 4.3 What I would tell someone starting this

- Write the control arm **first**, before you have seen any AI output. It is the only part of the
  experiment you cannot fix later.
- Make every gate a command with an expected result. The one number that was wrong in this project
  was quiet, plausible, and pointed the wrong way (§2.8).
- Ask the model for an **"assumptions I could not verify"** section. It cost one paragraph and
  pre-marked the exact line of the only runtime bug it shipped, along with the wrong way to fix it.
- Re-check minimised reproducers against the clean build. Shrinkers optimise for the smallest
  failing input, not the smallest input failing *for your reason*.
- Budget for the benchmark's integrity, not just its content. Both mechanisms in §2.7 were
  discovered mid-phase and neither was in the plan.

---

## 5. Presentation and demo

**Deck:** [`docs/deck.md`](../docs/deck.md) — 16 slides, 20 minutes plus questions, with the
cut-first slides marked.

**Demo:** [`04-prototype-development/scripts/demo.sh`](../04-prototype-development/scripts/demo.sh) —
seeded bug → baseline misses it → AI arm catches it → minimised reproducer → fix. Runs in about two
minutes and prints only what it produces live.

The clean-clone requirement is deliberate and is the check that catches "works only on my machine" —
which is precisely how ChainGuard ended up unrunnable:

```bash
git clone <repo> fresh && cd fresh
cargo test                                    # no manual setup
./04-prototype-development/scripts/demo.sh
```

Verified in [`results/p9-acceptance.md`](../04-prototype-development/results/p9-acceptance.md).

---

## 6. Final acceptance

The [execution plan §5](../docs/execution-plan.md) checklist, run on delivery:

- [x] Topics 1–5 all marked ✅ with real deliverables linked
- [x] Every Topic 3 open question answered, or explicitly marked still-open with reasoning (§3)
- [x] Demo runs end-to-end from a clean clone
- [x] Deck and demo linked from this document
- [x] Limitations section is honest and specific — no unfalsifiable claims of success (§4.1)
- [x] Repository is self-contained: someone else can clone it and reproduce the benchmark from the
      README alone

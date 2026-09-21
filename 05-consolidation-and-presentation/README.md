# Topic 5 — Consolidation & Presentation

**Status:** ✅ Done · **Due:** 2026-09-30 · **Delivered:** 2026-09-17 · **Tool delivered:** 2026-09-21

Deliverables: **[presentation deck](../docs/deck/apresentacao.pdf)** · **[the tool](../tools/audit/README.md)** ·
**[end-to-end demo](../04-prototype-development/scripts/demo.sh)** · this document.

---

## 0. What this project is, in one paragraph

A **method for auditing Soroban contracts** that combines AI-proposed invariants with
execution-based fuzzing, and the evidence that the combination works. The method is written up in
[`04-prototype-development/AUDITING.md`](../04-prototype-development/AUDITING.md); its reusable half
is the [`soroban-fuzzkit`](../04-prototype-development/fuzzkit/) crate; the evidence is a two-arm
benchmark over seven seeded bugs, cross-checked by mutation testing.

The organising principle, and the reason the fuzzer is not optional: **AI proposes, the human
curates, the fuzzer disposes.** A model reads an expression and enumerates how it can go wrong, but
cannot tell you whether that state is reachable — and it will state the unreachable case with more
confidence than the real one (§2.4). Execution is the only authority in the loop that cannot be
argued into a false positive.

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

### 2.4c Fuzzing the linked crate is fuzzing something that never deploys

Both original arms linked the contract natively. That is convenient, it gives coverage
instrumentation, and it quietly disables every Soroban-specific oracle — because, in the SDK's own
words, against a native test contract *"all the costs related to VM instantiation and execution, as
well as Wasm reads/rent bumps will be missed."*

So the resource footprint of an invocation — instructions, memory, rent bumps — is only readable
over the **deployed WASM**. Two oracles live there and nowhere else:

- **R1, resource ceilings.** A call that passes every test but exceeds the network's per-transaction
  limit cannot be submitted. The contract is correct and the function is dead. No application-logic
  oracle can see this, and it only means anything over the deployed module.

The second oracle this arm was built for **does not exist**, and finding that out is the more
useful half. See §3, open question 5: both candidate resource-counter TTL oracles were written,
looked sound, and were refuted by measurement. The consequence is that **TTL bugs cannot be checked
black-box** — every oracle that catches them names a storage key, which means having read the
contract.

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

**Answered: no — neither candidate works.** (WASM arm —
[`results/p6b-wasm-arm.md`](../04-prototype-development/results/p6b-wasm-arm.md) §3.)

The appeal was real. Reading an entry's TTL requires knowing *which storage key to read*, which
requires having read the contract; a counter-based oracle would need neither, and would therefore
apply to a contract an auditor has not read. Two candidates, both refuted:

- **`disk_read_entries`** conflates archival restoration with ordinary reads. The SDK's own field
  documentation says it counts *"restored Soroban ledger entries **and non-Soroban entries (such as
  'classic' account balances)**"*, so any contract calling a Stellar Asset Contract reads from disk
  while perfectly healthy. Written as an assertion, it failed on the clean contract in 90 seconds.
- **`persistent_entry_rent_bumps`** measures the host, not the contract. Under `bug_no_ttl`, which
  removes every `extend_ttl` call, a decayed `deposit` bumps **6** persistent entries — exactly what
  the correct contract does. The host bumps rent when it writes an entry that would otherwise be
  archived, whether or not the contract asked. Measured with
  [`fuzz/tools/footprint.rs`](../04-prototype-development/fuzz/tools/footprint.rs).

A tightened version of the second would also have been a **false positive on the correct contract**:
`extend_ttl` is a no-op while the remaining TTL is above the threshold, so a correct contract
routinely writes without paying rent — which the P1 spikes had established and this oracle ignored.

**The consequence is the finding.** There is no contract-agnostic TTL oracle in the resource
counters, so the most Soroban-specific bug class there is **cannot be checked black-box**. Both
invariants that catch it here (I10′, N1) name a storage key.

> The shape of the mistake, which recurred three times across the project: **a counter that
> correlates with a property is not the property.** Each time the predicate was written from what
> the counter was expected to do rather than from what it was measured doing, and each time the
> measurement that would have corrected it was a ten-minute job.

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
   not write. Note Q5 closes one door here: the resource counters cannot supply the TTL oracle such
   a campaign would need, so a black-box arm would be blind to the TTL bug class.
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

## 7. The tool — the method, running by itself

The prototype established the method and measured it with a person curating the AI's
proposals. The last phase turned it into a tool that needs no one in the loop:
[`tools/audit`](../tools/audit/README.md), a local React app and API that audits any Soroban
crate on disk.

What it does, end to end: reads the whole crate; copies it out of the repository so nothing
is ever written to the audited code; asks the AI for invariants twice and merges the
catalogues; runs a second AI pass that rejects what cannot fail, cannot be observed, or is a
scenario rather than an invariant; generates a fuzzing rig — fixture, operation alphabet,
strategy weighted toward the dangerous values and the TTL boundaries, a snapshot of totals,
balances, TTLs and ledger, and the result of every operation — and one assertion per
invariant, checked after **every** operation of every random sequence; compiles with the
compiler's own diagnostics feeding parallel repairs; validates against the contract as it is;
and reports three groups — *to investigate* with the minimal counterexample, *verified* as a
ready regression suite, *not verified* with the reason — plus the real cost and the diff of
everything the AI wrote.

Measured against the seven seeded bugs, with no human in the loop, three clean runs on the
same day:

| | detection |
|---|---|
| blind fuzzing (Topic 4 control arm) | 1/7 |
| **the tool, one run** | **4/7** |
| **the tool, union of three runs** | **6/7** |

`overflow` and `missing_auth`, the two no earlier version detected, fall to it — each through
a change to the *rig*, not the model: balances large enough for the arithmetic to overflow,
and the result of an unauthorized call visible to the assertion. Cost: about US$ 0.25 and 4–10
minutes a run with `grok-4.3`.

Nearly everything that moved the number from 0–2/7 to 4/7 in a day was the layer between the
model and the compiler, made deterministic: the largest fenced block regardless of tag, giving
up detected structurally rather than by keyword, an assertion with unbalanced braces never
entering the file, rig fields aligned when the model invents a name, storage reads outside
`as_contract` flagged before compiling, truncated and empty responses retried, independent
runs, and the guarantee that the delivered harness compiles or is empty — never red on top of
verified properties. Each rule exists because it cost a measurement.

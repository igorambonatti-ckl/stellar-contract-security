# Auditing a Soroban contract with AI-assisted fuzzing

**The method this prototype produced.** Not "does AI help?" — that question is answered in
[`results/benchmark.md`](results/benchmark.md). This is how to point the thing at a contract.

The premise throughout: **AI proposes, the human curates, the fuzzer disposes.** A model is good at
reading an expression and enumerating how it can go wrong. It is bad at deciding whether that state
is reachable. The fuzzer settles reachability by execution, which is the only authority in the loop
that cannot be talked into a false positive.

---

## The pipeline

```
   contract source                       ┌──────────────────────────────┐
         │                               │ 0. clean view                │
         ├──────────────────────────────▶│    strip anything that       │
         │                               │    leaks the answer          │
         │                               └───────────────┬──────────────┘
         │                                               ▼
         │   ┌────────────────────┐          ┌──────────────────────────┐
         └──▶│ 1. propose         │─────────▶│ 2. curate  (human)       │
             │    invariants      │          │    accept/reject/rewrite │
             └────────────────────┘          └───────────┬──────────────┘
                                                         ▼
             ┌────────────────────┐          ┌──────────────────────────┐
             │ 3. prioritise      │─────────▶│ 4. generate harness      │
             │    inputs          │          │    + fix to compile      │
             └────────────────────┘          └───────────┬──────────────┘
                                                         ▼
          ┌───────────────────────────────────────────────────────────┐
          │ 5. run: proptest (fast, CI) + cargo-fuzz over the WASM     │
          │    clean-contract control FIRST — a crash there blocks all │
          └───────────────────────────┬───────────────────────────────┘
                                      ▼
          ┌───────────────────────────────────────────────────────────┐
          │ 6. triage: is the failure attributable, and is it          │
          │    reachable on-chain?                                     │
          └───────────────────────────┬───────────────────────────────┘
                                      │ refuted findings become invariants
                                      └──────────────▶ back to 2
```

Steps 1, 3 and 4 are the AI insertion points ([`prompts/`](prompts/)). Steps 2 and 6 are where a
human is not optional. Step 5 is the only step that produces evidence.

---

## Step 0 — Give the model a clean view

**The contract source may already contain the answers.** In this project the seeded bugs lived in
`src/lib.rs` behind `#[cfg(feature = "bug_*")]`, with comments naming each one: 22 lines of the file
were the answer key. Handing it over would have measured recall, not analysis.

In a real audit the equivalent leaks are a `// FIXME: this is wrong` comment, a git branch name, a
previous audit's findings in a doc comment. Strip them, and **verify the stripped view is
behaviourally identical** — here, by substituting it for the real source and re-running the suite
(22/22, unchanged). An unverified clean view is a second contract.

## Step 1 — Propose invariants

[`prompts/propose-invariants.md`](prompts/propose-invariants.md). Ask for properties that relate
**two or more observable quantities** and that can fail **silently**. A property whose only failure
mode is a panic adds nothing over liveness checking, which you get for free.

Require, per proposal: the statement, how a harness observes a violation, whether it fails silently
or loudly, **the assumption being taken on faith**, and a confidence rating. The assumption row is
the cheapest thing in this entire method — see step 4.

Ask for a *"properties I considered and rejected"* section. It is as useful as the list.

## Step 2 — Curate (human)

Record accept / reject / rewrite **with reasons**, per proposal, in a file
([`invariants.md`](invariants.md)). Two rules earned in practice:

- **"This must revert" is accepted only if the test distinguishes the *right* failure.**
  `assert!(result.is_err())` passes when the contract fails for an unrelated reason, and that is not
  hypothetical: it is how a seeded arithmetic bug passed a liveness oracle here — the wrapped
  product tripped a *downstream* guard, so the buggy contract did abort, just with the wrong error.
- **Reconcile the ledger against the proposal count.** This project reported 12 of 16 kept for the
  better part of a day; it was 13, and the missing one was implemented but never recorded. A
  curation ledger that does not add up is not an audit trail.

When you reject a proposal, ask *why* it is false. Here the model's highest-confidence claim — a
silent-loss path in `withdraw` — was unreachable because `assets ≥ total_shares` holds over every
reachable state. **That reason became an invariant** and is asserted on every run. Refutations are
findings.

## Step 3 — Prioritise inputs

[`prompts/prioritise-inputs.md`](prompts/prioritise-inputs.md). This is the step that is easy to
run, easy to commit, and easy to never integrate — which is exactly what happened here, and the
fuzzing arm found 2 of 7 seeds until it was folded in, after which it found 7 of 7.

The generic half of that output is now [`soroban-fuzzkit`](fuzzkit/), so the integration is a
dependency rather than a rewrite: weighted boundary literals, **state-relative operands**
(`balance ± δ` — the family nobody writes and the one that puts the fuzzer on a guard boundary every
call), a principal pool drawn by index, and ledger advances probed around TTL cliffs.

## Step 4 — Generate the harness, then fix it

[`prompts/generate-harness.md`](prompts/generate-harness.md). **Expect the code to be wrong and the
reasoning to be right.** Here, 16 of 17 compile errors came from one incorrect assumption about the
SDK's generated signatures — caught by `rustc` in seconds, costing nothing.

The runtime bug was different: a revoked-authorization failure arrives through a different channel
than the model assumed. It had **flagged that exact line itself**, in the "assumptions I could not
verify" section, including the *wrong* way to fix it:

> "…those arms need widening to `Err(Err(_))` — but **not** to `Err(_)`, because
> `Err(Ok(VaultError::…))` must stay a failure (it would mean the call was rejected for an unrelated
> reason)."

One paragraph of prompt pre-marked the bug, its symptom, and the trap in fixing it. Always ask for
that section.

## Step 5 — Run, controls first

**Run the clean contract before anything else.** A crash there is a false positive, and until it is
resolved *no* finding from that arm is attributable — they may all be the same harness bug. This
fired here: a fuzzing arm reported 8 of 8 detections while also crashing on the correct contract, and
every one of those detections had to be discarded.

Layer by speed:

| Layer | What it is for |
|---|---|
| Hand-written invariant tests | ground truth; the thing everything else is measured against |
| `proptest` | the CI layer — seconds, no nightly, catches regressions |
| `cargo-fuzz` over the **WASM** | the unattended layer, and the only one where Soroban's resource oracles mean anything |

The WASM arm matters for two reasons: it is what actually deploys, and the SDK is explicit that
against a natively-linked contract *"all the costs related to VM instantiation and execution, as
well as Wasm reads/rent bumps will be missed"* — so rent and resource oracles are vacuous unless you
fuzz the deployed module.

## Step 6 — Triage: attributable, and reachable?

Two questions, in order, before anything is written down as a finding.

**Is it attributable?** Read the assertion message, not the red/green. Two failures here were
reported under an assertion that named a property neither of them violated. Nothing in any checklist
required re-reading text that had already gone green, and that is the process gap this project ends
with.

**Is it reachable on-chain?** The sharpest example: the fuzzer found that `deposit(from = vault)`
mints shares against a token transfer from the vault to itself, creating value from nothing. The
accounting asymmetry is **real**. It is also **unreportable**, because no external caller can forge
the contract's own authorization — the path existed only because the harness mocked all
authorization. A finding that cannot be triggered by an attacker is a harness bug wearing a
finding's clothes.

**A minimised reproducer is not automatically an instance of your bug.** Shrinkers optimise for the
smallest *failing* input, not the smallest input failing *for your reason*. Re-check every minimised
case against the clean build.

---

## What Soroban adds that a generic fuzzing method misses

The bug classes with no EVM analogue, and where each is caught:

| Hazard | Oracle | Layer |
|---|---|---|
| Persistent entry written without extending its TTL | entry TTL ≥ threshold after any write (**I10′**) | `proptest` |
| Instance TTL decaying while balances stay alive | instance TTL ≥ threshold after a bumping call (**N1**) | `proptest`, fuzz |
| Authority read from a tier that can silently expire | expiring every temporary entry changes no other observable (**I11**) | `proptest`, differential |
| A call that cannot be submitted on-chain | per-transaction resource ceilings (**R1**) | WASM fuzz |

**And one hazard with no black-box oracle at all.** The obvious idea — detect a missing `extend_ttl`
from the invocation's own resource counters, so you need no knowledge of the storage layout — was
tried twice and refuted both times:

- `disk_read_entries` also counts non-Soroban entries such as classic account balances, so any
  contract calling a token "reads from disk" while perfectly healthy. It failed on the clean
  contract in under 90 seconds.
- `persistent_entry_rent_bumps` measures the **host**, not the contract. Under a seed that removes
  every `extend_ttl` call, a decayed write bumps exactly as much rent as the correct contract does,
  because the host bumps rent when it writes an entry that would otherwise be archived. Measured,
  not assumed — [`fuzz/tools/footprint.rs`](fuzz/tools/footprint.rs).

So **TTL bugs cannot be checked black-box.** Both oracles that do catch them (I10′, N1) name a
storage key, which means having read the contract. For an auditor that is a real constraint on the
most Soroban-specific bug class there is, and it is worth knowing before promising otherwise.

Conversely, one EVM habit to drop: `overflow-checks` is on in the Soroban project template, so naive
`+` and `*` **abort rather than wrap**. The classic integer-overflow bug barely exists here and had
to be seeded with an explicit `wrapping_mul` to exist at all.

---

## Reliability: what makes a finding trustworthy

In order of how much each one caught:

1. **A clean-contract control on every arm.** Non-negotiable, and it earned its place.
2. **Attribution by message, not by colour.** Every detection in this project was verified by reading
   what actually broke.
3. **Two independent instruments.** Seeded bugs and mutation testing know nothing about each other;
   agreement between them is what answers "is this result an artifact of how you chose the seeds?"
4. **Every gate is a command with an expected result.** The one wrong number that survived longest
   was produced by a tool that accepted a flag and silently ignored it — quiet, plausible, pointing
   the wrong way.
5. **Keep the superseded run.** The assisted arm was briefly *worse* than the crude control. Keeping
   both rounds is what turned that from an embarrassment into the measurement of what the third
   prompt contributes.

## Start here

```bash
cargo test                                   # everything, clean contract
./04-prototype-development/scripts/demo.sh   # one seeded bug, both arms, ~2 min
```

Then read [`invariants.md`](invariants.md) for what curation looks like, and
[`fuzzkit/src/`](fuzzkit/src/) for the reusable parts.

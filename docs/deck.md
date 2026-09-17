# AI-Assisted Fuzzing for Soroban Smart Contracts

> Presentation deck for the IDP *"Developing Smart Contract Skills on Stellar with a Focus on
> Security and AI-Assisted Fuzzing"*. One slide per `---` section; renders with any Markdown slide
> tool (Marp, reveal-md, `slides`) or reads fine as a document.
>
> **Target length: 20 minutes + 10 for questions.** Slides marked *(cut first)* go if running long.

---

## 1 · The thesis

**AI proposes, the human curates, the fuzzer disposes.**

A model reads an expression and enumerates how it can go wrong. It cannot tell you whether that
state is *reachable* — and it will state the unreachable case with more confidence than the real
one.

The fuzzer settles reachability by execution. It is the only authority in the loop that cannot be
argued into a false positive.

This is a method for **auditing Soroban contracts**. The rest of this deck is the evidence that the
combination works, and the list of things that had to be got right for the evidence to mean
anything.

---

## 2 · Why Soroban needs this

Ethereum has Echidna and Foundry invariant testing. Soroban has none of that.

The Rust stack (`cargo-fuzz`, `proptest`, `SorobanArbitrary`, `cargo-mutants`) supplies the
**machinery** and leaves three jobs to the developer:

1. Write the harness — boilerplate, per function, per contract.
2. **Know what to assert** — the valuable invariants must be *stated* by someone who understands
   the contract.
3. Choose where to look.

Job 2 is where fuzzing programs die. That is the one to test.

---

## 3 · The setup

**`soroban-vault`** — a deposit/withdraw share vault. 8 entry points, all three storage tiers,
12 invariants, **7 seeded bugs** behind individual cargo features.

Every seed was *proven* to break the invariant it targets before any fuzzing began. A benchmark
built on seeds that do not actually represent bugs measures nothing.

| Arm | Oracle | Written |
|---|---|---|
| **Baseline** | "the call does not abort" | **first**, before any prompt was run |
| **AI** | invariants proposed by Claude Opus 5, curated by hand | after |

Same engine. Same contract. Same budget. **Only the oracle differs.**

---

## 4 · Result

<br>

| | Baseline | **AI-assisted** |
|---|---|---|
| Seeded bugs detected | **1 / 7** | **7 / 7** |
| Mutation score | **34 %** | **98 %** |

<br>

The baseline catches exactly the one bug that makes the contract *abort*.
The other six are **silent accounting faults**: the call returns normally and the state is simply
wrong.

**The difference is not more inputs. It is an oracle that inspects state.**

The second row is an independent instrument — `cargo-mutants` knows nothing about the planted bugs.
Two measurements built on different principles agreeing is what answers the objection a
purpose-built benchmark cannot answer for itself.

---

## 5 · Keeping it honest — problem 1

The plan said: *the prompts see the contract source, never the seed list.*

Then it turned out **the contract source _is_ the seed list**:

```rust
// I9 — re-initialization must always abort. Removing this guard is the
// `bug_reinit` seed, and it is the Parity / front-run-init bug class.
#[cfg(not(feature = "bug_reinit"))]
if env.storage().instance().has(&DataKey::Admin) {
```

22 lines name a seed or an invariant ID. In-place `cfg` seeding makes the target **un-showable** to
the system under test.

**Fix:** a scrubbed clean view of the contract, *verified by substitution* — swap it in, run the
suite, 22/22 identical.

---

## 6 · Keeping it honest — problem 2

The assistant running the IDP had already read the seed list, to do phases P0–P4.

It could not author the AI arm without importing the answers.

**Fix:** each prompt executed by a **separate subagent with an empty context window**, permitted to
open exactly one file.

Three contamination channels remain open and are documented rather than hidden — chiefly that the
contract was *purpose-built* around the invariant catalogue, so a model reading it is reading a
contract whose shape already implies the properties.

---

## 7 · What the AI got right

**Yield: 13 kept of 16 proposed (81 %).**
Against the pre-existing catalogue it never saw: **10 of 12 re-derived**, 2 missed, **4 new**.

The two it mattered most to get:

- **I10′** — a persistent entry's TTL must be the *extended* value, never the post-restoration
  minimum.
- **I11** — auth-critical state must never be read from a tier that can silently expire.

These are the invariants with **no EVM analogue**. It produced both from source alone, including the
non-obvious rule that `extend_ttl(threshold, extend_to)` only extends when the remaining TTL is
already below `threshold`.

---

## 8 · What the AI got wrong

Four fixes between raw output and a green run. The interesting one:

It asserted that a revoked-auth failure arrives as `Err(Err(InvokeError::Abort))`. It does not.

**It had flagged this itself**, in an "Assumptions I could not verify" section — including the
*wrong* way to fix it:

> "…those arms need widening to `Err(Err(_))` — but **not** to `Err(_)`, because
> `Err(Ok(VaultError::…))` must stay a failure (it would mean the call was rejected for an
> unrelated reason)."

One paragraph of prompt turned a runtime failure into a five-minute fix **with the trap
pre-marked.** Cheapest thing in this whole project.

---

## 9 · The AI's most confident claim was wrong

> *"the highest-value truncation target in the file"* — `withdraw` can burn shares and pay zero.

Specific, cited the right lines, stated with more confidence than anything else it produced.

**Unreachable.** `assets ≥ total_shares` holds over every reachable state, provable by induction
over the four mutators.

It analysed **one expression locally** and never asked **which states are reachable**.
Local expression analysis: what an LLM is good at. Global reachability: what it is not.

**That is where the human checkpoint goes.**

---

## 10 · …and it became an invariant anyway

The claim was rejected. The *reason it is false* — `assets ≥ total_shares` — became invariant **N2**,
which the harness now proves on every run.

A refuted AI hypothesis turned into a kept invariant.

That is the architecture's feedback loop (**AI proposes → human curates → fuzzer disposes → back to
the AI**) doing exactly what it was drawn to do.

---

## 11 · The surprise nobody planned

`bug_zero_amount` targets **I7 — an invariant the model missed** and which is *not* in the curated
set.

The AI arm detects it anyway. In three separate properties.

Because the harness predicts the **exact rejection reason** for every input, a guard that stops
rejecting gets caught whether or not anyone wrote down an invariant for it.

**Detection coverage exceeded invariant coverage.**
The strongest argument here for exact-error oracles over property enumeration.

---

## 12 · A Soroban-specific finding *(cut first)*

**The classic integer-overflow bug barely exists in Soroban.**

`overflow-checks = true` is the project-template default, so naive `+` and `*` *abort* rather than
wrap. The BeautyChain-style bug had to be seeded with explicit `wrapping_mul` to exist at all.

Even then it does not fail loudly — the wrapped product trips a downstream guard, so the contract
*does* abort and `assert!(result.is_err())` **passes**.

It is caught only because the harness asserts *which* error: it predicted `Overflow`, got
`ZeroShares`.

**Porting EVM bug taxonomies to Soroban wholesale is a mistake.**

---

## 13 · Tooling scars *(cut first)*

Two obstacles in no tutorial:

- **`crate-type = ["lib", "cdylib"]` blocks `cargo-fuzz` on macOS/arm64.** One Cargo target, two
  artifacts; the cdylib link fails under SanitizerCoverage and takes the whole build with it.
- **`cargo fuzz --features` is silently ignored** by cargo-fuzz 0.13.2. Accepted, never forwarded,
  no error.

The second one produced a **plausible wrong number** — "the AI arm missed `bug_self_transfer`" —
when the seed had never been compiled in.

Quiet, believable, and pointing the wrong way. The best argument for gates that are commands with
expected results.

---

## 14 · Limitations — stated, not buried

1. The contract was **purpose-built** around the invariant catalogue. Inflates the AI's apparent
   insight.
2. **Same model family** wrote the contract and proposed the invariants.
3. **One contract, one model, one run.** No variance estimate. 81 % and 7/7 are single observations.
4. **I4/I5 are asserted weaker than stated** — "only the incumbent authorized" is tested as "nobody
   authorized". *The model flagged this hole in its own harness.*
5. **The deployed WASM is not what gets fuzzed** — both arms link the crate directly, for coverage.

---

## 14b · The assisted arm was briefly worse than the control

The first coverage-guided AI target found **2 of 7** — and *lost* one the crude baseline caught.

Not an oracle problem. Operands came straight from the fuzzer's bytes, so it could never build
multi-call state; and every call was wrapped in `try_*` and checked only on success, so an operation
that **wrongly aborted** was tolerated.

The fix was implementing the third prompt — `prioritise-inputs` — which had been written, run,
committed verbatim in P5, and **never opened**. 2/7 → 7/7.

> A prompt that is authored, executed and committed but never integrated produces no value
> and leaves no trace of its absence.

Its generic half is now a reusable crate, `soroban-fuzzkit`.

---

## 15 · What I would do next

- **Fuzz the deployed bytecode**, not the linked crate — closes the gap between what is tested and
  what is shipped.
- **Automate the prompt loop** so findings feed back as context without a human in the transport
  path (the human stays in the *decision* path).
- **More targets, more models, repeated runs** — turn single observations into distributions.
- **Formal methods where fuzzing saturates** (Kani) — a small contract like this may simply be
  exhaustible.

---

## 15b · What makes it Soroban, not just Rust

Fuzzing the linked crate is fuzzing something that never deploys. The **WASM arm** registers the
compiled module into the `Env` — and that is not pedantry, it is load-bearing:

> "if a test contract is used instead of a Wasm contract, all the costs related to VM instantiation
> and execution, as well as **Wasm reads/rent bumps will be missed**." — the SDK

So Soroban's own oracles only exist over the deployed artifact:

| | Question it answers |
|---|---|
| **R1** resource ceilings | can this call actually be submitted on-chain? |
| **R2** rent on write | did a persistent write pay to keep its entry alive? |

**R2 is the one an auditor wants**, because it needs no knowledge of the storage layout. Reading a
TTL means knowing which key to read, which means having read the contract. The rent counter is
measured from the invocation itself.

And a negative result to inherit: `disk_read_entries` is **not** an archival detector — it also
counts classic account balances, so any contract calling a token "reads from disk" while perfectly
healthy. Written as an assertion, it failed on the clean build in 90 seconds.

---

## 16 · The one-sentence version

> AI assistance did not help by writing the harness — it got the SDK details wrong and `rustc`
> caught it in seconds.
> **It helped by knowing what to assert**, which took detection from 1 of 7 to 7 of 7 —
> and the one thing it was most confident about was the one thing that was false.

---

## Appendix · Reproduce it

```bash
git clone <repo> && cd stellar-studies
cargo test                                          # everything green on the clean contract
./04-prototype-development/scripts/demo.sh          # seeded bug → both arms → fix, ~2 min
```

| Artifact | Path |
|---|---|
| Per-seed benchmark | `04-prototype-development/results/benchmark.md` |
| Curation, with rationale per proposal | `04-prototype-development/invariants.md` |
| Raw model outputs, unedited | `04-prototype-development/prompts/raw/` |
| Integrity accounting | `04-prototype-development/results/ai-arm-provenance.md` |

# Execution & Verification Plan — Topics 4 and 5

**Written:** 2026-08-11 · **Covers:** Topic 4 (due 2026-08-31) and Topic 5 (due 2026-09-30)

The purpose of this document is to make "is the IDP finished and correct?" a question with a
mechanical answer. Every phase has an exit gate that is a **command with an expected result**, not a
judgement call. Nothing is "done" because it feels done.

Architecture being executed: [Topic 3](../03-solution-architecture/README.md).

---

## 0. Principles

1. **Every gate is executable.** If a criterion cannot be checked by running something, it is
   rewritten until it can.
2. **Commit at every gate.** One commit per phase minimum. The ChainGuard failure mode — a
   feature-complete tree with zero commits and no end-to-end run — is the specific thing being
   avoided.
3. **Ship the honest result.** A seeded bug that survives, or an AI arm that loses to the baseline,
   is a finding to report, not a failure to hide. The write-up records what happened.
4. **De-risk first.** The two highest-uncertainty items (§Phase 1) are settled before any effort is
   spent on work that depends on them.
5. **Cut scope, never cut verification.** If time runs short, the cut order in §6 applies. The
   benchmark and its gates are the last thing to go.

---

## 1. Phase plan — Topic 4 (2026-08-11 → 2026-08-31)

| Phase | Dates | Output |
|---|---|---|
| P0 — Environment | 08-11 | Toolchain verified |
| P1 — Spikes (de-risk) | 08-12 → 08-13 | Two open questions answered |
| P2 — Contract | 08-14 → 08-16 | `soroban-vault` + unit tests |
| P3 — Seeded bugs | 08-17 → 08-18 | 7 feature-gated bugs, each proven to break something |
| P4 — Baseline arm | 08-19 → 08-20 | Hand-written harness + baseline benchmark numbers |
| P5 — AI arm | 08-21 → 08-24 | P1–P3 prompts, curated invariants, generated harness |
| P6 — cargo-fuzz | 08-25 → 08-26 | Coverage-guided targets, both arms |
| P7 — Mutation testing | 08-27 | `cargo-mutants` scores |
| P8 — Benchmark & write-up | 08-28 → 08-30 | `results/benchmark.md`, Topic 4 README |
| P9 — Acceptance | 08-31 | Full acceptance checklist green |

Slack: P8 has a built-in day of margin, and 08-31 is reserved for acceptance only.

---

## 2. Phase detail and exit gates

### P0 — Environment (08-11)

Establish that the toolchain is present before anything depends on it.

```bash
rustc --version                       # stable
cargo +nightly --version              # required by cargo-fuzz
rustup target list --installed | grep wasm32v1-none
stellar --version
cargo install --locked cargo-fuzz cargo-mutants
cargo test                            # existing increment contract still green
```

**Gate P0:** all five commands succeed; `cargo test` passes on the existing workspace.
If `wasm32v1-none` or nightly is missing → `rustup target add wasm32v1-none` / `rustup toolchain
install nightly` before proceeding.

> ⚠️ **The WASM target is `wasm32v1-none`, not `wasm32-unknown-unknown`.** `soroban-sdk` 26.1 fails
> its build script on the latter: Rust 1.82+ enables `reference-types` and `multi-value` on
> `wasm32-unknown-unknown`, which the Soroban environment does not support and which cannot easily
> be disabled. This changed after the ChainGuard prototype (`soroban-sdk` 21) was written — any
> command inherited from it, or from older tutorials, needs the target swapped.

---

### P1 — Spikes (08-12 → 08-13) — **the de-risking phase**

Topic 3 §10 lists four open questions. Two of them can invalidate large amounts of downstream work,
so they are answered first, in throwaway code, before the contract is written.

**Spike A — Can TTL / state archival be exercised in `Env`?** (Topic 3 open question 2)
Invariants I10 and I11 are the Soroban-specific differentiator of this whole IDP. If the test host
cannot advance the ledger far enough to trigger archival, they cannot be fuzzed as designed.

Write a scratch test that sets a persistent entry with a short TTL, advances the ledger sequence via
`env.ledger().set_sequence_number(...)` / `env.ledger().with_mut(...)`, and asserts the entry is
gone or restorable.

- **Gate A-pass:** archival is observable in `Env` → I10/I11 are fuzzed as designed.
- **Gate A-fail:** archival is not reachable → **fall back immediately**: test the *contract's
  behaviour under a simulated-expired read* (inject the "entry missing" path directly) rather than
  real archival, and record the limitation prominently in the write-up. Do not spend more than one
  day trying to force it.

**Spike B — Does `SorobanArbitrary` produce usable `Address` values?** (Topic 3 open question 1)
Generate 100 arbitrary `Address` values and check whether auth scenarios are meaningful or whether
every generated address fails `require_auth` uniformly (which would make I4/I5 trivially satisfied
and the access-control fuzzing worthless).

- **Gate B-pass:** meaningful distribution → use `SorobanArbitrary` directly.
- **Gate B-fail:** → use a fixed pool of pre-registered addresses plus an index into it as the fuzzed
  input, so the fuzzer explores *which* principal acts rather than raw address bytes. (ChainGuard's
  `input_generator.rs` uses exactly this shape: zero / self / known-malicious.)

**Gate P1:** both questions answered in writing in `04-prototype-development/results/spikes.md`,
with the chosen path recorded. Committed.

> If Spike A fails, that alone is a publishable finding for Topic 5 — "TTL invariants are not
> directly fuzzable in the current test host" is real, useful research output.

---

### P2 — Contract (08-14 → 08-16)

Implement `soroban-vault` per Topic 3 §5.1 — clean, no seeded bugs, correct.

```bash
cargo test -p soroban-vault
cargo build -p soroban-vault --target wasm32v1-none --release
```

**Gate P2:**
- Unit tests cover the happy path of all 8 entry points.
- Each of the 12 invariants (I1–I12) has at least one *hand-written unit test* asserting it holds on
  the clean build. This is the ground truth the fuzzers are later measured against — if an invariant
  cannot be expressed as a test here, it cannot be fuzzed, and it gets revised or dropped now.
- Builds to WASM without error.
- Committed.

---

### P3 — Seeded bugs (08-17 → 08-18)

Add the 7 bugs from Topic 3 §5.3, each behind its own cargo feature.

**Gate P3 — the important one.** For each seed, prove it actually breaks the invariant it claims to:

```bash
# clean build: everything passes
cargo test -p soroban-vault

# each seed: the corresponding invariant test MUST fail
for bug in bug_overflow bug_missing_auth bug_zero_amount bug_self_transfer \
           bug_no_ttl bug_temp_nonce bug_reinit; do
  echo "=== $bug"
  cargo test -p soroban-vault --features "$bug" || echo "FAILED AS EXPECTED: $bug"
done
```

Expected: clean build green; **all 7 seeds red**, each failing the invariant test named in the
Topic 3 §5.3 table — not a different one, and not a compile error.

A seed that does not break its target invariant is a broken seed, and must be fixed before P4. A
benchmark built on seeds that do not actually represent bugs measures nothing. Record the
seed → failing-test mapping in `results/seeds.md`. Committed.

---

### P4 — Baseline arm (08-19 → 08-20)

The control group. A harness of the kind a developer writes from the Stellar docs in an hour: one
`proptest` per public function, asserting only "does not panic". **Written before any AI is
involved**, so it cannot be contaminated by knowing what the AI proposed.

```bash
cargo test -p soroban-vault --test proptest_baseline
for bug in <all 7>; do cargo test --features "$bug" --test proptest_baseline; done
```

**Gate P4:** baseline detection rate recorded per seed in `results/benchmark.md` (expected: it
catches the crashing bugs, misses the silent-accounting ones — that gap is the point). Authoring
time logged. Committed.

---

### P5 — AI arm (08-21 → 08-24)

1. Write `prompts/propose-invariants.md`, run it, commit the **raw output verbatim** before curating.
2. Curate → `invariants.md`, with an explicit accept / reject / rewrite note and rationale per
   proposal. This yields the **invariant-yield** metric.
3. Write `prompts/generate-harness.md`, run it against source + curated invariants, commit raw output.
4. Fix to compile; log every fix — "what the AI got wrong" is a core write-up finding.
5. Write `prompts/prioritise-inputs.md`, fold results into `Arbitrary` strategies.

```bash
cargo test -p soroban-vault --test proptest_ai
for bug in <all 7>; do cargo test --features "$bug" --test proptest_ai; done
```

**Gate P5:**
- All three prompts committed, with raw outputs preserved alongside curated versions.
- `invariants.md` has an accept/reject decision for every proposal, with reasons.
- AI harness compiles and passes on the clean build.
- Detection rate per seed recorded.
- Authoring time logged for comparison with P4.
- Committed.

> **Integrity rule:** the AI arm is not permitted to be tuned against the seeded bugs. Prompts see
> the contract source, never the seed list. Otherwise the benchmark is circular and worthless. If a
> prompt is revised after seeing results, that revision is recorded and the run is labelled as a
> second round.

---

### P6 — cargo-fuzz (08-25 → 08-26)

Coverage-guided targets for both arms, fixed and equal budget (proposed: 15 min per target per seed;
adjust once the first run's timing is known, then keep it constant).

```bash
cargo +nightly fuzz build
cargo +nightly fuzz run vault_baseline -- -max_total_time=900
cargo +nightly fuzz run vault_ai       -- -max_total_time=900
cargo +nightly fuzz tmin vault_ai <crash-file>   # minimise each reproducer
```

**Gate P6:**
- Both targets build and run under nightly.
- Time-to-first-crash recorded per seed per arm (or "not found within budget" — a valid result).
- Every crash minimised via `fuzz tmin` and saved to `results/crashes/`.
- **Every crash converted into a permanent regression test** in the `proptest` suite. A crash that
  is not turned into a test will be re-found forever.
- Committed.

---

### P7 — Mutation testing (08-27)

```bash
cargo mutants -p soroban-vault --timeout 120
```

**Gate P7:** mutation score recorded for the baseline suite and the AI suite separately, in
`results/mutants.md`. Surviving mutants are listed and each classified: *genuine test gap* vs.
*equivalent mutant*. If `cargo-mutants` cannot handle `#![no_std]` + `soroban-sdk` macro expansion
(Topic 3 open question 3), record that outcome and move on — it is a bounded loss, not a blocker.

---

### P8 — Benchmark & write-up (08-28 → 08-30)

Assemble `results/benchmark.md`:

| Seed | Baseline `proptest` | AI `proptest` | Baseline fuzz (TTFC) | AI fuzz (TTFC) |
|---|---|---|---|---|
| bug_overflow | | | | |
| … 7 rows … | | | | |

Plus: invariant yield (kept / proposed), mutation scores, authoring time both arms.

Then write `04-prototype-development/README.md` in the style of Topics 1–2: objective, what was
built, what was found, what the AI got right and wrong, limitations, success indicators, references.

**Gate P8:** the write-up contains at least one clearly-labelled **negative or surprising result**.
If everything worked perfectly, the benchmark was too easy and that must be said out loud.

---

### P9 — Acceptance (08-31)

Run the full checklist in §4. All green → Topic 4 done, README status updated, tagged.

---

## 3. Topic 5 (2026-09-01 → 2026-09-30)

| Phase | Dates | Output | Gate |
|---|---|---|---|
| T5-1 | 09-01 → 09-07 | Consolidated learnings across Topics 1–4 | Every claim traces to a specific artifact in the repo |
| T5-2 | 09-08 → 09-14 | Limitations & future work (incl. WASM fuzzing, automating the prompt loop, Kani) | Each open question from Topic 3 §10 has a recorded answer or an explicit "still open" |
| T5-3 | 09-15 → 09-21 | Presentation deck | Rehearsed once end-to-end against a clock |
| T5-4 | 09-22 → 09-26 | Recorded demo: seeded bug → fuzzer catches it → minimised reproducer → fix | Demo runs from a **clean clone**, no local state |
| T5-5 | 09-29 → 09-30 | Final acceptance | §5 checklist green |

The clean-clone requirement on T5-4 is deliberate: it is the check that catches "works only on my
machine", which is precisely how ChainGuard ended up unrunnable.

---

## 4. Topic 4 acceptance checklist

Run on 08-31. Every line is a command or an inspectable artifact.

**Builds and tests**
- [ ] `cargo test` — whole workspace green on the clean build
- [ ] `cargo build --target wasm32v1-none --release` succeeds
- [ ] `cargo +nightly fuzz build` succeeds
- [ ] Clean clone into a fresh directory → `cargo test` passes with no manual setup

**Seeded-bug benchmark**
- [ ] All 7 seeds compile
- [ ] Each seed fails the invariant test it targets (per `results/seeds.md`)
- [ ] Detection rate recorded per seed for both arms
- [ ] Every seed either detected by ≥1 layer, **or** its survival explained in writing

**AI workflow**
- [ ] 3 prompts committed
- [ ] Raw AI outputs committed *unedited*, alongside curated versions
- [ ] `invariants.md` has accept/reject/rewrite + rationale for every proposal
- [ ] Invariant yield computed

**Quality gates**
- [ ] `cargo mutants` run; scores recorded for both suites; survivors classified
- [ ] Every fuzz crash minimised and converted to a regression test

**Documentation**
- [ ] `results/spikes.md`, `results/seeds.md`, `results/benchmark.md`, `results/mutants.md` all present
- [ ] `04-prototype-development/README.md` complete, with success indicators
- [ ] At least one negative/surprising result documented
- [ ] Root README status table updated
- [ ] All work committed; no uncommitted tree

---

## 5. Final IDP acceptance checklist

Run on 09-30.

- [ ] Topics 1–5 all marked ✅ with real deliverables linked
- [ ] Every Topic 3 open question (§10) answered or explicitly marked still-open with reasoning
- [ ] Demo runs end-to-end from a clean clone
- [ ] Deck + recording linked from `05-consolidation-and-presentation/README.md`
- [ ] Limitations section is honest and specific — no unfalsifiable claims of success
- [ ] Repository is self-contained: someone else can clone it and reproduce the benchmark from the
      README alone

---

## 6. Contingency

If the plan slips, cut in this order — **top of the list goes first**:

1. `cargo-mutants` (P7) — nice-to-have quality signal; the benchmark stands without it.
2. `cargo-fuzz` depth (P6) — reduce budget, or drop to `proptest` only, and say so.
3. Seed count — drop from 7 to 4, keeping `bug_overflow`, `bug_missing_auth`, `bug_no_ttl`,
   `bug_temp_nonce` (the two Soroban-specific ones are never cut; they are the differentiator).
4. Invariants — drop I2, I12 first; never I10, I11.

**Never cut:** the two-arm comparison, the seeded-bug gate (P3), or the acceptance checklist.
A prototype with 4 seeds and an honest benchmark is a successful IDP. A prototype with 7 seeds and
no verifiable comparison is not.

**Escalation triggers** — if any of these occur, re-plan rather than push:

| Trigger | Action |
|---|---|
| Spike A and B both fail (08-13) | Reduce to non-TTL invariants; rewrite Topic 3 §5.2 scope; notify stakeholders same day |
| P2 not done by 08-17 | Cut seeds to 4 immediately |
| AI harness will not compile after 1 day of fixes (P5) | Ship it as a finding — "AI-generated harness required N manual fixes to compile" is a legitimate, informative result |
| Any phase 2+ days late | Apply the cut order above; do not absorb the slip into P8 |

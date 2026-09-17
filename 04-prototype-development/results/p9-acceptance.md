# P9 — Topic 4 acceptance

**Run:** 2026-09-17 · **Checklist:** [execution-plan.md §4](../../docs/execution-plan.md) ·
**Verdict:** ✅ passed, with two recorded deviations

Every line below is a command that was actually run, with its result. Nothing is marked done because
it felt done.

---

## Builds and tests

| Check | Command | Result |
|---|---|---|
| Whole workspace green on the clean build | `cargo test` | ✅ **10 suites ok, 0 failed** — 85 tests |
| WASM builds | `cargo rustc -p soroban-vault --target wasm32v1-none --release --crate-type cdylib` | ✅ `soroban_vault.wasm`, 8 508 bytes |
| Fuzz targets build under nightly | `cargo +nightly fuzz build --fuzz-dir … --sanitizer none <target>` | ✅ both |
| Clean clone → `cargo test` with no manual setup | `git clone … && cargo test` | ✅ all green |
| Clean clone → demo runs | `./04-prototype-development/scripts/demo.sh` | ✅ end to end |

> **Deviation 1 — the build commands changed.** The plan says
> `cargo build --target wasm32v1-none --release` and `cargo +nightly fuzz build`. Both needed
> amending: `crate-type` is now `lib` only, so the `.wasm` is produced with `cargo rustc
> --crate-type cdylib`, and the fuzz layer needs `--sanitizer none`. Reasons in
> [`p6-fuzzing.md`](p6-fuzzing.md) §6.1 — a cdylib emitted alongside the rlib fails to link under
> SanitizerCoverage on macOS/arm64 and takes the whole fuzz build with it.

**The clean-clone gate earned its place.** `cargo test` passed from a fresh clone, and
`scripts/demo.sh` came back *permission denied* — the executable bit had never been recorded in the
git index. The Topic 5 demo ran only on the author's machine. That is precisely the failure the
requirement was written to catch, and it would not have been caught any other way.

## Seeded-bug benchmark

| Check | Result |
|---|---|
| All 7 seeds compile | ✅ 0 errors each |
| Each seed fails the invariant test it targets | ✅ 7/7, per [`seeds.md`](seeds.md) |
| Detection rate recorded per seed, both arms | ✅ [`benchmark.md`](benchmark.md) §1 |
| Every seed detected by ≥1 layer, or its survival explained | ✅ every seed detected by ≥2 layers |

`proptest`: baseline **1/7**, AI **7/7**. Coverage-guided: baseline **1/7**, AI **2/7** without the
input prior and **7/7** with it. Clean-contract controls pass in every arm — 470 749 and 145 564
fuzz executions with no crash — which is what makes the detections attributable rather than merely
red.

## AI workflow

| Check | Result |
|---|---|
| 3 prompts committed | ✅ [`prompts/`](../prompts/) |
| Raw AI outputs committed unedited, alongside curated versions | ✅ [`prompts/raw/`](../prompts/raw/) — 3 files, verbatim |
| `invariants.md` has accept/reject/rewrite + rationale for every proposal | ✅ all 16 |
| Invariant yield computed | ✅ **13/16 = 81 %** |

Integrity enforcement, and the three contamination channels it does **not** close:
[`ai-arm-provenance.md`](ai-arm-provenance.md).

## Quality gates

| Check | Result |
|---|---|
| `cargo mutants` run, scores recorded per suite | ✅ unit 95 %, baseline 34 %, AI 98 % (adjusted) |
| Survivors classified | ✅ every one — genuine gap / equivalent / unreachable / unviable |
| Every fuzz crash minimised | ✅ `fuzz tmin`, saved to [`crashes/`](crashes/) |
| Every fuzz crash converted to a permanent regression test | ⚠️ **deviation 2** |

> **Deviation 2 — crashes were not converted into `proptest` regression tests.** Each seed's crash is
> already covered twice: by a hand-written invariant test and by a property in the AI arm. A
> converted reproducer would be a third copy of the same assertion, and the plan's rationale for the
> rule ("a crash that is not turned into a test will be re-found forever") does not apply to a crash
> whose cause is a cargo feature that is off by default.
>
> The one crash that was **not** a seed — the clean-contract aliasing case in
> [`p6-fuzzing.md`](p6-fuzzing.md) §4 — *is* regression-tested, in
> `soroban-fuzzkit::pool::tests::index_caller_only_returns_slots_that_can_actually_sign`, because its
> cause is in the harness rather than the contract. Recorded as a deliberate deviation rather than
> silently skipped.

## Documentation

| Check | Result |
|---|---|
| `spikes.md`, `seeds.md`, `benchmark.md`, `mutants.md` all present | ✅ plus `p0-environment.md`, `p5-ai-arm.md`, `p6-fuzzing.md`, `ai-arm-provenance.md`, this file |
| Topic 4 README complete, with success indicators | ✅ [`../README.md`](../README.md) |
| At least one negative/surprising result documented | ✅ **four** — README §7 |
| Root README status table updated | ✅ |
| All work committed; no uncommitted tree | ✅ `git status --porcelain` → 0 lines |

---

## The gates that actually fired

Worth recording, because a checklist whose every line passes on the first attempt is a checklist
that was not testing anything. Six measurement errors were caught during Topics 4–5, five of them by
a gate specified in advance:

| Error | Caught by | Would have claimed |
|---|---|---|
| `cargo fuzz --features` silently dropped by the tool | The fuzz result contradicting the `proptest` result | "the AI arm missed `bug_self_transfer`" |
| Round-2 fuzz target crashing on the **clean** contract | The clean-contract control | 8/8 detections, none attributable |
| An assertion naming the wrong property for two seeds | Reading failure text already marked green | `bug_overflow` attributed to a hypothesis refuted in P5 |
| The exact-payout oracle skipping on its own overflow | Tracing which assertion caught `bug_overflow` | a missed detection presented as a passing skip |
| Curation ledger accounting for 15 of 16 proposals | The same trace | yield 75 % instead of 81 % |
| `demo.sh` not executable in git | The clean-clone gate | a demo that ran only on one machine |

The third one is the process gap worth carrying forward: **nothing in the plan required reading the
text of an assertion that had already gone green.** Every other error had a gate waiting for it.

---

## Verdict

**Gate P9 passed.** Topic 4 is complete, 17 days past its 2026-08-31 due date. The slip is recorded
in [`../README.md`](../README.md) §9 along with the fact that the plan's own escalation rule — *any
phase 2+ days late, apply the cut order* — was not applied when it should have been. Nothing was
cut, so the deliverable is whole; the rule was still ignored.

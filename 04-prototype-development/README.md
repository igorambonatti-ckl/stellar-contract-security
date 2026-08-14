# Topic 4 — Prototype Development

**Status:** 🚧 In progress · **Due:** 2026-08-31

## Objective

Build a working prototype that demonstrates AI-assisted fuzzing applied to a Soroban contract, and
**measure** whether the AI assistance actually helps.

## Design

Specified in full in [Topic 3 — Solution Architecture](../03-solution-architecture/README.md):
target contract (`soroban-vault`), 12 invariants, 7 seeded bugs, two-arm benchmark
(hand-written baseline vs. AI-assisted), tooling decisions and rationale.

## Execution

Day-by-day phases, exit gates, and the acceptance checklist:
**[`docs/execution-plan.md`](../docs/execution-plan.md)**.

| Phase | Dates | Status |
|---|---|---|
| P0 — Environment | 08-11 | ✅ [results](results/p0-environment.md) |
| P1 — Spikes (TTL in `Env`, `SorobanArbitrary` addresses) | 08-11 (early) | ✅ [results](results/spikes.md) — 11/11 tests |
| P2 — `soroban-vault` contract | 08-14 | ✅ 22/22 tests, WASM builds |
| P3 — Seeded bugs | 08-14 | ✅ [results](results/seeds.md) — 7/7 seeds verified |
| P4 — Baseline arm | 08-19 → 08-20 | ⬜ |
| P5 — AI arm | 08-21 → 08-24 | ⬜ |
| P6 — `cargo-fuzz` | 08-25 → 08-26 | ⬜ |
| P7 — `cargo-mutants` | 08-27 | ⬜ |
| P8 — Benchmark & write-up | 08-28 → 08-30 | ⬜ |
| P9 — Acceptance | 08-31 | ⬜ |

## Results

> To be filled in as phases complete. Raw artifacts land in `results/`:
> `spikes.md`, `seeds.md`, `benchmark.md`, `mutants.md`, `crashes/`.

## To be developed

- [ ] Implement the `soroban-vault` contract with feature-gated seeded bugs.
- [ ] Set up the fuzzing stack (`cargo-fuzz` + `libfuzzer-sys`, `proptest` / `SorobanArbitrary`).
- [ ] Use AI to generate fuzzing harnesses and candidate invariants (prompts in `prompts/`).
- [ ] Run coverage-guided fuzzing and property tests; capture findings.
- [ ] Apply `cargo-mutants` to measure test quality.
- [ ] Document bugs found / invariants validated, and where AI assistance helped or failed.

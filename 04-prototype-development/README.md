# Topic 4 — Prototype Development

**Status:** ⬜ Not started · **Due:** 2026-08-31

> ⚠️ **Draft.** This document is a skeleton to be filled in once the topic begins.

## Objective

Build a working prototype that demonstrates AI-assisted fuzzing applied to a Soroban contract.

## To be developed

- [ ] Implement the target Soroban contract.
- [ ] Set up the fuzzing stack (`cargo-fuzz` + `libfuzzer-sys`, `proptest` / `SorobanArbitrary`).
- [ ] Use AI to generate fuzzing harnesses and candidate invariants.
- [ ] Run coverage-guided fuzzing and property tests; capture findings.
- [ ] Apply `cargo-mutants` to measure test quality.
- [ ] Document bugs found / invariants validated and how AI assistance helped.

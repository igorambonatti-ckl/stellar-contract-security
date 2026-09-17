# stellar-studies

Central repository documenting the progress of my IDP (Individual Development Plan):

> **Developing Smart Contract Skills on Stellar with a Focus on Security and AI-Assisted Fuzzing**

## Overall objective

Build solid, hands-on skills in smart-contract development on **Stellar / Soroban**, with a
particular focus on **security** and **AI-assisted fuzzing** — generating fuzzing harnesses,
proposing invariants/properties, and prioritizing inputs with the help of AI tooling.

## End-of-Q3 goal (by 2026-09-30)

Move from fundamentals (Stellar/Soroban + security & fuzzing concepts) through a designed solution
architecture and a working prototype, ending with a consolidated write-up and presentation that
demonstrates AI-assisted fuzzing applied to a Soroban contract.

## Progress

| # | Topic | Status | Due | Deliverable |
|---|-------|--------|-----|-------------|
| 1 | Stellar & Soroban Fundamentals | ✅ Done | 2026-05-31 | [Doc](01-stellar-fundamentals/README.md) + increment contract |
| 2 | Security & Fuzzing Fundamentals | ✅ Done | 2026-06-30 | [Doc](02-security-and-fuzzing/README.md) |
| 3 | Solution Architecture | ✅ Done | 2026-07-31 | [Doc](03-solution-architecture/README.md) |
| 4 | Prototype Development | ✅ Done | 2026-08-31 | [Doc](04-prototype-development/README.md) + [benchmark](04-prototype-development/results/benchmark.md) |
| 5 | Consolidation & Presentation | ✅ Done | 2026-09-30 | [Doc](05-consolidation-and-presentation/README.md) + [deck](docs/deck.md) |

## The result

Two fuzzing arms over the same Soroban contract and the same 7 seeded bugs, differing **only** in
the oracle:

| Arm | Oracle | Seeded bugs detected |
|---|---|---|
| Baseline — a harness written from the Stellar docs in an hour | "the call does not abort" | **1 / 7** |
| AI-assisted — invariants proposed by Claude Opus 5, curated by hand | reads state back and compares it against an independent computation | **7 / 7** |

See it for yourself in about two minutes:

```bash
./04-prototype-development/scripts/demo.sh
```

Supporting documents:

- **[Presentation deck](docs/deck.md)** — the 20-minute version.
- **[Execution & verification plan](docs/execution-plan.md)** — day-by-day plan for Topics 4–5,
  with a verification gate per phase and a final acceptance checklist.
- **[Prior art — ChainGuard AI](docs/prior-art-chainguard.md)** — inventory of an earlier personal
  prototype whose findings ground the Topic 3 architecture.

## Repository layout

```
stellar-studies/
├── 01-stellar-fundamentals/        # Topic 1 doc + increment contract
├── 02-security-and-fuzzing/        # Topic 2 doc
├── 03-solution-architecture/       # Topic 3 (draft)
├── 04-prototype-development/       # Topic 4 (draft)
├── 05-consolidation-and-presentation/  # Topic 5 (draft)
├── docs/                           # Diagrams, screenshots, video links
└── Cargo.toml                      # Rust workspace
```

## Build & test

```bash
cargo test                       # whole workspace, clean contract — everything green
cargo build                      # build the workspace

# the WASM artifact. `cargo rustc --crate-type cdylib` rather than `cargo build`,
# because carrying "cdylib" in [lib] crate-type permanently breaks the cargo-fuzz
# build on macOS/arm64 — see 04-prototype-development/results/p6-fuzzing.md
cargo rustc -p soroban-vault --target wasm32v1-none --release --crate-type cdylib
```

Prototype-specific (Topic 4):

```bash
cd 04-prototype-development

cargo test -p soroban-vault --test proptest_baseline   # control arm
cargo test -p soroban-vault --test proptest_ai         # AI arm
cargo test -p soroban-vault --features bug_self_transfer   # with a seeded bug

scripts/demo.sh                  # end-to-end: bug → both arms → minimised repro → fix
scripts/p6-fuzz-matrix.sh 300    # the coverage-guided matrix (~80 min)
```

Requires stable Rust, the `wasm32v1-none` target, and — for the `cargo-fuzz` layer only —
a nightly toolchain plus `cargo install --locked cargo-fuzz cargo-mutants`.

## References

- Official Stellar developer documentation: https://developers.stellar.org

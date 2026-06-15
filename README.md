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
| 3 | Solution Architecture | 🚧 In progress | 2026-07-31 | — |
| 4 | Prototype Development | ⬜ Not started | 2026-08-31 | — |
| 5 | Consolidation & Presentation | ⬜ Not started | 2026-09-30 | — |

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
cargo test          # run all contract unit tests
cargo build         # build the workspace
```

## References

- Official Stellar developer documentation: https://developers.stellar.org

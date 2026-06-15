# Topic 2 — Security & Fuzzing Fundamentals

**Status:** ✅ Done · **Due:** 2026-06-30

## 1. Objective

Study **fuzzing** and **automated testing** and identify how to apply them to smart contracts.
The path is to start from the mature **Ethereum / Solidity** ecosystem (where these techniques are
well established) and then **adapt the concepts to Stellar / Soroban**, which is the
differentiating focus of this IDP.

## 2. What fuzzing and automated testing are

**Fuzzing** is the technique of automatically generating many inputs — random or
instrumentation-guided — and feeding them to a program to find inputs that:

- **violate invariants** (properties that must always hold),
- **cause panics / crashes**, or
- **cause reverts** (in the EVM sense) / unexpected aborts.

Key distinctions:

- **Coverage-guided (instrumented) vs black-box fuzzing.**
  - *Coverage-guided* fuzzers instrument the binary to observe which code paths each input
    reaches, then mutate inputs to **maximize coverage** (e.g. libFuzzer, AFL, Echidna). They
    find deep bugs faster.
  - *Black-box* fuzzers generate inputs without visibility into internal coverage — simpler but
    less efficient at reaching rare branches.
- **Property-based testing.** Instead of example-by-example assertions, you state a **property /
  invariant** (e.g. "balances never exceed total supply") and the framework generates many inputs
  trying to falsify it, shrinking any failing case to a minimal reproducer.
- **Stateless vs stateful fuzzing.**
  - *Stateless* fuzzing tests a single call with generated arguments.
  - *Stateful* fuzzing generates **sequences of operations** that **carry state** between calls,
    exploring how the contract behaves across realistic multi-step interactions (the regime where
    most real vulnerabilities live).

## 3. Tools in the Ethereum ecosystem (Solidity / EVM)

- **Echidna (Trail of Bits)** — a **property-based, coverage-guided fuzzer** for Solidity
  contracts. The developer writes properties / invariants as boolean functions, and Echidna
  generates transaction sequences trying to **break** them.
- **Foundry (`forge`)** — the Solidity test framework with built-in:
  - **fuzz tests** — test functions take parameters that `forge` fills with random values;
  - **invariant testing** — **stateful** fuzzing that fires random sequences of calls against the
    system and checks invariants after each.
- **Typical invariants** targeted by these tools:
  - **supply conservation** (token accounting always balances),
  - **access control** (only authorized roles can perform privileged actions),
  - **absence of overflow** in arithmetic.

## 4. Application to Ethereum contracts — examples of testable invariants

- **Supply conservation:** `sum(balances) == totalSupply` at all times.
- **Access control:** only `admin` can call `mint`; any other caller must revert.
- **No overflow:** arithmetic operations (transfers, mints, fee math) never overflow or
  underflow.

These are expressed as properties (Echidna) or invariant functions (`forge`) and the fuzzer tries
to find a transaction sequence that violates them.

## 5. Adapting to Stellar / Soroban — the IDP's differentiator

Soroban contracts are **Rust**, not Solidity/EVM, so **Echidna and Foundry do not apply** — they
are EVM-specific. Instead, Soroban uses the **Rust fuzzing stack**, and crucially these tests run
**inside the real Soroban host environment** (`Env`), so they exercise genuine contract behavior,
storage, and auth.

The Soroban-appropriate toolbox:

- **`cargo-fuzz`** (with **`libfuzzer-sys`**) — coverage-guided fuzzing. Requires the **nightly**
  toolchain. Best for deep, long-running bug hunting.
- **`proptest`** + **`proptest-arbitrary-interop`** and the **`SorobanArbitrary`** trait —
  property-based testing that runs under plain **`cargo test`** with **no extra tooling**. It is a
  **lighter form** than full fuzzing and is excellent as a guard against **regressions**.
- **`arbitrary`** crate — generates **structured inputs** (typed values, not just raw bytes) so
  the fuzzer produces valid contract argument shapes.
- **`cargo-mutants`** — **mutation testing**: it mutates the contract source and checks whether
  the test suite catches the change, **measuring test quality** (do the tests actually detect
  bugs?).
- **Official example:** the **`soroban-examples`** repo includes a **`fuzzing`** folder, built on
  the **timelock** example, showing a real Soroban fuzz target.

### Illustrative Rust fuzz target

```rust
#![no_main]
use libfuzzer_sys::fuzz_target;
use soroban_sdk::Env;

fuzz_target!(|input: u32| {
    let env = Env::default();
    let id = env.register(IncrementContract, ());
    let client = IncrementContractClient::new(&env, &id);
    // invariant: increment must never panic and always returns >= 1
    let result = client.increment();
    assert!(result >= 1);
});
```

The harness boots a real Soroban host, registers the contract, and asserts an invariant
(`increment` never panics and always returns `>= 1`). A coverage-guided fuzzer mutates `input` to
explore execution paths trying to violate that assertion.

## 6. Success indicators met

- ✅ Clear technical explanation of fuzzing / automated testing concepts (coverage-guided vs
  black-box, property-based, stateless vs stateful).
- ✅ Survey of the established Ethereum tooling (Echidna, Foundry) and the invariants they target.
- ✅ **Stellar adaptations identified**: `cargo-fuzz`, `proptest` / `SorobanArbitrary`,
  `arbitrary`, and `cargo-mutants`, plus the official `soroban-examples` fuzzing reference.

## 7. Connection to the IDP title — "AI-Assisted Fuzzing"

The IDP's differentiator is using **AI to assist the fuzzing workflow**:

- **Generate fuzzing harnesses** — have AI scaffold `cargo-fuzz` / `proptest` targets from a
  contract's interface, reducing the boilerplate of wiring up `Env`, clients, and `arbitrary`
  inputs.
- **Propose invariants / properties** — AI can read a contract and suggest candidate invariants
  (supply conservation, access control, TTL/state assumptions) that a human then curates.
- **Prioritize inputs** — AI can help focus the fuzzer on the most suspicious argument shapes and
  operation sequences, improving the odds of hitting deep bugs sooner.

This is the **bridge to Topic 3 (Solution Architecture)** and **Topic 4 (Prototype)**, where these
AI-assisted techniques will be designed into a concrete tool/workflow and demonstrated on a real
Soroban contract.

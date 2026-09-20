# The WASM arm — fuzzing the artifact that ships

**Run:** 2026-09-19 · **Target:** [`fuzz/fuzz_targets/vault_wasm.rs`](../fuzz/fuzz_targets/vault_wasm.rs)
· **Raw data:** [`p6-wasm.tsv`](p6-wasm.tsv)

```bash
P6_ARMS=vault_wasm P6_OUT=results/p6-wasm.tsv scripts/p6-fuzz-matrix.sh 300
```

---

## 1. Why this arm had to exist

The baseline and AI arms both link the contract crate natively. Convenient, and it quietly disables
the entire Soroban-specific half of the problem. The SDK says so directly, in the documentation of
the very API those oracles depend on:

> "if a test contract is used instead of a Wasm contract, all the costs related to VM instantiation
> and execution, as well as **Wasm reads/rent bumps will be missed**."

So an invocation's metered footprint — instructions, memory, rent bumps — is only meaningful over
the deployed module. Every resource oracle written against a natively-linked contract is *vacuous*:
it reads zeros and passes.

This also closes limitation **L7**, which Topic 5 had listed as the largest one, and returns the
project to the substrate the prior art had already concluded was correct — ChainGuard's
`soroban-fuzzer` loaded WASM bytecode into an `Env` for exactly this reason.

### How the module gets there

[`fuzz/build.rs`](../fuzz/build.rs) compiles the contract to `wasm32v1-none` at fuzz-build time and
hands the path to the target via `include_bytes!`. It forwards the seed features by reading
`CARGO_FEATURE_*`, so the `.wasm` carries exactly the seed the fuzz binary was built with —
otherwise the arm would fuzz a clean module while reporting on a seeded one, which is the same class
of silent mismatch `cargo fuzz --features` already produced once in this project.

Two build-environment details cost real time and are worth inheriting:

- **`RUSTUP_TOOLCHAIN` leaks in.** `cargo-fuzz` runs under nightly and exports it, so the build
  script inherits nightly, where `wasm32v1-none` is usually not installed. The failure is
  `can't find crate for 'core'` — a message that points at the target rather than at the toolchain.
- **`RUSTFLAGS` leaks in.** The SanitizerCoverage flags must be stripped before the wasm build.

---

## 2. The Soroban-native oracles — one survived

| | Property | Status |
|---|---|---|
| **R1** | every invocation stays inside the per-transaction resource ceilings | ✅ asserted |
| ~~R2~~ | ~~a persistent write must bump rent~~ | ❌ **withdrawn** — §3.2 |
| ~~R3~~ | ~~no archived entry was restored~~ | ❌ **withdrawn** — §3.1 |

**R1 holds and is worth having.** A call that passes every test and still exceeds the network's
per-transaction limit cannot be submitted: the contract is correct and the function is dead. No
application-logic oracle can see that, and it is only measurable over the deployed module.

R2 and R3 were both written, both looked sound, and both failed. Together they are the answer to
Topic 3 open question 5, and the answer is **no**.

---

## 3. Open question 5, answered: the resource counters are not TTL oracles

> *Does `cost_estimate()` make a better TTL oracle than reading storage? The SDK exposes
> `write_entries` and `persistent_entry_rent_bumps`, which jump when a restoration occurs.*

The appeal was real: reading an entry's TTL requires knowing **which storage key to read**, which
requires having read the contract. A counter-based oracle would need neither — it would apply to a
contract an auditor has not read. Two candidates, both refuted by measurement.

### 3.1 `disk_read_entries` conflates restoration with ordinary reads

The reasoning: live Soroban state is held in memory, so a disk read means the host had to bring an
archived entry back. Written as an assertion, it **failed on the clean contract within 90 seconds**.

The SDK's own field documentation says the counter includes

> "the total number of restored Soroban ledger entries **and non-Soroban entries (such as 'classic'
> account balances)**".

Any contract that calls a Stellar Asset Contract reads from "disk" during a perfectly healthy
invocation.

### 3.2 `persistent_entry_rent_bumps` measures the host, not the contract

This one survived longer because it was *vacuous* rather than wrong — the first formulation accepted
a **temporary**-tier bump as proof that a persistent write had paid rent, so it never fired.
Tightening it looked like the obvious fix. Measurement says otherwise.

[`tools/footprint.rs`](../fuzz/tools/footprint.rs) prints the metered footprint of each operation
against the deployed WASM. On the **clean** contract:

```
deposit (1st)      write_entries 6   persist_bumps 2
deposit (repeat)   write_entries 6   persist_bumps 0     <- correct contract, no rent paid
withdraw           write_entries 6   persist_bumps 0     <- correct contract, no rent paid
set_admin          write_entries 2   persist_bumps 0
```

So the tightened predicate — *a write must bump rent* — is a **false positive on the correct
contract**. That is `extend_ttl` behaving exactly as documented: a no-op while the remaining TTL is
still above the threshold, which was established back in the P1 spikes and not applied here.

The obvious next move is a differential: let the TTL decay below the threshold, then write. On the
clean contract the counter does move:

```
deposit (decayed)  write_entries 7   persist_bumps 6
```

And under `bug_no_ttl`, which removes every `extend_ttl` call in the contract:

```
deposit (decayed)  write_entries 8   persist_bumps 6     <- identical
```

**The seeded contract pays the same rent as the correct one.** The host bumps rent when it writes an
entry that would otherwise be archived, whether or not the contract asked it to. The counter
measures the host's mandatory behaviour, and the contract's own `extend_ttl` is invisible inside it.

### 3.3 What this means for auditing

**There is no contract-agnostic TTL oracle in the resource counters.** Detecting a missing
`extend_ttl` requires reading the entry's TTL directly — `get_ttl` inside `env.as_contract` — which
requires knowing the storage key, which requires having read the contract.

That is a real constraint and not a small one: the TTL bug class, among the most Soroban-specific
hazards there is, **cannot be checked black-box**. The two invariants that do catch it here (I10' and
N1) both name a storage key.

> The shape of the mistake, which recurred three times in this project: **a counter that correlates
> with a property is not the property.** Each time the predicate was written from what the counter
> was expected to do rather than from what it was measured doing, and each time the measurement was
> a ten-minute job that got skipped.

---

## 4. The stall that read as a null result

The first matrix run reported **0 of 7** and had to be thrown away. The execution counts are what
gave it away: 658–1 778 runs per seeded cell against 96 259 on the clean build — two executions per
second, where the clean build managed three hundred.

libFuzzer consults `-max_total_time` **between** runs. A single unit took **997 seconds**, so the
budget was never checked and each cell effectively executed one pathological input and a handful of
others. The arm had barely run; it had not "detected nothing".

The cause is real and is itself a finding. Under `bug_no_ttl` nothing extends any TTL, entries are
created at the pinned floor of 16 ledgers, and the generator advances the ledger by up to ~1 000 000
— so every subsequent access forces the host to restore an archived entry, and the cost explodes.

**Fixed by making it a detection rather than a stall.** `-timeout=20` per unit turns a pathological
input into a reported crash, which is also the correct semantics: an invocation that slow is an
invocation that cannot be submitted on-chain, which is precisely what R1 is about.

> Generalisable: **a fuzzing cell that reports far fewer executions than its peers has not produced
> a result, whatever its verdict column says.** Throughput belongs in the matrix next to the verdict,
> and this project now records it because that is the only reason the stall was caught.

---

## 5. Verdict

*(filled in below once the matrix completes)*

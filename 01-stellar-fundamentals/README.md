# Topic 1 — Stellar & Soroban Fundamentals

**Status:** ✅ Done · **Due:** 2026-05-31

## 1. Objective

Understand the foundations of the Stellar network and the Soroban smart-contract platform: how
the network reaches consensus, how state is organized, and how contracts are written, stored,
deployed, and tested. Produce a minimal working contract (`increment`) as proof of the
fundamentals.

## 2. Stellar architecture

Stellar is an open, decentralized network for moving value and, since Protocol 20, for running
smart contracts.

### Consensus — SCP (Stellar Consensus Protocol)

- Stellar uses the **Stellar Consensus Protocol (SCP)**, an implementation of **Federated
  Byzantine Agreement (FBA)**.
- There is **no Proof of Work and no Proof of Stake** — nodes do not mine and do not stake.
  Instead, each node chooses the other nodes it trusts (its *quorum slices*), and agreement
  emerges from the overlap of these trust decisions across the network.
- Consensus is fast: ledgers close roughly every **~5 seconds**, giving near-instant
  ("**~5s finality**") settlement, and energy consumption is negligible compared to PoW chains.

### The ledger

- The **ledger** is the global state of the network: all accounts, balances, trustlines, offers,
  contract data, and so on.
- Each round of consensus produces a new **ledger entry set** (a "ledger close"). The chain of
  ledgers forms the network's history.

### Accounts

- An **account** is identified by a **public key that starts with `G`** (e.g.
  `GABC...`). The corresponding secret key starts with `S`.
- Accounts hold balances, can establish trustlines to assets, and pay small fees (in XLM) to
  submit transactions.

### Assets

- The **native asset** is **XLM (Lumens)** — used to pay fees and meet minimum balances.
- **Issued assets** are created by any account and represent arbitrary value, e.g. **USDC**
  issued on Stellar. An issued asset is identified by its code plus its issuer account.

### Operations & transactions

- A **transaction** is a signed bundle of one or more **operations** (payments, asset issuance,
  offers, etc.).
- Smart contracts are invoked through a dedicated operation: **`InvokeHostFunctionOp`**, which
  calls a host function such as invoking a contract, uploading WASM, or creating a contract
  instance.

### Network access

- **Horizon** — the traditional REST API for classic Stellar data (accounts, payments, history).
- **Soroban RPC** — the JSON-RPC endpoint used to interact with smart contracts: simulate
  transactions, submit invocations, and read contract state.

### Smart contracts on Stellar

- Smart contracts landed in **Protocol 20**, which reached **mainnet on 2024-02-20**.
- This is what makes Stellar programmable beyond its classic payment operations.

## 3. Soroban

- **Soroban is NOT a new blockchain.** It is the **smart-contract platform integrated into
  Stellar** — contracts run inside the same Stellar network and ledger.
- Contracts are written in **Rust** and compiled to **WebAssembly (WASM)**, which is what gets
  deployed and executed by the Soroban host.
- Contracts use a **Rust subset**: they are `#![no_std]` (no standard library — the on-chain
  environment has no OS, filesystem, or threads) and rely on the **`soroban-sdk`** crate for
  types, storage, and host interaction.

### The 3 storage tiers

Soroban contract state is split into three tiers, each with different lifetime and cost
characteristics:

| Tier | Lifetime | Typical use |
|------|----------|-------------|
| **Temporary** | Cheapest; can expire and is **not** restorable once gone | Short-lived data (e.g. nonces, one-time auth, ephemeral state) |
| **Persistent** | Long-lived; survives across invocations; can be archived and **restored** | Core user/business data (balances, allowances) |
| **Instance** | Tied to the contract instance itself; shares the instance's TTL | Small global config and admin data co-located with the contract |

### State archival / state bloat

- To avoid unbounded growth of the ledger (**state bloat**), Soroban uses **state archival**:
  every persistent/instance entry has a **TTL (time-to-live)** measured in ledgers.
- When an entry's TTL runs out it is **archived** (no longer in the live state). Persistent and
  instance entries can be **restored** by paying a rent fee and extending their TTL; temporary
  entries simply disappear.
- Contracts proactively keep important data alive by calling `extend_ttl(...)`, which bumps the
  entry's TTL so it is not archived while still in use.

## 4. The `increment` contract — line by line

Source: [`contracts/increment/src/lib.rs`](contracts/increment/src/lib.rs)

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

const COUNTER: Symbol = symbol_short!("COUNTER");

#[contract]
pub struct IncrementContract;

#[contractimpl]
impl IncrementContract {
    /// Increments the internal counter and returns the new value.
    pub fn increment(env: Env) -> u32 {
        let mut count: u32 = env.storage().instance().get(&COUNTER).unwrap_or(0);
        count += 1;
        env.storage().instance().set(&COUNTER, &count);
        env.storage().instance().extend_ttl(50, 100);
        count
    }
}

mod test;
```

- `#![no_std]` — opt out of the Rust standard library; the contract runs in the constrained
  on-chain WASM environment.
- `use soroban_sdk::{...}` — import the SDK building blocks used below.
- `const COUNTER: Symbol = symbol_short!("COUNTER");` — a compile-time **storage key**.
  `symbol_short!` builds a `Symbol` (≤ 9 chars) cheaply, with no heap allocation.
- `#[contract]` on `pub struct IncrementContract;` — marks this type as the contract's entry
  point.
- `#[contractimpl]` — generates the host bindings **and** a typed client
  (`IncrementContractClient`) used in tests and by callers.
- `pub fn increment(env: Env) -> u32` — a public contract function. `Env` is the handle to the
  Soroban host (storage, events, ledger info, etc.).
- `let mut count: u32 = env.storage().instance().get(&COUNTER).unwrap_or(0);` — read the current
  counter from **instance** storage, defaulting to `0` the first time (`unwrap_or(0)`).
- `count += 1;` — increment the value in memory.
- `env.storage().instance().set(&COUNTER, &count);` — write the new value back to instance
  storage.
- `env.storage().instance().extend_ttl(50, 100);` — keep the instance entry alive: if its
  remaining TTL drops below **50** ledgers, extend it to **100** ledgers (guards against state
  archival).
- `count` — return the new value.
- `mod test;` — pulls in the unit tests from `test.rs`.

### Tests

Source: [`contracts/increment/src/test.rs`](contracts/increment/src/test.rs)

```rust
#![cfg(test)]
use super::*;
use soroban_sdk::Env;

#[test]
fn test_increment() {
    let env = Env::default();
    let contract_id = env.register(IncrementContract, ());
    let client = IncrementContractClient::new(&env, &contract_id);
    assert_eq!(client.increment(), 1);
    assert_eq!(client.increment(), 2);
    assert_eq!(client.increment(), 3);
}
```

- `Env::default()` spins up an **in-memory Soroban host** for testing.
- `env.register(IncrementContract, ())` deploys the contract into that host and returns its id.
- `IncrementContractClient::new(...)` is the generated typed client.
- The three assertions confirm the counter persists across calls: `1 → 2 → 3`.

## 5. Deploy & test with the Stellar CLI

> The current CLI is **`stellar`** (the old `soroban` CLI was renamed; `soroban ...` commands are
> now `stellar ...`).

```bash
# Install / update the CLI
cargo install --locked stellar-cli

# Build the contract to WASM
stellar contract build

# Run unit tests (workspace-wide)
cargo test

# Generate / configure an identity for testnet
stellar keys generate --global alice --network testnet --fund

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/increment.wasm \
  --source alice \
  --network testnet

# Invoke the deployed contract
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source alice \
  --network testnet \
  -- increment
```

Each `increment` invocation returns the next counter value (`1`, `2`, `3`, …).

## 6. Success indicators met

- ✅ Clear understanding of Stellar's architecture (SCP/FBA consensus, ledger, accounts, assets,
  operations, Horizon vs Soroban RPC) and where smart contracts fit (Protocol 20).
- ✅ Correct mental model of Soroban as a platform integrated into Stellar (not a separate chain),
  Rust + WASM, `#![no_std]` + `soroban-sdk`.
- ✅ Understanding of the three storage tiers and state archival / state bloat.
- ✅ A working `increment` contract that compiles and passes its unit tests.
- ✅ Familiarity with the build/deploy/invoke flow using the current `stellar` CLI.

## 7. Connection to the next topics

- The storage model and `#![no_std]` Rust foundation set up **Topic 2 (Security & Fuzzing)**:
  the same `increment` contract becomes the first fuzzing/property-test target.
- Understanding invocations and state lifetime feeds directly into **Topic 3 (Solution
  Architecture)** and **Topic 4 (Prototype)**, where a real contract will be designed and
  hardened with AI-assisted fuzzing.

## 8. References

Fundamentals of the network and the contract platform:

- **Stellar Developers Docs** (official portal): https://developers.stellar.org
- **Smart Contracts Overview** — Soroban is a contract platform integrated into Stellar, with
  contracts in Rust compiled to WASM:
  https://developers.stellar.org/docs/build/smart-contracts/overview
- **Getting Started — Hello World:**
  https://developers.stellar.org/docs/build/smart-contracts/getting-started/hello-world
- **Storing Data (increment example)** — the basis of this contract:
  https://developers.stellar.org/docs/build/smart-contracts/getting-started/storing-data
- **Stellar CLI** (reference for the current CLI):
  https://developers.stellar.org/docs/tools/cli
- **`soroban-sdk`** (docs.rs): https://docs.rs/soroban-sdk

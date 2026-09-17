//! # `soroban-fuzzkit` — contract-agnostic building blocks for fuzzing Soroban contracts
//!
//! Everything in this crate is the *reusable* residue of the Topic 4 prototype:
//! the parts of an effective Soroban fuzzing harness that are **not** specific to
//! the contract under test. Nothing here mentions `soroban-vault`, and nothing
//! here encodes a bug.
//!
//! ## Why this crate exists
//!
//! A first fuzzing target for `soroban-vault` decoded its arguments straight from
//! the fuzzer's bytes and ran everything under `mock_all_auths`. It found 1 of 7
//! seeded bugs. A second one, built from the same modules as this crate, found
//! substantially more — without changing the oracle, the engine or the budget.
//! The difference was entirely in how inputs were *shaped*, and that shaping is
//! contract-independent.
//!
//! Four things turn out to matter, and all four are general:
//!
//! 1. **Scalars must come from a weighted set, not uniformly.** Uniform `i128` is
//!    almost always a magnitude the contract rejects in its first guard, so the
//!    fuzzer never reaches code that needs accumulated state. → [`operand`]
//! 2. **Some of those scalars can only be expressed relative to live state.**
//!    "One more than the caller's balance" is where the interesting boundary is,
//!    and it cannot be written as a literal. → [`operand`]
//! 3. **Addresses must be indices into a pool, never raw bytes.** A generated
//!    `Address` cannot be authorized, so fuzzing address bytes collapses every
//!    access-control property into "an unknown caller is rejected". The pool must
//!    also contain the aliasing slots a contract's "principals are not contracts"
//!    assumption never considers. → [`pool`]
//! 4. **Ledger position is an input.** TTL cliffs are step functions; a uniform
//!    advance lands on one essentially never. → [`ttl`]
//!
//! Plus one lesson that is about oracles rather than inputs, and is the easiest
//! to get subtly wrong: in Soroban *"a contract error"* is ambiguous, because it
//! may come from the contract under test or from any contract it calls. An
//! oracle that keys on the error **channel** rather than the error **value**
//! cannot tell a bug in your contract from a token rejection. → [`oracle`]
//!
//! ## Shape of a harness built on this
//!
//! ```ignore
//! use soroban_fuzzkit::{env::{pinned_env, LedgerPins}, operand::{Operand, OperandPolicy},
//!                       pool::{Pool, PoolSpec}, ttl::TtlCliffs, oracle};
//!
//! // once, in the rig
//! let env  = pinned_env(LedgerPins::default());
//! let pool = PoolSpec::new(4).with_contract(id).with_token(tok).build(&env);
//! let ops  = OperandPolicy::default();
//! let ttl  = TtlCliffs::around(&[MY_TEMP_TTL, MY_BUMP_THRESHOLD, MY_BUMP_AMOUNT]);
//!
//! // per step, from the fuzzer's own bytes
//! let who    = pool.index(step.who);
//! let amount = ops.resolve(&step.amount, client.balance_of(pool.address(who)));
//! ```
//!
//! The contract-specific parts — which entry points exist, what the invariants
//! are, what each step asserts — stay in the harness. This crate only supplies
//! the shaping.

#![deny(missing_docs)]

pub mod env;
pub mod operand;
pub mod oracle;
pub mod pool;
pub mod ttl;

pub use env::{pinned_env, LedgerPins};
pub use operand::{Operand, OperandPolicy};
pub use pool::{Pool, PoolSpec, Role};
pub use ttl::TtlCliffs;

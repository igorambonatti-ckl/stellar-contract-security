#![no_std]
//! Minimal contract used only to probe host behaviour for the P1 spikes.
//!
//! It deliberately spans all three storage tiers and has one auth-gated entry
//! point, so that the questions in `docs/execution-plan.md` §P1 can be answered
//! against a real contract rather than in the abstract.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Persistent tier — core user data, the tier `soroban-vault` will use for balances.
    Balance(Address),
    /// Temporary tier — the tier most likely to be *misused* for auth/nonce state.
    Nonce(Address),
}

/// TTL parameters used by the spike. Chosen small so the ledger can be advanced
/// past them cheaply in tests.
pub const PERSISTENT_TTL: u32 = 1_000;
pub const TEMP_TTL: u32 = 100;

#[contract]
pub struct SpikeContract;

#[contractimpl]
impl SpikeContract {
    /// Writes a balance to **persistent** storage and extends its TTL.
    pub fn set_balance(env: Env, who: Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Balance(who.clone()), &amount);
        env.storage().persistent().extend_ttl(
            &DataKey::Balance(who),
            PERSISTENT_TTL,
            PERSISTENT_TTL,
        );
    }

    pub fn get_balance(env: Env, who: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(who))
            .unwrap_or(0)
    }

    /// Writes a nonce to **temporary** storage — the anti-pattern under test.
    pub fn set_nonce(env: Env, who: Address, nonce: u32) {
        env.storage()
            .temporary()
            .set(&DataKey::Nonce(who.clone()), &nonce);
        env.storage()
            .temporary()
            .extend_ttl(&DataKey::Nonce(who), TEMP_TTL, TEMP_TTL);
    }

    pub fn get_nonce(env: Env, who: Address) -> Option<u32> {
        env.storage().temporary().get(&DataKey::Nonce(who))
    }

    /// Auth-gated entry point, used by Spike B.
    pub fn auth_action(env: Env, who: Address) -> u32 {
        let _ = &env;
        who.require_auth();
        42
    }
}

mod test_spike_a;
mod test_spike_b;

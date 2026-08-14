#![cfg(test)]
//! Shared test fixture.
//!
//! Ledger TTL floors are **pinned explicitly** rather than inherited from the
//! host defaults. That is a direct lesson from the P1 spikes: relying on the
//! defaults made two spike tests pass for the wrong reason, because a 4096-ledger
//! floor silently swallows small TTL operations.

extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};

pub const MIN_PERSISTENT: u32 = 4_096;
pub const MIN_TEMP: u32 = 16;
pub const MAX_ENTRY: u32 = 6_312_000;
pub const START_LEDGER: u32 = 1_000;
pub const INITIAL_MINT: i128 = 1_000_000;

pub struct Fixture {
    pub env: Env,
    pub vault_id: Address,
    pub token_id: Address,
    pub admin: Address,
    pub alice: Address,
    pub bob: Address,
}

impl Fixture {
    pub fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault_id)
    }

    pub fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    pub fn sac(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.token_id)
    }

    /// Assets currently held by the vault.
    pub fn vault_assets(&self) -> i128 {
        self.token().balance(&self.vault_id)
    }

    /// Drops all mocked authorizations, so `require_auth` starts rejecting.
    /// Used by the access-control invariant tests.
    pub fn revoke_all_auths(&self) {
        self.env.set_auths(&[]);
    }

    /// Reads a persistent balance entry's remaining TTL (I10′).
    pub fn balance_ttl(&self, who: &Address) -> u32 {
        use soroban_sdk::testutils::storage::Persistent;
        self.env.as_contract(&self.vault_id, || {
            self.env
                .storage()
                .persistent()
                .get_ttl(&DataKey::Balance(who.clone()))
        })
    }

    pub fn advance_ledgers(&self, n: u32) {
        let current = self.env.ledger().sequence();
        self.env.ledger().set_sequence_number(current + n);
    }
}

/// Initialized vault, funded users, all auths mocked.
pub fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = START_LEDGER;
        li.min_persistent_entry_ttl = MIN_PERSISTENT;
        li.min_temp_entry_ttl = MIN_TEMP;
        li.max_entry_ttl = MAX_ENTRY;
    });

    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(Vault, ());

    let f = Fixture {
        env,
        vault_id,
        token_id,
        admin,
        alice,
        bob,
    };

    f.vault().initialize(&f.admin, &f.token_id);
    f.sac().mint(&f.alice, &INITIAL_MINT);
    f.sac().mint(&f.bob, &INITIAL_MINT);
    f
}

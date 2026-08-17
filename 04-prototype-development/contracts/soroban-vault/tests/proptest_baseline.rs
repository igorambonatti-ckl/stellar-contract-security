//! # Baseline arm — the control group
//!
//! A harness of the kind a competent developer writes from the Stellar docs in
//! an hour, with **no invariant analysis**: one `proptest` per public entry
//! point, generating plausible inputs and asserting only that the contract does
//! not blow up.
//!
//! ## Written before the AI arm, deliberately
//!
//! This file exists to be *unremarkable*. It must not encode any knowledge of
//! which bugs were seeded, or the comparison in `results/benchmark.md` is
//! circular. The rule followed here is mechanical, and was fixed before writing
//! a line: **one test per entry point, valid-looking inputs, call the method
//! directly, no assertions about the resulting state.**
//!
//! ## Why direct calls rather than `try_*`
//!
//! In Soroban the naive "assert it does not panic" oracle has two possible
//! translations, and one of them is worthless. Using `try_deposit` returns a
//! `Result` and never panics, so the assertion is trivially satisfied and the
//! arm would detect nothing at all — a meaningless control. Calling `deposit`
//! directly makes an unexpected contract abort fail the test, which is the
//! behaviour a developer actually gets from the documented examples.
//!
//! The consequence — and this is the point of the control — is that inputs must
//! be kept inside the valid range, or the *correct* contract fails the harness.
//! That is exactly the trap an unassisted developer falls into: to stop the
//! false alarms they narrow the generators, and in narrowing them they walk the
//! fuzzer away from the edge cases where the real bugs live.

use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};
use soroban_vault::{Vault, VaultClient};

/// Generous funding, so a failed token transfer never masquerades as a contract bug.
const MINT: i128 = 1_000_000_000;

struct Rig {
    env: Env,
    vault_id: Address,
    admin: Address,
    users: [Address; 2],
}

impl Rig {
    fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault_id)
    }
}

fn rig() -> Rig {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let users = [Address::generate(&env), Address::generate(&env)];

    let token_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let vault_id = env.register(Vault, ());

    let sac = StellarAssetClient::new(&env, &token_id);
    for u in users.iter() {
        sac.mint(u, &MINT);
    }

    VaultClient::new(&env, &vault_id).initialize(&admin, &token_id);

    Rig {
        env,
        vault_id,
        admin,
        users,
    }
}

proptest! {
    /// `deposit` — plausible positive amounts the user can afford.
    #[test]
    fn fuzz_deposit(amount in 1i128..=100_000, who in 0usize..2) {
        let r = rig();
        r.vault().deposit(&r.users[who], &amount);
    }

    /// `withdraw` — deposit first, then withdraw part of the resulting shares.
    #[test]
    fn fuzz_withdraw(deposit in 1i128..=100_000, part in 1u32..=100, who in 0usize..2) {
        let r = rig();
        let shares = r.vault().deposit(&r.users[who], &deposit);
        let to_burn = (shares * part as i128 / 100).max(1);
        r.vault().withdraw(&r.users[who], &to_burn);
    }

    /// `transfer_shares` — move part of a holder's balance to someone in the pool.
    #[test]
    fn fuzz_transfer_shares(
        deposit in 1i128..=100_000,
        part in 1u32..=100,
        from in 0usize..2,
        to in 0usize..2,
    ) {
        let r = rig();
        let shares = r.vault().deposit(&r.users[from], &deposit);
        let amount = (shares * part as i128 / 100).max(1);
        r.vault().transfer_shares(&r.users[from], &r.users[to], &amount);
    }

    /// `set_admin` — hand the role to an arbitrary member of the pool.
    #[test]
    fn fuzz_set_admin(who in 0usize..2) {
        let r = rig();
        r.vault().set_admin(&r.users[who]);
    }

    /// `pause` — after an arbitrary amount of prior activity.
    #[test]
    fn fuzz_pause(deposit in 1i128..=100_000, who in 0usize..2) {
        let r = rig();
        r.vault().deposit(&r.users[who], &deposit);
        r.vault().pause();
    }

    /// `initialize` — the entry point exists, so it gets a test too.
    #[test]
    fn fuzz_initialize(who in 0usize..2) {
        let r = rig();
        // Already initialized by the rig; re-initializing is not attempted,
        // because the documented flow initializes exactly once.
        let _ = who;
        prop_assert_eq!(r.vault().admin(), r.admin);
    }

    /// `total_shares` / `balance_of` — views must not abort.
    #[test]
    fn fuzz_views(deposit in 1i128..=100_000, who in 0usize..2) {
        let r = rig();
        r.vault().deposit(&r.users[who], &deposit);
        let _ = r.vault().total_shares();
        let _ = r.vault().balance_of(&r.users[who]);
    }

    /// `last_activity` — the remaining view.
    #[test]
    fn fuzz_last_activity(deposit in 1i128..=100_000, who in 0usize..2) {
        let r = rig();
        r.vault().deposit(&r.users[who], &deposit);
        let _ = r.vault().last_activity(&r.users[who]);
        let _ = &r.env;
    }
}

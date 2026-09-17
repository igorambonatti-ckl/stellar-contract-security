#![no_main]
//! # Baseline fuzz target — the control group, coverage-guided
//!
//! The `cargo-fuzz` counterpart of [`tests/proptest_baseline.rs`]. It carries the
//! **same oracle** as the `proptest` baseline — *"the call does not abort"* — so
//! that the only variable between the two layers is the search strategy
//! (uniform random vs. coverage-guided), not what is being asserted.
//!
//! Like the `proptest` baseline it must keep the correct contract passing, so
//! its generators stay inside the plausible range. That constraint is the
//! control's whole point: it is the trap an unassisted developer falls into.

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};
use soroban_vault::{Vault, VaultClient};

const MINT: i128 = 1_000_000_000;

#[derive(arbitrary::Arbitrary, Debug)]
struct Input {
    /// Which entry point to drive.
    op: u8,
    /// A plausible deposit, clamped into the range a developer would pick.
    amount: u32,
    /// Percentage of the resulting shares to act on.
    part: u8,
    from: bool,
    to: bool,
}

struct Rig {
    vault_id: Address,
    users: [Address; 2],
    env: Env,
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
        vault_id,
        users,
        env,
    }
}

fuzz_target!(|input: Input| {
    let amount = (input.amount as i128 % 100_000) + 1;
    let part = (input.part as i128 % 100) + 1;
    let from = usize::from(input.from);
    let to = usize::from(input.to);

    let r = rig();
    let vault = VaultClient::new(&r.env, &r.vault_id);

    match input.op % 5 {
        0 => {
            vault.deposit(&r.users[from], &amount);
        }
        1 => {
            let shares = vault.deposit(&r.users[from], &amount);
            let burn = (shares * part / 100).max(1);
            vault.withdraw(&r.users[from], &burn);
        }
        2 => {
            let shares = vault.deposit(&r.users[from], &amount);
            let move_ = (shares * part / 100).max(1);
            vault.transfer_shares(&r.users[from], &r.users[to], &move_);
        }
        3 => {
            vault.set_admin(&r.users[to]);
        }
        _ => {
            vault.deposit(&r.users[from], &amount);
            vault.pause();
        }
    }
});

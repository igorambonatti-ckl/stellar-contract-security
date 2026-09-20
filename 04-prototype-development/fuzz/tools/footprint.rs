//! Prints the metered resource footprint of each vault operation against the
//! deployed WASM.
//!
//! A diagnostic, not a fuzz target. It exists because an oracle written against
//! these counters is only as good as one's understanding of which counters move
//! — and the first version of the rent oracle was vacuous precisely because that
//! understanding was assumed rather than measured.
//!
//! ```bash
//! cd 04-prototype-development/fuzz
//! cargo run --bin footprint                      # clean contract
//! cargo run --bin footprint --features bug_no_ttl
//! ```

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env};
use soroban_vault::VaultClient;

const VAULT_WASM: &[u8] = include_bytes!(env!("VAULT_WASM_PATH"));

fn row(label: &str, env: &Env) {
    let r = env.cost_estimate().resources();
    println!(
        "{label:<18} instr {:>10}  mem {:>9}  write_entries {:>2}  \
         persist_bumps {:>2}  temp_bumps {:>2}  disk_reads {:>2}",
        r.instructions,
        r.mem_bytes,
        r.write_entries,
        r.persistent_entry_rent_bumps,
        r.temporary_entry_rent_bumps,
        r.disk_read_entries,
    );
}

fn main() {
    println!("seeds compiled into the wasm: {}", env!("VAULT_WASM_SEEDS"));
    println!();

    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 1_000;
        li.min_persistent_entry_ttl = 16;
        li.min_temp_entry_ttl = 16;
        li.max_entry_ttl = 6_312_000;
    });

    let sac_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(sac_admin).address();
    let vault_id = env.register(VAULT_WASM, ());

    let admin = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let sac = StellarAssetClient::new(&env, &token_id);
    sac.mint(&alice, &1_000_000_000i128);
    sac.mint(&bob, &1_000_000_000i128);

    let vault = VaultClient::new(&env, &vault_id);

    vault.initialize(&admin, &token_id);
    row("initialize", &env);

    vault.deposit(&alice, &1_000_000i128);
    row("deposit (1st)", &env);

    vault.deposit(&alice, &500_000i128);
    row("deposit (repeat)", &env);

    vault.transfer_shares(&alice, &bob, &1_000i128);
    row("transfer_shares", &env);

    vault.withdraw(&alice, &1_000i128);
    row("withdraw", &env);

    vault.set_admin(&bob);
    row("set_admin", &env);

    let _ = vault.balance_of(&alice);
    row("balance_of (view)", &env);

    // The interesting case: let the entries' TTL decay below the contract's
    // extend_ttl threshold, then write again. A correct contract must pay rent
    // here; before this point it legitimately need not, because extend_ttl is a
    // no-op while the remaining TTL is still above the threshold.
    println!();
    println!("--- after advancing the ledger past BUMP_THRESHOLD (518 400) ---");
    let now = env.ledger().sequence();
    env.ledger().set_sequence_number(now + 600_000);

    vault.deposit(&alice, &1_000i128);
    row("deposit (decayed)", &env);

    vault.transfer_shares(&alice, &bob, &100i128);
    row("transfer (decayed)", &env);

    println!();
    println!("Reading of the columns:");
    println!("  persist_bumps == 0 while write_entries > 0  →  persistent state written that");
    println!("  nothing is paying to keep alive. Note temp_bumps moves independently: a");
    println!("  contract can keep bumping a temporary entry while neglecting a persistent one,");
    println!("  so an oracle that accepts either as proof of rent payment is vacuous.");
}

#![cfg(test)]
//! # Spike A — is TTL / state archival observable in the test `Env`?
//!
//! Invariants I10 and I11 of the Topic 3 architecture are the Soroban-specific
//! differentiator of this IDP. Both depend on being able to observe entry expiry
//! inside `Env`. This spike establishes what is actually observable under
//! `soroban-sdk` 26.1 / protocol 23.
//!
//! Each test's assertion IS the finding — read the assertions, not the prose.

extern crate std;

use super::*;
use soroban_sdk::testutils::{
    storage::{Persistent, Temporary},
    Address as _, Ledger,
};

/// Host TTL floors, set explicitly rather than relying on defaults.
///
/// The defaults are large (`min_persistent_entry_ttl` is 4096), which silently
/// makes small `extend_ttl` calls no-ops and makes "advance past the TTL" tests
/// pass for the wrong reason. Pinning them here is what makes these tests mean
/// what they claim to.
const MIN_PERSISTENT: u32 = 200;
const MIN_TEMP: u32 = 50;
const MAX_ENTRY: u32 = 100_000;

fn setup() -> (Env, Address, SpikeContractClient<'static>, Address) {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.sequence_number = 1_000;
        li.min_persistent_entry_ttl = MIN_PERSISTENT;
        li.min_temp_entry_ttl = MIN_TEMP;
        li.max_entry_ttl = MAX_ENTRY;
    });
    let contract_id = env.register(SpikeContract, ());
    let client = SpikeContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);
    (env, contract_id, client, user)
}

/// A1 — TTL is directly readable, and `extend_ttl` does extend it.
///
/// This is the assertion style the SDK explicitly recommends over relying on
/// access failure: check the TTL value, not whether a read blew up.
#[test]
fn a1_persistent_ttl_is_observable() {
    let (env, contract_id, client, user) = setup();
    client.set_balance(&user, &100);

    env.as_contract(&contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Balance(user.clone()));
        assert_eq!(
            ttl, PERSISTENT_TTL,
            "entry created at min TTL ({MIN_PERSISTENT}) then extended to {PERSISTENT_TTL}"
        );
    });
}

/// A1b — **`extend_ttl` is threshold-gated, and silently does nothing when the
/// remaining TTL already exceeds the threshold.**
///
/// `extend_ttl(threshold, extend_to)` extends only if the current TTL is below
/// `threshold`. With the host's default `min_persistent_entry_ttl` of 4096, a
/// contract calling `extend_ttl(50, 100)` — the pattern in the Stellar
/// tutorials and in this repo's own `increment` contract — is a **no-op for the
/// first 4000+ ledgers of the entry's life**.
///
/// A "missing TTL bump" fuzzing invariant that assumes every `extend_ttl` call
/// changes the TTL would produce false results. This is a genuine trap.
#[test]
fn a1b_extend_ttl_is_a_noop_below_threshold() {
    let (env, contract_id, client, user) = setup();
    client.set_balance(&user, &100);

    env.as_contract(&contract_id, || {
        let before = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Balance(user.clone()));

        // Threshold well below the current TTL → no extension should occur.
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Balance(user.clone()), 10, 5_000);

        let after = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Balance(user.clone()));

        assert_eq!(
            before, after,
            "extend_ttl(threshold=10) is a no-op while TTL ({before}) is above the threshold"
        );
    });
}

/// A2 — **the key finding.** A persistent entry whose TTL has fully expired is
/// still readable: protocol 23 auto-restoration is emulated in the test host.
///
/// Consequence: "persistent data silently disappears" is NOT a reachable state,
/// so an invariant asserting data survival can never fail and is worthless as a
/// fuzzing target.
#[test]
fn a2_expired_persistent_entry_is_auto_restored() {
    let (env, _contract_id, client, user) = setup();
    client.set_balance(&user, &100);

    let start = env.ledger().sequence();
    env.ledger().set_sequence_number(start + PERSISTENT_TTL + 1);

    assert_eq!(
        client.get_balance(&user),
        100,
        "persistent entry survives expiry via auto-restoration"
    );
}

/// A3 — after auto-restoration the TTL resets to the host minimum, which IS
/// observable. This is the replacement signal for I10: not "did data survive"
/// (it always does) but "was the entry silently restored", which costs rent.
#[test]
fn a3_auto_restoration_is_detectable_via_ttl() {
    let (env, contract_id, client, user) = setup();
    client.set_balance(&user, &100);

    let start = env.ledger().sequence();
    env.ledger().set_sequence_number(start + PERSISTENT_TTL + 1);
    let _ = client.get_balance(&user); // triggers restoration

    env.as_contract(&contract_id, || {
        let ttl = env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Balance(user.clone()));
        assert_eq!(
            ttl,
            MIN_PERSISTENT - 1,
            "a restored entry gets min_persistent_entry_ttl, less the current ledger"
        );
        assert_ne!(
            ttl, PERSISTENT_TTL,
            "and is distinguishable from a freshly-extended entry"
        );
    });
}

/// A4 — **temporary storage genuinely disappears.** No auto-restoration.
///
/// This is what keeps I11 alive as a real, falsifiable invariant, and makes
/// temporary-tier misuse the primary Soroban-specific hazard to fuzz.
#[test]
fn a4_expired_temporary_entry_is_gone() {
    let (env, contract_id, client, user) = setup();
    client.set_nonce(&user, &7);
    assert_eq!(
        client.get_nonce(&user),
        Some(7),
        "nonce readable before expiry"
    );

    env.as_contract(&contract_id, || {
        let ttl = env
            .storage()
            .temporary()
            .get_ttl(&DataKey::Nonce(user.clone()));
        assert_eq!(ttl, TEMP_TTL, "temporary TTL is observable too");
    });

    let start = env.ledger().sequence();
    env.ledger().set_sequence_number(start + TEMP_TTL + 1);

    assert_eq!(
        client.get_nonce(&user),
        None,
        "temporary entry is unrecoverable after expiry — the real hazard"
    );
}

/// A5 — the asymmetry, asserted side by side, because this contrast is the whole
/// finding of Spike A: same expiry event, opposite outcomes by tier.
#[test]
fn a5_persistent_and_temporary_diverge_at_expiry() {
    let (env, _contract_id, client, user) = setup();
    client.set_balance(&user, &500);
    client.set_nonce(&user, &1);

    let start = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(start + PERSISTENT_TTL + TEMP_TTL + 1);

    assert_eq!(client.get_balance(&user), 500, "persistent: restored");
    assert_eq!(client.get_nonce(&user), None, "temporary: lost");
}

#![cfg(test)]
//! One hand-written test per invariant (P2 gate).
//!
//! These are the ground truth the fuzzing arms are later measured against. If an
//! invariant cannot be expressed as a test here, it cannot be fuzzed — so this
//! file is where the invariant catalogue in Topic 3 §5.2 gets validated as
//! *checkable*, before any harness is written.

extern crate std;

use super::testkit::*;
use super::*;

/// I1 — `sum(balance_of(a)) == total_shares()`, through a sequence of operations.
#[test]
fn i1_supply_conservation() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    f.vault().deposit(&f.bob, &500);
    f.vault().transfer_shares(&f.alice, &f.bob, &200);
    f.vault().withdraw(&f.bob, &100);

    let sum = f.vault().balance_of(&f.alice) + f.vault().balance_of(&f.bob);
    assert_eq!(sum, f.vault().total_shares());
}

/// I2 — `total_shares() == 0` exactly when the vault holds no deposits.
#[test]
fn i2_zero_supply_iff_empty() {
    let f = setup();
    assert_eq!(f.vault().total_shares(), 0);
    assert_eq!(f.vault_assets(), 0);

    let shares = f.vault().deposit(&f.alice, &1_000);
    assert_ne!(f.vault().total_shares(), 0);
    assert_ne!(f.vault_assets(), 0);

    f.vault().withdraw(&f.alice, &shares);
    assert_eq!(f.vault().total_shares(), 0);
    assert_eq!(f.vault_assets(), 0);
}

/// I3 — a deposit followed by withdrawing the returned shares never yields more
/// than was deposited. (Yielding *more* would mean value was created.)
#[test]
fn i3_round_trip_never_profits() {
    let f = setup();
    f.vault().deposit(&f.bob, &10_000); // another holder, so the price is not trivial

    let deposited = 3_333i128;
    let shares = f.vault().deposit(&f.alice, &deposited);
    let returned = f.vault().withdraw(&f.alice, &shares);

    assert!(
        returned <= deposited,
        "round trip returned {returned} for a deposit of {deposited} — value was created"
    );
}

/// I4 — only the current admin can `set_admin` or `pause`.
#[test]
fn i4_admin_operations_require_admin_auth() {
    let f = setup();
    f.revoke_all_auths();

    assert!(
        f.vault().try_set_admin(&f.bob).is_err(),
        "set_admin must fail without the admin's authorization"
    );
    assert!(
        f.vault().try_pause().is_err(),
        "pause must fail without the admin's authorization"
    );
    assert_eq!(f.vault().admin(), f.admin, "admin unchanged");
    assert!(!f.vault().is_paused(), "still not paused");
}

/// I5 — `transfer_shares` and `withdraw` abort without the sender's `require_auth`.
#[test]
fn i5_user_operations_require_sender_auth() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    f.revoke_all_auths();

    assert!(
        f.vault().try_transfer_shares(&f.alice, &f.bob, &100).is_err(),
        "transfer_shares must fail without the sender's authorization"
    );
    assert!(
        f.vault().try_withdraw(&f.alice, &100).is_err(),
        "withdraw must fail without the sender's authorization"
    );
    assert_eq!(
        f.vault().balance_of(&f.alice),
        1_000,
        "no balance moved on a rejected call"
    );
}

/// I6 — arithmetic never overflows silently; it aborts instead.
///
/// The operands are chosen so that **wrapping produces a positive, plausible
/// result** rather than a negative one. With `total_shares = 2^28 + 1` and
/// `amount = 2^100`, the product is `2^128 + 2^100`, which wraps to exactly
/// `2^100` — positive, so it slips past the `shares <= 0` guard and mints an
/// absurd number of shares.
///
/// This matters: an earlier version of this test used operands that wrapped
/// *negative*, so the `ZeroShares` guard aborted anyway and the test passed
/// under the bug. Asserting "some error occurred" is not enough — the inputs
/// have to make the buggy path succeed. See `results/seeds.md`.
#[test]
fn i6_arithmetic_is_checked() {
    let f = setup();

    let seed_total: i128 = (1i128 << 28) + 1;
    let overflowing: i128 = 1i128 << 100;
    f.sac().mint(&f.alice, &(1i128 << 101));

    f.vault().deposit(&f.alice, &seed_total);
    assert_eq!(f.vault().total_shares(), seed_total);

    let result = f.vault().try_deposit(&f.alice, &overflowing);
    assert!(
        result.is_err(),
        "an overflowing share calculation must abort, not wrap into a plausible value"
    );
    assert_eq!(
        f.vault().total_shares(),
        seed_total,
        "state unchanged after the aborted call"
    );
}

/// I7 — non-positive amounts are always rejected.
#[test]
fn i7_non_positive_amounts_rejected() {
    let f = setup();

    assert!(f.vault().try_deposit(&f.alice, &0).is_err(), "zero deposit");
    assert!(f.vault().try_deposit(&f.alice, &-1).is_err(), "negative deposit");

    f.vault().deposit(&f.alice, &1_000);
    assert!(f.vault().try_withdraw(&f.alice, &0).is_err(), "zero withdraw");
    assert!(f.vault().try_withdraw(&f.alice, &-1).is_err(), "negative withdraw");
    assert!(
        f.vault().try_transfer_shares(&f.alice, &f.bob, &0).is_err(),
        "zero transfer"
    );

    assert_eq!(f.vault().total_shares(), 1_000, "no state change from rejected calls");
}

/// I8 — a self-transfer changes nothing.
#[test]
fn i8_self_transfer_is_a_noop() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);

    f.vault().transfer_shares(&f.alice, &f.alice, &400);

    assert_eq!(
        f.vault().balance_of(&f.alice),
        1_000,
        "self-transfer must not duplicate shares"
    );
    assert_eq!(f.vault().total_shares(), 1_000);
}

/// I9 — `initialize` is idempotent-guarded: a second call always aborts.
#[test]
fn i9_reinitialization_is_rejected() {
    let f = setup();

    let result = f.vault().try_initialize(&f.bob, &f.token_id);
    assert!(result.is_err(), "second initialize must abort");
    assert_eq!(f.vault().admin(), f.admin, "admin must not be overwritten");
}

/// I10′ — after the expected access pattern a persistent entry carries the
/// *extended* TTL, never the post-restoration minimum.
///
/// Reframed after the P1 spikes: protocol 23 auto-restores archived persistent
/// entries, so "the data is still there" is always true and proves nothing. What
/// distinguishes a correctly TTL-managed contract is the TTL *value*.
#[test]
fn i10_persistent_entries_are_ttl_managed_not_restored() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);

    assert_eq!(
        f.balance_ttl(&f.alice),
        BUMP_AMOUNT,
        "a managed entry carries the extended TTL"
    );
    assert_ne!(
        f.balance_ttl(&f.alice),
        MIN_PERSISTENT - 1,
        "and is distinguishable from a restored one"
    );
}

/// I10′ (negative control) — what the *failure* signature looks like: an entry
/// left to lapse survives via auto-restoration, but its TTL collapses to the
/// host minimum. This is the signal a fuzzing oracle keys on.
#[test]
fn i10_restoration_signature_is_detectable() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);

    f.advance_ledgers(BUMP_AMOUNT + 1);
    assert_eq!(
        f.vault().balance_of(&f.alice),
        1_000,
        "data survives — auto-restoration, not TTL management"
    );
    assert_eq!(
        f.balance_ttl(&f.alice),
        MIN_PERSISTENT - 1,
        "but the TTL reveals it was restored"
    );
}

/// I11 — nothing is gated on temporary-tier state, so its expiry cannot change
/// the contract's behaviour.
#[test]
fn i11_temporary_state_is_never_authoritative() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    assert_eq!(f.vault().last_activity(&f.alice), Some(START_LEDGER));

    // Let the telemetry lapse. Temporary entries are unrecoverable (P1 Spike A).
    f.advance_ledgers(TEMP_TTL + 1);
    assert_eq!(
        f.vault().last_activity(&f.alice),
        None,
        "temporary entry is gone, as expected"
    );

    // Every operation must still behave identically.
    assert_eq!(f.vault().balance_of(&f.alice), 1_000);
    let returned = f.vault().withdraw(&f.alice, &500);
    assert_eq!(returned, 500, "withdraw unaffected by lost telemetry");

    f.vault().set_admin(&f.bob);
    assert_eq!(f.vault().admin(), f.bob, "admin authority unaffected");
}

/// I12 — while paused, no state-mutating entry point succeeds.
#[test]
fn i12_pause_halts_all_mutations() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    f.vault().pause();

    assert!(f.vault().try_deposit(&f.alice, &100).is_err(), "deposit");
    assert!(f.vault().try_withdraw(&f.alice, &100).is_err(), "withdraw");
    assert!(
        f.vault().try_transfer_shares(&f.alice, &f.bob, &100).is_err(),
        "transfer_shares"
    );

    assert_eq!(f.vault().total_shares(), 1_000, "state frozen");
    assert_eq!(f.vault().balance_of(&f.alice), 1_000);
}

#![cfg(test)]
//! Happy-path coverage for all eight entry points (P2 gate).
//!
//! These establish that the contract *works*; the invariant assertions live in
//! `test_invariants.rs`.

extern crate std;

use super::testkit::*;

#[test]
fn initialize_sets_initial_state() {
    let f = setup();
    assert_eq!(f.vault().admin(), f.admin);
    assert_eq!(f.vault().total_shares(), 0);
    assert!(!f.vault().is_paused());
    assert_eq!(f.vault().balance_of(&f.alice), 0);
}

#[test]
fn deposit_mints_one_to_one_on_empty_vault() {
    let f = setup();
    let shares = f.vault().deposit(&f.alice, &1_000);

    assert_eq!(shares, 1_000, "first deposit sets the share price at 1:1");
    assert_eq!(f.vault().balance_of(&f.alice), 1_000);
    assert_eq!(f.vault().total_shares(), 1_000);
    assert_eq!(f.vault_assets(), 1_000);
    assert_eq!(f.token().balance(&f.alice), INITIAL_MINT - 1_000);
}

#[test]
fn deposit_mints_proportionally_on_funded_vault() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    let shares = f.vault().deposit(&f.bob, &500);

    assert_eq!(shares, 500, "share price unchanged, so 500 assets buy 500 shares");
    assert_eq!(f.vault().total_shares(), 1_500);
    assert_eq!(f.vault_assets(), 1_500);
}

#[test]
fn withdraw_returns_assets_and_burns_shares() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    let amount = f.vault().withdraw(&f.alice, &400);

    assert_eq!(amount, 400);
    assert_eq!(f.vault().balance_of(&f.alice), 600);
    assert_eq!(f.vault().total_shares(), 600);
    assert_eq!(f.vault_assets(), 600);
    assert_eq!(f.token().balance(&f.alice), INITIAL_MINT - 600);
}

#[test]
fn transfer_shares_moves_balance() {
    let f = setup();
    f.vault().deposit(&f.alice, &1_000);
    f.vault().transfer_shares(&f.alice, &f.bob, &300);

    assert_eq!(f.vault().balance_of(&f.alice), 700);
    assert_eq!(f.vault().balance_of(&f.bob), 300);
    assert_eq!(f.vault().total_shares(), 1_000, "transfers never change supply");
}

#[test]
fn set_admin_hands_over_the_role() {
    let f = setup();
    f.vault().set_admin(&f.bob);
    assert_eq!(f.vault().admin(), f.bob);
}

#[test]
fn pause_sets_the_flag() {
    let f = setup();
    assert!(!f.vault().is_paused());
    f.vault().pause();
    assert!(f.vault().is_paused());
}

#[test]
fn views_report_state() {
    let f = setup();
    f.vault().deposit(&f.alice, &250);

    assert_eq!(f.vault().total_shares(), 250);
    assert_eq!(f.vault().balance_of(&f.alice), 250);
    assert_eq!(f.vault().balance_of(&f.bob), 0);
    assert_eq!(
        f.vault().last_activity(&f.alice),
        Some(START_LEDGER),
        "telemetry records the operating ledger"
    );
    assert_eq!(f.vault().last_activity(&f.bob), None);
}

#[test]
fn deposit_withdraw_round_trip_is_lossless_for_a_sole_depositor() {
    let f = setup();
    let shares = f.vault().deposit(&f.alice, &7_777);
    let returned = f.vault().withdraw(&f.alice, &shares);

    assert_eq!(returned, 7_777);
    assert_eq!(f.token().balance(&f.alice), INITIAL_MINT);
    assert_eq!(f.vault().total_shares(), 0);
    assert_eq!(f.vault_assets(), 0);
}

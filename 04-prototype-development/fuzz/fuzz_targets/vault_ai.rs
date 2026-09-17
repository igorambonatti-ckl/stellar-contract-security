#![no_main]
//! # AI-arm fuzz target — round 2, built on `soroban-fuzzkit`
//!
//! The `cargo-fuzz` counterpart of [`tests/proptest_ai.rs`]. It differs from
//! [`vault_baseline`] in the oracle — it executes a *sequence* and checks the
//! curated invariants from `invariants.md` against state read back from the
//! contract — and from **round 1 of itself** in how inputs are shaped.
//!
//! ## Why there is a round 2
//!
//! Round 1 decoded `amount: i128` straight from the fuzzer's bytes and ran
//! everything under blanket auth mocking. It detected **1 of 7** seeds, and
//! *lost* one the baseline caught. The raw numbers are in `results/p6-raw.tsv`;
//! the two causes are structural:
//!
//! 1. Uniform `i128` is almost always a magnitude the contract rejects in its
//!    first guard, so the fuzzer could never build the multi-call state the
//!    interesting properties need. Only `bug_zero_amount` — one call, one zero
//!    byte — was reachable.
//! 2. Every call went through `try_*` and was only inspected **on success**, so
//!    an operation that aborted when it should have succeeded was silently
//!    tolerated. That is how the AI arm missed a seed the baseline's cruder
//!    "must not abort" oracle caught.
//!
//! **Neither was a tuning opportunity; both were gaps in executing the
//! architecture.** Topic 3 §6 specifies a third AI insertion point,
//! `prioritise-inputs`, whose output is to be "folded into the `Arbitrary`
//! strategies and the corpus seed". It was run in P5 by a clean-context
//! subagent, committed verbatim to `prompts/raw/prioritise-inputs.out.md` — and
//! never used. The generic half of that output is now
//! [`soroban_fuzzkit`]; this file is the contract-specific other half.
//!
//! **Nothing here is keyed to a seeded bug.** The generator was not adjusted
//! after seeing which seeds round 1 missed — that would make the benchmark
//! circular. The changes are the ones the input prior specifies, and it was
//! written by a model that never saw the seed list. `results/p6-fuzzing.md`
//! reports round 1 and round 2 side by side, which is what actually measures the
//! prompt's contribution.
//!
//! ## What is generic and what is not
//!
//! Everything about *input shaping* lives in `soroban-fuzzkit` and mentions no
//! contract: the operand policy, the principal pool with its aliasing slots, the
//! TTL cliff table, the error-attribution helpers. What stays here is what only
//! this contract can supply — its entry points, its error codes, its TTL
//! constants, and its invariants.

use libfuzzer_sys::fuzz_target;
use soroban_fuzzkit::{
    env::{pinned_env, LedgerPins},
    operand::{Operand, OperandPolicy},
    oracle,
    pool::{Pool, PoolSpec, Role},
    ttl::TtlCliffs,
};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};
use soroban_vault::{
    DataKey, Vault, VaultClient, VaultError, BUMP_AMOUNT, BUMP_THRESHOLD, TEMP_TTL,
};

/// Every error `Vault` can raise. Completeness matters: a code left out here is
/// a code that `failed_externally` would misread as somebody else's failure.
const VAULT_ERRORS: &[u32] = &[
    VaultError::AlreadyInitialized as u32,
    VaultError::NotInitialized as u32,
    VaultError::InvalidAmount as u32,
    VaultError::InsufficientBalance as u32,
    VaultError::Paused as u32,
    VaultError::Overflow as u32,
    VaultError::ZeroShares as u32,
];

/// Asymmetric funding, so magnitude and identity are independent dimensions:
/// otherwise the fuzzer cannot separate "this failed because of *who*" from
/// "this failed because of *how much*". The large slot exists so the arithmetic
/// boundaries in the operand table are reachable at all.
const MINTS: [i128; 4] = [
    1_000_000_000_000,
    10_000_000,
    1_000_000_000_000,
    1i128 << 126,
];

#[derive(arbitrary::Arbitrary, Debug)]
enum Step {
    Deposit { who: u8, amount: Operand },
    Withdraw { who: u8, shares: Operand },
    Transfer { from: u8, to: u8, shares: Operand },
    /// Forced aliasing: a random `(from, to)` pair essentially never collides,
    /// so the `from == to` branch would otherwise go untested.
    SelfTransfer { who: u8, shares: Operand },
    /// A direct token transfer into the vault, outside the contract. Moves
    /// `assets` without moving `total_shares`, which is the only way to reach the
    /// states where the share price is not 1:1.
    Donate { who: u8, amount: Operand },
    SetAdmin { who: u8 },
    Pause,
    Reinitialize { who: u8 },
    Advance { choice: u8 },
    /// I5 — with authorization revoked, a call that would move a balance must
    /// fail, and must fail on *auth* rather than for some unrelated reason.
    RevokedAuth { which: u8, who: u8, to: u8, shares: Operand },
}

#[derive(arbitrary::Arbitrary, Debug)]
struct Program {
    steps: Vec<Step>,
}

struct Rig {
    env: Env,
    vault_id: Address,
    token_id: Address,
    pool: Pool,
    ops: OperandPolicy,
    cliffs: TtlCliffs,
}

impl Rig {
    fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault_id)
    }
    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }
    fn assets(&self) -> i128 {
        self.token().balance(&self.vault_id)
    }
    /// `Σ balance_of(a)` over the pool. The pool is closed — shares cannot reach
    /// an address outside it — so this is the complete supply.
    fn held(&self) -> Option<i128> {
        self.pool
            .addresses()
            .iter()
            .try_fold(0i128, |acc, a| acc.checked_add(self.vault().balance_of(a)))
    }
    fn balance_ttl(&self, who: &Address) -> Option<u32> {
        let key = DataKey::Balance(who.clone());
        self.env.as_contract(&self.vault_id, || {
            if self.env.storage().persistent().has(&key) {
                Some(self.env.storage().persistent().get_ttl(&key))
            } else {
                None
            }
        })
    }
    fn instance_ttl(&self) -> u32 {
        self.env
            .as_contract(&self.vault_id, || self.env.storage().instance().get_ttl())
    }
}

fn rig() -> Rig {
    let env = pinned_env(LedgerPins::default());

    let sac_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(sac_admin).address();
    let vault_id = env.register(Vault, ());

    // Three ordinary actors, plus the admin, plus the two aliasing slots and the
    // never-authorized principal that `PoolSpec` adds.
    let pool = PoolSpec::new(3)
        .with_callee(token_id.clone())
        .with_contract(vault_id.clone())
        .build(&env);

    let sac = StellarAssetClient::new(&env, &token_id);
    let mut fundable = 0usize;
    for (i, a) in pool.addresses().iter().enumerate() {
        // The token and the vault are funded by the contract's own flows, never
        // minted into directly.
        if matches!(pool.role(i), Role::SelfContract | Role::Callee) {
            continue;
        }
        sac.mint(a, &MINTS[fundable % MINTS.len()]);
        fundable += 1;
    }

    let admin = pool.address(pool.slot_of(Role::Admin).unwrap()).clone();
    VaultClient::new(&env, &vault_id).initialize(&admin, &token_id);

    Rig {
        env,
        vault_id,
        token_id,
        pool,
        ops: OperandPolicy::default(),
        cliffs: TtlCliffs::around(&[TEMP_TTL, BUMP_THRESHOLD, BUMP_AMOUNT]),
    }
}

/// Invariants that must hold at every quiescent point.
fn check_global(r: &Rig, paused_before: bool, admin_before: &Address, after: &str) {
    let total = r.vault().total_shares();

    // I1 — supply conservation.
    let held = r
        .held()
        .unwrap_or_else(|| panic!("I1 after {after}: Σ balance_of() overflowed i128"));
    assert_eq!(
        total, held,
        "I1 violated after {after}: total_shares()={total} but Σ balance_of()={held}"
    );

    // I6 — non-negativity: the silent half of the arithmetic invariant.
    assert!(total >= 0, "I6 violated after {after}: total_shares()={total} < 0");
    for (i, u) in r.pool.addresses().iter().enumerate() {
        let b = r.vault().balance_of(u);
        assert!(b >= 0, "I6 violated after {after}: balance_of(pool[{i}])={b} < 0");
    }

    // N2 — the vault holds at least as many assets as there are shares. This is
    // what makes a zero-payout `withdraw` unreachable; the AI proposal claimed
    // that payout *was* reachable, so it is proved rather than assumed.
    let assets = r.assets();
    assert!(
        assets >= total,
        "N2 violated after {after}: vault holds {assets} assets against {total} shares"
    );

    // I12(a) — `paused` is monotone; there is no `unpause`.
    assert!(
        !(paused_before && !r.vault().is_paused()),
        "I12(a) violated after {after}: paused went true -> false"
    );

    // I4 — admin is stable except across an explicit `set_admin`.
    if after != "set_admin" {
        assert_eq!(
            r.vault().admin(),
            *admin_before,
            "I4 violated after {after}: admin changed outside set_admin"
        );
    }
}

/// I10′ — after any successful balance write the entry's remaining TTL is at
/// least `BUMP_THRESHOLD`.
///
/// Stated as a floor rather than `== BUMP_AMOUNT` so it holds on *every* write,
/// not only the first: above the threshold `extend_ttl` is legitimately a no-op
/// and the entry is still above the floor; below it, the entry was just extended
/// past it. Either way the floor holds.
fn check_balance_ttl(r: &Rig, slot: usize, after: &str) {
    if let Some(ttl) = r.balance_ttl(r.pool.address(slot)) {
        assert!(
            ttl >= BUMP_THRESHOLD,
            "I10' violated after {after}: Balance(pool[{slot}]) TTL is {ttl}, \
             expected >= {BUMP_THRESHOLD}"
        );
    }
}

/// N1 — every bumping mutator leaves the instance entry above the floor.
/// `transfer_shares` reaches no bumping path and is deliberately excluded.
fn check_instance_ttl(r: &Rig, after: &str) {
    let ttl = r.instance_ttl();
    assert!(
        ttl >= BUMP_THRESHOLD,
        "N1 violated after {after}: instance TTL is {ttl}, expected >= {BUMP_THRESHOLD}"
    );
}

/// I3 — share price never falls: `A₁·T₀ ≥ A₀·T₁`. Skipped, not failed, where the
/// price is undefined or the harness's own arithmetic overflows.
fn check_price(a0: i128, t0: i128, a1: i128, t1: i128, after: &str) {
    if t0 <= 0 || t1 <= 0 {
        return;
    }
    if let (Some(l), Some(rr)) = (a1.checked_mul(t0), a0.checked_mul(t1)) {
        assert!(
            l >= rr,
            "I3 violated by {after}: A1*T0={l} < A0*T1={rr} (A0={a0} T0={t0} A1={a1} T1={t1})"
        );
    }
}

fuzz_target!(|program: Program| {
    if program.steps.is_empty() || program.steps.len() > 16 {
        return;
    }

    let r = rig();
    let vault = r.vault();

    for step in program.steps.iter() {
        let paused_before = vault.is_paused();
        let admin_before = vault.admin();
        let label;

        match step {
            Step::Deposit { who, amount } => {
                label = "deposit";
                let slot = r.pool.index_caller(*who);
                let addr = r.pool.address(slot).clone();
                let amount = r.ops.resolve(amount, vault.balance_of(&addr));
                let (t0, a0) = (vault.total_shares(), r.assets());

                if vault.try_deposit(&addr, &amount).is_ok() {
                    check_price(a0, t0, r.assets(), vault.total_shares(), "deposit");
                    check_balance_ttl(&r, slot, "deposit");
                    check_instance_ttl(&r, "deposit");
                }
            }

            Step::Withdraw { who, shares } => {
                label = "withdraw";
                let slot = r.pool.index_caller(*who);
                let addr = r.pool.address(slot).clone();
                let shares = r.ops.resolve(shares, vault.balance_of(&addr));
                let (t0, a0) = (vault.total_shares(), r.assets());

                if let Ok(Ok(paid)) = vault.try_withdraw(&addr, &shares) {
                    // N4 — the payout is exactly the pro-rata floor. An exact
                    // oracle rather than an inequality, so a wrong payout is
                    // attributable to *what* was wrong about it.
                    if let Some(expected) = shares.checked_mul(a0).map(|n| if t0 == 0 { 0 } else { n / t0 }) {
                        assert_eq!(
                            paid, expected,
                            "N4 violated: withdraw of {shares} paid {paid}, expected \
                             floor({shares}*{a0}/{t0}) = {expected}"
                        );
                    }
                    // I7 — a successful withdraw implies the positivity guard
                    // held. Separated from the payout check so the two failures
                    // are not reported as each other.
                    assert!(
                        shares > 0,
                        "I7 violated: withdraw of {shares} shares succeeded and paid {paid}; \
                         non-positive amounts must be rejected"
                    );
                    // The refuted §R2 claim, asserted directly: a withdraw of a
                    // positive share count must pay something.
                    assert!(
                        paid > 0,
                        "withdraw burned {shares} shares and paid 0 (T0={t0} A0={a0}) — \
                         the §R2 truncation case is reachable after all"
                    );
                    check_price(a0, t0, r.assets(), vault.total_shares(), "withdraw");
                    check_balance_ttl(&r, slot, "withdraw");
                    check_instance_ttl(&r, "withdraw");
                }
            }

            Step::Transfer { from, to, shares } => {
                label = "transfer_shares";
                let (fs, ts) = (r.pool.index_caller(*from), r.pool.index(*to));
                let (f, t) = (r.pool.address(fs).clone(), r.pool.address(ts).clone());
                let shares = r.ops.resolve2(shares, vault.balance_of(&f), vault.balance_of(&t));
                let (bf0, bt0, t0) =
                    (vault.balance_of(&f), vault.balance_of(&t), vault.total_shares());

                if vault.try_transfer_shares(&f, &t, &shares).is_ok() {
                    assert_eq!(
                        vault.total_shares(),
                        t0,
                        "I8 violated: transfer_shares changed total_shares"
                    );
                    if fs == ts {
                        assert_eq!(
                            vault.balance_of(&f),
                            bf0,
                            "I8 violated: self-transfer of {shares} changed the balance"
                        );
                    } else {
                        assert_eq!(
                            vault.balance_of(&f),
                            bf0 - shares,
                            "I8 violated: sender balance wrong after transfer of {shares}"
                        );
                        assert_eq!(
                            vault.balance_of(&t),
                            bt0 + shares,
                            "I8 violated: recipient balance wrong after transfer of {shares}"
                        );
                    }
                    check_balance_ttl(&r, fs, "transfer_shares");
                    check_balance_ttl(&r, ts, "transfer_shares");
                }
            }

            Step::SelfTransfer { who, shares } => {
                label = "self_transfer";
                let slot = r.pool.index_caller(*who);
                let addr = r.pool.address(slot).clone();
                let shares = r.ops.resolve(shares, vault.balance_of(&addr));
                let (b0, t0) = (vault.balance_of(&addr), vault.total_shares());

                if vault.try_transfer_shares(&addr, &addr, &shares).is_ok() {
                    assert_eq!(
                        vault.balance_of(&addr),
                        b0,
                        "I8 violated: self-transfer of {shares} moved a balance from {b0}"
                    );
                    assert_eq!(
                        vault.total_shares(),
                        t0,
                        "I8 violated: self-transfer changed total_shares"
                    );
                }
            }

            Step::Donate { who, amount } => {
                label = "donate";
                let addr = r.pool.address(r.pool.index_caller(*who)).clone();
                let amount = r.ops.resolve(amount, r.token().balance(&addr));
                let (t0, b0) = (vault.total_shares(), r.held());

                if r.token().try_transfer(&addr, &r.vault_id, &amount).is_ok() {
                    // A donation moves assets only; it must not touch the vault's
                    // own bookkeeping.
                    assert_eq!(vault.total_shares(), t0, "donation changed total_shares");
                    assert_eq!(r.held(), b0, "donation changed a share balance");
                }
            }

            Step::SetAdmin { who } => {
                label = "set_admin";
                let addr = r.pool.address(r.pool.index(*who)).clone();
                let res = vault.try_set_admin(&addr);

                // An admin operation with full authorization on an initialized,
                // unpaused-irrelevant vault has no legitimate way to fail. The
                // round-1 target only inspected the success path, so a call that
                // wrongly aborted was tolerated — the baseline's cruder oracle
                // caught a seed this arm missed. The AI arm must be a superset of
                // the control, not a replacement for it.
                assert!(
                    res.is_ok(),
                    "set_admin aborted with {res:?} under full authorization on an \
                     initialized vault; no VaultError is reachable here"
                );
                assert_eq!(
                    vault.admin(),
                    addr,
                    "I4 violated: set_admin succeeded without installing the new admin"
                );
                check_instance_ttl(&r, "set_admin");
            }

            Step::Pause => {
                label = "pause";
                let res = vault.try_pause();
                assert!(
                    res.is_ok(),
                    "pause aborted with {res:?} under full authorization on an \
                     initialized vault; pause is idempotent and has no failure path"
                );
                assert!(vault.is_paused(), "I12 violated: pause did not set the flag");
                check_instance_ttl(&r, "pause");
            }

            Step::Reinitialize { who } => {
                label = "initialize";
                let addr = r.pool.address(r.pool.index(*who)).clone();
                let (t0, admin0, paused0) =
                    (vault.total_shares(), vault.admin(), vault.is_paused());

                // I9 — and specifically with `AlreadyInitialized`, not merely
                // "some error": a rejection for another reason would mean the
                // guard is not the thing doing the rejecting.
                let res = vault.try_initialize(&addr, &r.token_id);
                assert!(
                    oracle::failed_with(&res, VaultError::AlreadyInitialized as u32),
                    "I9 violated: a second initialize returned {res:?}, expected \
                     AlreadyInitialized"
                );
                assert_eq!(vault.admin(), admin0, "I9 violated: admin was overwritten");
                assert_eq!(vault.total_shares(), t0, "I9 violated: total_shares was reset");
                assert_eq!(vault.is_paused(), paused0, "I9 violated: paused was reset");
            }

            Step::Advance { choice } => {
                label = "advance_ledger";
                let by = r.cliffs.pick(*choice);
                let now = r.env.ledger().sequence();
                r.env.ledger().set_sequence_number(now.saturating_add(by));
            }

            Step::RevokedAuth { which, who, to, shares } => {
                label = "revoked_auth";
                let slot = r.pool.index(*who);
                let addr = r.pool.address(slot).clone();
                let other = r.pool.address(r.pool.index(*to)).clone();
                let shares = r.ops.resolve(shares, vault.balance_of(&addr));

                let (t0, b0, a0, admin0) =
                    (vault.total_shares(), r.held(), r.assets(), vault.admin());

                r.env.set_auths(&[]);
                let failed_on_auth = match which % 3 {
                    0 => oracle::failed_externally(&vault.try_withdraw(&addr, &shares), VAULT_ERRORS),
                    1 => oracle::failed_externally(
                        &vault.try_transfer_shares(&addr, &other, &shares),
                        VAULT_ERRORS,
                    ),
                    _ => oracle::failed_externally(&vault.try_set_admin(&other), VAULT_ERRORS),
                };
                r.env.mock_all_auths();

                // Discriminating, deliberately: it must have failed, and NOT with
                // a VaultError. Accepting any error would let this pass when the
                // call was rejected for an unrelated reason such as `Paused` or
                // `InvalidAmount` — the weak `is_err()` oracle.
                assert!(
                    failed_on_auth,
                    "I5 violated: with authorization revoked, operation {} by pool[{slot}] \
                     ({shares} shares) did not fail on auth",
                    which % 3
                );
                assert_eq!(vault.total_shares(), t0, "I5 violated: unauthorized call changed supply");
                assert_eq!(r.held(), b0, "I5 violated: unauthorized call moved a balance");
                assert_eq!(r.assets(), a0, "I5 violated: unauthorized call moved tokens");
                assert_eq!(vault.admin(), admin0, "I5 violated: unauthorized call moved admin");
            }
        }

        check_global(&r, paused_before, &admin_before, label);
    }
});

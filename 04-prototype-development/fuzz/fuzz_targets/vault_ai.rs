#![no_main]
//! # AI-arm fuzz target — coverage-guided, state-inspecting oracle
//!
//! The `cargo-fuzz` counterpart of [`tests/proptest_ai.rs`]. It differs from
//! [`vault_baseline`] in exactly one way, and it is the way that matters: the
//! oracle. The baseline asks *"did the call abort?"*; this target executes a
//! **sequence** of operations and, after each one, checks the curated invariants
//! from `invariants.md` against state it reads back from the contract.
//!
//! ## Why a sequence rather than a single call
//!
//! The input-prioritisation round (`prompts/raw/prioritise-inputs.out.md`, Part
//! 3) is folded in here: single calls find shallow faults, and the interesting
//! properties of this contract are all state-dependent. The fuzzer therefore
//! decodes its input as a short program — an opcode list plus a ledger-advance
//! dimension — which is also what gives libFuzzer something structural to
//! mutate.
//!
//! ## Invariants asserted after every step
//!
//! | ID | Property |
//! |---|---|
//! | I1 | `total_shares() == Σ balance_of(a)` over the actor pool |
//! | I6 | every balance and the supply are non-negative |
//! | N2 | the vault's token balance is at least the share supply |
//! | I12(a) | `is_paused()` never goes `true → false` |
//! | I4 | `admin()` changes only across a `set_admin` step |
//!
//! Step-local invariants — I8 (self-transfer), I3 (price monotonicity), I9
//! (re-init) — are asserted inside the arm that performs the operation, where
//! the before/after pair is in scope.
//!
//! I5 (auth) and I10′/I11 (TTL) are **not** asserted here. They need,
//! respectively, a revoked-auth arm and TTL reads that are awkward to drive from
//! a single flat byte string; they live in the `proptest` harness instead. That
//! split is recorded rather than papered over — see `results/p6-fuzzing.md`.

use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};
use soroban_vault::{Vault, VaultClient};

const POOL: usize = 3;
const MINT: i128 = 1_000_000_000_000;
const START_LEDGER: u32 = 1_000;

#[derive(arbitrary::Arbitrary, Debug)]
enum Step {
    Deposit { who: u8, amount: i128 },
    Withdraw { who: u8, shares: i128 },
    Transfer { from: u8, to: u8, shares: i128 },
    SelfTransfer { who: u8, shares: i128 },
    SetAdmin { who: u8 },
    Pause,
    Reinitialize { who: u8 },
    AdvanceLedger { by: u32 },
}

#[derive(arbitrary::Arbitrary, Debug)]
struct Program {
    steps: Vec<Step>,
}

struct Rig {
    env: Env,
    vault_id: Address,
    token_id: Address,
    users: [Address; POOL],
}

impl Rig {
    fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault_id)
    }

    fn assets(&self) -> i128 {
        TokenClient::new(&self.env, &self.token_id).balance(&self.vault_id)
    }

    /// `Σ balance_of(a)` over the actor pool. The pool is closed — no shares can
    /// reach an address outside it — so this is the complete supply.
    fn held(&self) -> i128 {
        self.users.iter().map(|u| self.vault().balance_of(u)).sum()
    }
}

fn rig() -> Rig {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = START_LEDGER;
        li.min_persistent_entry_ttl = 4_096;
        li.min_temp_entry_ttl = 16;
        li.max_entry_ttl = 6_312_000;
    });

    let admin = Address::generate(&env);
    let users = [
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    ];

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
        token_id,
        users,
    }
}

/// The invariants that must hold at every quiescent point.
fn check_global(r: &Rig, paused_before: bool, admin_before: &Address, after: &str) {
    let total = r.vault().total_shares();
    let held = r.held();

    // I1 — supply conservation.
    assert_eq!(
        total, held,
        "I1 violated after {after}: total_shares()={total} but Σ balance_of()={held}"
    );

    // I6 — non-negativity. The silent half of the arithmetic invariant: a wrap
    // that lands negative shows up here, and `checked_*` aborting does not.
    assert!(total >= 0, "I6 violated after {after}: total_shares()={total} < 0");
    for u in r.users.iter() {
        let b = r.vault().balance_of(u);
        assert!(b >= 0, "I6 violated after {after}: a balance is {b} < 0");
    }

    // N2 — the vault always holds at least as many assets as there are shares.
    // This is the property that makes a zero-payout `withdraw` unreachable; the
    // AI arm claimed that payout *was* reachable, so it is proved here rather
    // than assumed. See invariants.md §R2.
    let assets = r.assets();
    assert!(
        assets >= total,
        "N2 violated after {after}: vault holds {assets} assets against {total} shares"
    );

    // I12(a) — `paused` is monotone; there is no `unpause`.
    let paused = r.vault().is_paused();
    assert!(
        !(paused_before && !paused),
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

fuzz_target!(|program: Program| {
    // A long program spends the whole budget in one `Env`; cap it so libFuzzer
    // keeps exploring shapes rather than lengths.
    if program.steps.is_empty() || program.steps.len() > 12 {
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
                let who = &r.users[*who as usize % POOL];
                let (t0, a0) = (vault.total_shares(), r.assets());

                if vault.try_deposit(who, amount).is_ok() {
                    // I3 — price is non-decreasing: A₁·T₀ ≥ A₀·T₁. Skipped when
                    // the price is undefined (T₀ == 0) or either product
                    // overflows, which is a limit of the check, not a pass.
                    let (t1, a1) = (vault.total_shares(), r.assets());
                    if t0 > 0 && t1 > 0 {
                        if let (Some(l), Some(rr)) = (a1.checked_mul(t0), a0.checked_mul(t1)) {
                            assert!(
                                l >= rr,
                                "I3 violated by deposit: A1*T0={l} < A0*T1={rr} \
                                 (A0={a0} T0={t0} A1={a1} T1={t1})"
                            );
                        }
                    }
                }
            }
            Step::Withdraw { who, shares } => {
                label = "withdraw";
                let who = &r.users[*who as usize % POOL];
                let (t0, a0) = (vault.total_shares(), r.assets());

                if let Ok(Ok(paid)) = vault.try_withdraw(who, shares) {
                    let (t1, a1) = (vault.total_shares(), r.assets());

                    // N2′ / the refuted AI claim, asserted directly: a
                    // successful withdraw of a positive share count must pay
                    // something. If this ever fires, the truncation scenario
                    // rejected in invariants.md §R2 was reachable after all.
                    assert!(
                        paid > 0,
                        "withdraw burned {shares} shares and paid 0 \
                         (T0={t0} A0={a0}) — the §R2 truncation case is reachable"
                    );

                    if t0 > 0 && t1 > 0 {
                        if let (Some(l), Some(rr)) = (a1.checked_mul(t0), a0.checked_mul(t1)) {
                            assert!(
                                l >= rr,
                                "I3 violated by withdraw: A1*T0={l} < A0*T1={rr}"
                            );
                        }
                    }
                }
            }
            Step::Transfer { from, to, shares } => {
                label = "transfer_shares";
                let fi = *from as usize % POOL;
                let ti = *to as usize % POOL;
                let (f, t) = (&r.users[fi], &r.users[ti]);
                let (bf0, bt0, t0) = (
                    vault.balance_of(f),
                    vault.balance_of(t),
                    vault.total_shares(),
                );

                if vault.try_transfer_shares(f, t, shares).is_ok() {
                    // I8 — supply-neutral, and exact on both legs.
                    assert_eq!(
                        vault.total_shares(),
                        t0,
                        "I8 violated: transfer_shares changed total_shares"
                    );
                    if fi == ti {
                        assert_eq!(
                            vault.balance_of(f),
                            bf0,
                            "I8 violated: self-transfer of {shares} changed the balance"
                        );
                    } else {
                        assert_eq!(
                            vault.balance_of(f),
                            bf0 - shares,
                            "I8 violated: sender balance is wrong after transfer"
                        );
                        assert_eq!(
                            vault.balance_of(t),
                            bt0 + shares,
                            "I8 violated: recipient balance is wrong after transfer"
                        );
                    }
                }
            }
            Step::SelfTransfer { who, shares } => {
                // A dedicated arm, because a fuzzed `(from, to)` pair aliases far
                // too rarely to exercise I8's self-transfer clause by chance.
                label = "self_transfer";
                let who = &r.users[*who as usize % POOL];
                let (b0, t0) = (vault.balance_of(who), vault.total_shares());

                if vault.try_transfer_shares(who, who, shares).is_ok() {
                    assert_eq!(
                        vault.balance_of(who),
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
            Step::SetAdmin { who } => {
                label = "set_admin";
                let who = &r.users[*who as usize % POOL];
                if vault.try_set_admin(who).is_ok() {
                    assert_eq!(
                        vault.admin(),
                        *who,
                        "I4 violated: set_admin succeeded without installing the new admin"
                    );
                }
            }
            Step::Pause => {
                label = "pause";
                if vault.try_pause().is_ok() {
                    assert!(vault.is_paused(), "I12 violated: pause did not set the flag");
                }
            }
            Step::Reinitialize { who } => {
                label = "initialize";
                let who = &r.users[*who as usize % POOL];
                let (t0, admin0, paused0) =
                    (vault.total_shares(), vault.admin(), vault.is_paused());

                // I9 — a second initialize must always fail, and change nothing.
                let result = vault.try_initialize(who, &r.token_id);
                assert!(result.is_err(), "I9 violated: a second initialize succeeded");
                assert_eq!(vault.admin(), admin0, "I9 violated: admin was overwritten");
                assert_eq!(
                    vault.total_shares(),
                    t0,
                    "I9 violated: total_shares was reset"
                );
                assert_eq!(
                    vault.is_paused(),
                    paused0,
                    "I9 violated: the paused flag was reset"
                );
            }
            Step::AdvanceLedger { by } => {
                label = "advance_ledger";
                // Ledger position is a first-class fuzz dimension: I10′, I11 and
                // N1 are all reachable only by moving it. Capped below the host
                // max so the entry TTLs stay meaningful.
                let by = by % 2_000_000;
                let now = r.env.ledger().sequence();
                r.env.ledger().set_sequence_number(now.saturating_add(by));
            }
        }

        check_global(&r, paused_before, &admin_before, label);
    }
});

---
prompt: generate-harness v1.0
date: 2026-09-17
model: claude-opus-5[1m] (Opus 5, 1M context)
target: contracts/soroban-vault/tests/proptest_ai.rs
---

```rust
//! Property-test harness for `soroban-vault`, asserting the curated invariants
//! I1, I3, I4, I5, I6, I8, I9, I10', I11, I12, N1, N2, N3.
//!
//! Design rules this file obeys:
//!
//!   * **State oracles, never liveness.** Every property reads contract state
//!     back and compares it against a value the harness computed itself. Where
//!     the only assertion available is "this must abort", we use `try_*`,
//!     assert *which* error came back, and assert that the observable state is
//!     bit-for-bit unchanged.
//!   * **Principals come from a fixed pool** (`Fixture::pool`), fuzzed by
//!     index. Freshly generated `Address`es are used only where an address is
//!     *data* (the `token` / `admin` arguments of a re-`initialize` attempt).
//!   * **Ledger TTL floors are pinned**, not inherited. The host default
//!     `min_persistent_entry_ttl` of 4096 would make the TTL properties pass
//!     for the wrong reason.
//!   * **Generators reach extreme operands** (`i128::MIN`, `i128::MAX`, zero,
//!     negatives). Properties are therefore phrased as disjunctions: either the
//!     call aborts cleanly with the error the harness predicted and leaves
//!     state untouched, or it succeeds and the state relation holds exactly.

use proptest::prelude::*;

use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, InvokeError};

use soroban_vault::{
    DataKey, Vault, VaultClient, VaultError, BUMP_AMOUNT, BUMP_THRESHOLD, TEMP_TTL,
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

/// Number of principals in the actor pool. Small on purpose: aliasing (`from ==
/// to`, depositor == admin) must happen often enough to matter.
const POOL_SIZE: usize = 4;

/// Known starting sequence number, so TTL arithmetic in the assertions is
/// reproducible.
const START_SEQ: u32 = 1_000;

/// Pinned TTL floors. The host default `min_persistent_entry_ttl` is 4096,
/// which silently swallows small TTL operations; we drive it down to 16 so that
/// an `extend_ttl` that did *not* fire is observable.
const MIN_PERSISTENT_TTL: u32 = 16;
const MIN_TEMP_TTL: u32 = 16;
/// Mainnet maximum; must exceed `BUMP_AMOUNT` or the bump would be clamped.
const MAX_ENTRY_TTL: u32 = 6_312_000;

/// Underlying token minted to each pool member. Large enough that realistic
/// deposits always clear, small enough that extreme operands fail at the token
/// contract rather than silently succeeding.
const MINT_PER_ACTOR: i128 = 1_000_000_000_000;

/// The error channel of a `try_*` call on `VaultClient`.
type VErr = Result<VaultError, InvokeError>;

struct Fixture {
    env: Env,
    vault_id: Address,
    token_id: Address,
    pool: Vec<Address>,
}

impl Fixture {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        env.ledger().with_mut(|li| {
            li.sequence_number = START_SEQ;
            li.timestamp = 1_700_000_000;
            li.min_persistent_entry_ttl = MIN_PERSISTENT_TTL;
            li.min_temp_entry_ttl = MIN_TEMP_TTL;
            li.max_entry_ttl = MAX_ENTRY_TTL;
        });

        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        let vault_id = env.register(Vault, ());

        // The actor pool deliberately excludes the vault's own address and the
        // token contract address.
        let mut pool = Vec::with_capacity(POOL_SIZE);
        for _ in 0..POOL_SIZE {
            pool.push(Address::generate(&env));
        }

        Fixture {
            env,
            vault_id,
            token_id,
            pool,
        }
    }

    fn vault(&self) -> VaultClient<'_> {
        VaultClient::new(&self.env, &self.vault_id)
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    fn sac(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.token_id)
    }

    /// `initialize` with `pool[0]` as admin, then fund every pool member.
    fn init_and_fund(&self) {
        let admin = self.pool[0].clone();
        self.vault().initialize(&admin, &self.token_id);
        let sac = self.sac();
        for a in &self.pool {
            sac.mint(a, &MINT_PER_ACTOR);
        }
    }

    /// `A` — the vault's balance of the underlying token, read from the token
    /// contract, i.e. independently of the vault's own bookkeeping.
    fn assets(&self) -> i128 {
        self.token().balance(&self.vault_id)
    }

    /// `B(a)` for every `a ∈ H`.
    fn balances(&self) -> Vec<i128> {
        self.pool
            .iter()
            .map(|a| self.vault().balance_of(a))
            .collect()
    }

    /// Index of the current admin within the pool, if it is a pool member.
    fn admin_idx(&self) -> Option<usize> {
        let admin = self.vault().admin();
        self.pool.iter().position(|a| *a == admin)
    }

    fn seq(&self) -> u32 {
        self.env.ledger().sequence()
    }

    fn advance(&self, ledgers: u32) {
        let next = self.env.ledger().sequence().saturating_add(ledgers);
        self.env.ledger().set_sequence_number(next);
    }

    /// Remaining TTL of the vault's instance entry.
    fn instance_ttl(&self) -> u32 {
        self.env
            .as_contract(&self.vault_id, || self.env.storage().instance().get_ttl())
    }

    /// Remaining TTL of the persistent `Balance(who)` entry. Returns `None` if
    /// the entry does not exist (the SDK panics on a missing key, so we gate on
    /// `has` first).
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation model
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MutKind {
    Deposit,
    Withdraw,
    Transfer,
    SetAdmin,
    Pause,
}

#[derive(Debug, Clone)]
enum Op {
    Deposit { actor: usize, amount: i128 },
    Withdraw { actor: usize, shares: i128 },
    Transfer { from: usize, to: usize, shares: i128 },
    SetAdmin { new: usize },
    Pause,
    /// A direct token transfer into the vault, bypassing `deposit`. Inflates
    /// `A` without inflating `T`, which is what makes the `ZeroShares` branch
    /// and the `A ≥ T` margin of N2 reachable.
    Donate { actor: usize, amount: i128 },
    Advance { ledgers: u32 },
    /// Call every view, several times, in a shuffled-ish order (N3).
    Views { actor: usize },
}

#[derive(Debug)]
enum Outcome {
    DepositOk {
        actor: usize,
        amount: i128,
        shares: i128,
    },
    WithdrawOk {
        actor: usize,
        shares: i128,
        amount: i128,
    },
    TransferOk {
        from: usize,
        to: usize,
        shares: i128,
    },
    SetAdminOk {
        new: usize,
    },
    PauseOk,
    VaultFailed {
        kind: MutKind,
        err: VErr,
    },
    DonateOk {
        amount: i128,
    },
    DonateFailed,
    Advanced,
    Views,
}

impl Outcome {
    /// A run-to-run comparable summary that deliberately contains no
    /// `Address`es (I11 compares two independent `Env`s).
    fn tag(&self) -> String {
        format!("{:?}", self)
    }
}

impl Fixture {
    fn apply(&self, op: &Op) -> Outcome {
        match op {
            Op::Deposit { actor, amount } => {
                match self.vault().try_deposit(&self.pool[*actor], amount) {
                    Ok(Ok(shares)) => Outcome::DepositOk {
                        actor: *actor,
                        amount: *amount,
                        shares,
                    },
                    Ok(Err(_)) => Outcome::VaultFailed {
                        kind: MutKind::Deposit,
                        err: Err(InvokeError::Abort),
                    },
                    Err(e) => Outcome::VaultFailed {
                        kind: MutKind::Deposit,
                        err: e,
                    },
                }
            }
            Op::Withdraw { actor, shares } => {
                match self.vault().try_withdraw(&self.pool[*actor], shares) {
                    Ok(Ok(amount)) => Outcome::WithdrawOk {
                        actor: *actor,
                        shares: *shares,
                        amount,
                    },
                    Ok(Err(_)) => Outcome::VaultFailed {
                        kind: MutKind::Withdraw,
                        err: Err(InvokeError::Abort),
                    },
                    Err(e) => Outcome::VaultFailed {
                        kind: MutKind::Withdraw,
                        err: e,
                    },
                }
            }
            Op::Transfer { from, to, shares } => {
                match self
                    .vault()
                    .try_transfer_shares(&self.pool[*from], &self.pool[*to], shares)
                {
                    Ok(Ok(())) => Outcome::TransferOk {
                        from: *from,
                        to: *to,
                        shares: *shares,
                    },
                    Ok(Err(_)) => Outcome::VaultFailed {
                        kind: MutKind::Transfer,
                        err: Err(InvokeError::Abort),
                    },
                    Err(e) => Outcome::VaultFailed {
                        kind: MutKind::Transfer,
                        err: e,
                    },
                }
            }
            Op::SetAdmin { new } => match self.vault().try_set_admin(&self.pool[*new]) {
                Ok(Ok(())) => Outcome::SetAdminOk { new: *new },
                Ok(Err(_)) => Outcome::VaultFailed {
                    kind: MutKind::SetAdmin,
                    err: Err(InvokeError::Abort),
                },
                Err(e) => Outcome::VaultFailed {
                    kind: MutKind::SetAdmin,
                    err: e,
                },
            },
            Op::Pause => match self.vault().try_pause() {
                Ok(Ok(())) => Outcome::PauseOk,
                Ok(Err(_)) => Outcome::VaultFailed {
                    kind: MutKind::Pause,
                    err: Err(InvokeError::Abort),
                },
                Err(e) => Outcome::VaultFailed {
                    kind: MutKind::Pause,
                    err: e,
                },
            },
            Op::Donate { actor, amount } => {
                let r = self
                    .token()
                    .try_transfer(&self.pool[*actor], &self.vault_id, amount);
                if matches!(r, Ok(Ok(()))) {
                    Outcome::DonateOk { amount: *amount }
                } else {
                    Outcome::DonateFailed
                }
            }
            Op::Advance { ledgers } => {
                self.advance(*ledgers);
                Outcome::Advanced
            }
            Op::Views { actor } => {
                // N3: views are called repeatedly and in varying order.
                let who = &self.pool[*actor];
                let _ = self.vault().total_shares();
                let _ = self.vault().balance_of(who);
                let _ = self.vault().is_paused();
                let _ = self.vault().last_activity(who);
                let _ = self.vault().admin();
                let _ = self.vault().balance_of(who);
                let _ = self.vault().total_shares();
                let _ = self.vault().last_activity(who);
                let _ = self.vault().is_paused();
                let _ = self.vault().admin();
                Outcome::Views
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

fn idx() -> impl Strategy<Value = usize> {
    0usize..POOL_SIZE
}

/// Amounts/share counts. This deliberately reaches the extremes — zero,
/// negatives, `i128::MIN`, `i128::MAX` — because a generator narrowed to a
/// "plausible" band cannot distinguish a correct guard from a missing one.
fn amount_strategy() -> BoxedStrategy<i128> {
    prop_oneof![
        6 => 1i128..=2_000_000i128,
        3 => 1i128..=10i128,
        2 => Just(0i128),
        2 => -2_000_000i128..=-1i128,
        1 => Just(1i128),
        1 => Just(i128::MIN),
        1 => Just(i128::MAX),
        1 => (i128::MAX / 4)..=i128::MAX,
        1 => any::<i128>(),
    ]
    .boxed()
}

/// A `(from, to)` pair that aliases (`from == to`) with non-trivial
/// probability — a uniformly random pair essentially never does, which would
/// leave the `from == to` branch of `transfer_shares` untested (I8).
fn pair_strategy() -> impl Strategy<Value = (usize, usize)> {
    (idx(), idx(), prop_oneof![1 => Just(true), 2 => Just(false)])
        .prop_map(|(f, t, alias)| if alias { (f, f) } else { (f, t) })
}

fn mutating_op_strategy() -> BoxedStrategy<Op> {
    prop_oneof![
        6 => (idx(), amount_strategy()).prop_map(|(actor, amount)| Op::Deposit { actor, amount }),
        5 => (idx(), amount_strategy()).prop_map(|(actor, shares)| Op::Withdraw { actor, shares }),
        5 => (pair_strategy(), amount_strategy())
                .prop_map(|((from, to), shares)| Op::Transfer { from, to, shares }),
        2 => idx().prop_map(|new| Op::SetAdmin { new }),
        1 => Just(Op::Pause),
        3 => (idx(), 1i128..=1_000_000i128).prop_map(|(actor, amount)| Op::Donate { actor, amount }),
    ]
    .boxed()
}

fn op_strategy() -> BoxedStrategy<Op> {
    prop_oneof![
        22 => mutating_op_strategy(),
        // Ledger advance is a first-class fuzz dimension (I10', I11, N1), not a
        // nuisance. Bounded so that persistent entries (bumped to BUMP_AMOUNT)
        // and the SAC's own balance entries cannot lapse mid-sequence.
        3 => (0u32..=20_000u32).prop_map(|ledgers| Op::Advance { ledgers }),
        2 => idx().prop_map(|actor| Op::Views { actor }),
    ]
    .boxed()
}

fn cfg(cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases,
        max_shrink_iters: 4_000,
        ..ProptestConfig::default()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P1 — the stateful sequence property
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariants: **I1**, **I3**, **I4**, **I6**, **I8**, **I12(a)**,
    /// **I12(b)**, **N1**, **N2**, **N3**.
    ///
    /// Drives an arbitrary interleaving of `deposit`, `withdraw`,
    /// `transfer_shares`, `set_admin`, `pause`, direct donations, view calls
    /// and ledger advances, and re-checks the full quiescent-state relation
    /// after *every* step — including steps that aborted.
    #[test]
    fn prop_sequence_state_invariants(ops in prop::collection::vec(op_strategy(), 1..14)) {
        let f = Fixture::new();
        f.init_and_fund();

        for (step, op) in ops.iter().enumerate() {
            // ── pre-state ────────────────────────────────────────────────────
            let t0 = f.vault().total_shares();
            let a0 = f.assets();
            let b0 = f.balances();
            let admin0 = f.vault().admin();
            let paused0 = f.vault().is_paused();

            let out = f.apply(op);

            // ── post-state ───────────────────────────────────────────────────
            let t1 = f.vault().total_shares();
            let a1 = f.assets();
            let b1 = f.balances();
            let admin1 = f.vault().admin();
            let paused1 = f.vault().is_paused();

            // ── I6: non-negativity ───────────────────────────────────────────
            prop_assert!(
                t1 >= 0,
                "I6 broken at step {step} ({op:?}): total_shares() == {t1} < 0"
            );
            for (i, b) in b1.iter().enumerate() {
                prop_assert!(
                    *b >= 0,
                    "I6 broken at step {step} ({op:?}): balance_of(pool[{i}]) == {b} < 0"
                );
            }

            // ── I1: T == Σ B(a) ──────────────────────────────────────────────
            let sum = b1
                .iter()
                .try_fold(0i128, |acc, x| acc.checked_add(*x));
            prop_assert!(
                sum.is_some(),
                "I1 broken at step {step} ({op:?}): Σ B(a) overflowed i128, balances = {b1:?}"
            );
            let sum = sum.unwrap();
            prop_assert!(
                t1 == sum,
                "I1 broken at step {step} ({op:?}): T == {t1} but Σ B(a) == {sum} \
                 (balances = {b1:?}, outcome = {out:?})"
            );

            // ── N2: A ≥ T ────────────────────────────────────────────────────
            prop_assert!(
                a1 >= t1,
                "N2 broken at step {step} ({op:?}): A == {a1} < T == {t1} \
                 (was A == {a0}, T == {t0}; outcome = {out:?})"
            );

            // ── I12(a): paused is a one-way latch ────────────────────────────
            if paused0 {
                prop_assert!(
                    paused1,
                    "I12(a) broken at step {step} ({op:?}): is_paused() went true -> false"
                );
            }

            // ── I4: admin changes only via a successful set_admin ────────────
            match &out {
                Outcome::SetAdminOk { new } => {
                    prop_assert!(
                        admin1 == f.pool[*new],
                        "I4 broken at step {step}: set_admin(pool[{new}]) succeeded but \
                         admin() is {admin1:?}, expected {:?}",
                        f.pool[*new]
                    );
                }
                _ => {
                    prop_assert!(
                        admin1 == admin0,
                        "I4 broken at step {step} ({op:?}): admin() changed from {admin0:?} \
                         to {admin1:?} without a successful set_admin (outcome = {out:?})"
                    );
                }
            }

            // ── I12(b): while paused, the three mutators must abort ──────────
            if paused0 {
                if matches!(op, Op::Deposit { .. } | Op::Withdraw { .. } | Op::Transfer { .. }) {
                    prop_assert!(
                        matches!(out, Outcome::VaultFailed { .. }),
                        "I12(b) broken at step {step}: {op:?} succeeded while paused \
                         (outcome = {out:?})"
                    );
                }
            }

            // ── per-outcome exact relations ──────────────────────────────────
            match &out {
                Outcome::DepositOk { actor, amount, shares } => {
                    prop_assert!(
                        *shares > 0,
                        "deposit at step {step} minted {shares} shares; the contract must \
                         reject shares <= 0 with ZeroShares"
                    );
                    prop_assert!(
                        t1 == t0 + *shares,
                        "I1/deposit at step {step}: T went {t0} -> {t1}, expected {} \
                         (shares = {shares})",
                        t0 + *shares
                    );
                    prop_assert!(
                        b1[*actor] == b0[*actor] + *shares,
                        "I1/deposit at step {step}: B(pool[{actor}]) went {} -> {}, \
                         expected {} (shares = {shares})",
                        b0[*actor], b1[*actor], b0[*actor] + *shares
                    );
                    prop_assert!(
                        a1 == a0 + *amount,
                        "deposit at step {step}: A went {a0} -> {a1}, expected {} \
                         (amount = {amount})",
                        a0 + *amount
                    );
                    for i in 0..POOL_SIZE {
                        if i != *actor {
                            prop_assert!(
                                b1[i] == b0[i],
                                "deposit at step {step} moved an unrelated balance: \
                                 B(pool[{i}]) went {} -> {}", b0[i], b1[i]
                            );
                        }
                    }
                    check_price_monotone(step, op, a0, t0, a1, t1)?;
                    prop_assert!(
                        f.instance_ttl() >= BUMP_THRESHOLD,
                        "N1 broken at step {step}: instance TTL is {} after a successful \
                         deposit, expected >= {BUMP_THRESHOLD}", f.instance_ttl()
                    );
                }

                Outcome::WithdrawOk { actor, shares, amount } => {
                    let expected_amount = if t0 == 0 { 0 } else { shares.saturating_mul(a0) / t0 };
                    prop_assert!(
                        *amount == expected_amount,
                        "withdraw at step {step}: paid out {amount}, harness expected \
                         {expected_amount} (shares = {shares}, A0 = {a0}, T0 = {t0})"
                    );
                    prop_assert!(
                        t1 == t0 - *shares,
                        "I1/withdraw at step {step}: T went {t0} -> {t1}, expected {}",
                        t0 - *shares
                    );
                    prop_assert!(
                        b1[*actor] == b0[*actor] - *shares,
                        "I1/withdraw at step {step}: B(pool[{actor}]) went {} -> {}, \
                         expected {}", b0[*actor], b1[*actor], b0[*actor] - *shares
                    );
                    prop_assert!(
                        a1 == a0 - *amount,
                        "withdraw at step {step}: A went {a0} -> {a1}, expected {}",
                        a0 - *amount
                    );
                    for i in 0..POOL_SIZE {
                        if i != *actor {
                            prop_assert!(
                                b1[i] == b0[i],
                                "withdraw at step {step} moved an unrelated balance: \
                                 B(pool[{i}]) went {} -> {}", b0[i], b1[i]
                            );
                        }
                    }
                    check_price_monotone(step, op, a0, t0, a1, t1)?;
                    prop_assert!(
                        f.instance_ttl() >= BUMP_THRESHOLD,
                        "N1 broken at step {step}: instance TTL is {} after a successful \
                         withdraw, expected >= {BUMP_THRESHOLD}", f.instance_ttl()
                    );
                }

                // ── I8 ───────────────────────────────────────────────────────
                Outcome::TransferOk { from, to, shares } => {
                    prop_assert!(
                        t1 == t0,
                        "I8 broken at step {step}: transfer_shares changed T from {t0} to {t1}"
                    );
                    if from == to {
                        prop_assert!(
                            b1[*from] == b0[*from],
                            "I8 broken at step {step}: self-transfer of {shares} changed \
                             B(pool[{from}]) from {} to {}", b0[*from], b1[*from]
                        );
                    } else {
                        prop_assert!(
                            b1[*from] == b0[*from] - *shares,
                            "I8 broken at step {step}: B(from = pool[{from}]) went {} -> {}, \
                             expected {} (shares = {shares})",
                            b0[*from], b1[*from], b0[*from] - *shares
                        );
                        prop_assert!(
                            b1[*to] == b0[*to] + *shares,
                            "I8 broken at step {step}: B(to = pool[{to}]) went {} -> {}, \
                             expected {} (shares = {shares})",
                            b0[*to], b1[*to], b0[*to] + *shares
                        );
                    }
                    for i in 0..POOL_SIZE {
                        if i != *from && i != *to {
                            prop_assert!(
                                b1[i] == b0[i],
                                "I8 broken at step {step}: transfer moved an unrelated \
                                 balance B(pool[{i}]) from {} to {}", b0[i], b1[i]
                            );
                        }
                    }
                    prop_assert!(
                        a1 == a0,
                        "transfer_shares at step {step} changed A from {a0} to {a1}"
                    );
                    // N1 note: transfer_shares reaches no bumping path. That
                    // asymmetry is recorded, not asserted.
                }

                Outcome::SetAdminOk { .. } => {
                    prop_assert!(
                        t1 == t0 && b1 == b0 && paused1 == paused0,
                        "set_admin at step {step} perturbed value state: T {t0} -> {t1}, \
                         balances {b0:?} -> {b1:?}, paused {paused0} -> {paused1}"
                    );
                    prop_assert!(
                        f.instance_ttl() >= BUMP_THRESHOLD,
                        "N1 broken at step {step}: instance TTL is {} after set_admin, \
                         expected >= {BUMP_THRESHOLD}", f.instance_ttl()
                    );
                }

                Outcome::PauseOk => {
                    prop_assert!(
                        paused1,
                        "I12 broken at step {step}: pause() returned Ok but is_paused() == false"
                    );
                    prop_assert!(
                        t1 == t0 && b1 == b0,
                        "pause at step {step} perturbed value state: T {t0} -> {t1}, \
                         balances {b0:?} -> {b1:?}"
                    );
                    prop_assert!(
                        f.instance_ttl() >= BUMP_THRESHOLD,
                        "N1 broken at step {step}: instance TTL is {} after pause, \
                         expected >= {BUMP_THRESHOLD}", f.instance_ttl()
                    );
                }

                // ── failed call: full rollback, and the *right* error ────────
                Outcome::VaultFailed { kind, err } => {
                    prop_assert!(
                        t1 == t0,
                        "rollback broken at step {step} ({op:?} failed with {err:?}): \
                         T went {t0} -> {t1}"
                    );
                    prop_assert!(
                        b1 == b0,
                        "rollback broken at step {step} ({op:?} failed with {err:?}): \
                         balances went {b0:?} -> {b1:?}"
                    );
                    prop_assert!(
                        paused1 == paused0,
                        "rollback broken at step {step} ({op:?} failed with {err:?}): \
                         is_paused() went {paused0} -> {paused1}"
                    );
                    prop_assert!(
                        a1 == a0,
                        "rollback broken at step {step} ({op:?} failed with {err:?}): \
                         A went {a0} -> {a1}"
                    );
                    if paused0
                        && matches!(kind, MutKind::Deposit | MutKind::Withdraw | MutKind::Transfer)
                    {
                        prop_assert!(
                            matches!(err, Ok(VaultError::Paused)),
                            "I12(b) broken at step {step}: while paused, {kind:?} aborted \
                             with {err:?}; the only acceptable error is Paused"
                        );
                    }
                    if matches!(kind, MutKind::SetAdmin | MutKind::Pause) {
                        prop_assert!(
                            false,
                            "I12(b) broken at step {step}: {kind:?} must remain callable \
                             (paused = {paused0}) but aborted with {err:?}"
                        );
                    }
                }

                Outcome::DonateOk { amount } => {
                    prop_assert!(
                        a1 == a0 + *amount,
                        "donation at step {step}: A went {a0} -> {a1}, expected {}",
                        a0 + *amount
                    );
                    prop_assert!(
                        t1 == t0 && b1 == b0,
                        "donation at step {step} changed vault bookkeeping: T {t0} -> {t1}, \
                         balances {b0:?} -> {b1:?}"
                    );
                }

                Outcome::DonateFailed => {
                    prop_assert!(
                        a1 == a0 && t1 == t0 && b1 == b0,
                        "failed donation at step {step} changed state: A {a0} -> {a1}, \
                         T {t0} -> {t1}, balances {b0:?} -> {b1:?}"
                    );
                }

                Outcome::Advanced => {
                    prop_assert!(
                        t1 == t0 && b1 == b0 && paused1 == paused0,
                        "a ledger advance at step {step} changed observable state: \
                         T {t0} -> {t1}, balances {b0:?} -> {b1:?}, \
                         paused {paused0} -> {paused1}"
                    );
                }

                // ── N3: views are pure ───────────────────────────────────────
                Outcome::Views => {
                    prop_assert!(
                        t1 == t0 && b1 == b0 && paused1 == paused0 && admin1 == admin0,
                        "N3 broken at step {step}: repeated view calls changed state — \
                         T {t0} -> {t1}, balances {b0:?} -> {b1:?}, \
                         paused {paused0} -> {paused1}, admin {admin0:?} -> {admin1:?}"
                    );
                    prop_assert!(
                        a1 == a0,
                        "N3 broken at step {step}: view calls changed A from {a0} to {a1}"
                    );
                }
            }
        }
    }
}

/// **I3** — share price never falls across a single successful `deposit` or
/// `withdraw`: `A₁·T₀ ≥ A₀·T₁`, cross-multiplied to avoid division. Skipped
/// (not failed) when either product overflows, and when `T₀ == 0` where the
/// price is undefined.
fn check_price_monotone(
    step: usize,
    op: &Op,
    a0: i128,
    t0: i128,
    a1: i128,
    t1: i128,
) -> Result<(), TestCaseError> {
    if t0 <= 0 || t1 <= 0 {
        return Ok(());
    }
    match (a1.checked_mul(t0), a0.checked_mul(t1)) {
        (Some(lhs), Some(rhs)) => {
            prop_assert!(
                lhs >= rhs,
                "I3 broken at step {step} ({op:?}): share price fell — \
                 A1*T0 == {lhs} < A0*T1 == {rhs} (A0 = {a0}, T0 = {t0}, A1 = {a1}, T1 = {t1})"
            );
            Ok(())
        }
        // Overflow in the harness's own arithmetic: skip, do not fail.
        _ => Ok(()),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P2 — exact share accounting (I3, I1, N2 with a closed-form oracle)
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(64))]

    /// Invariants: **I3**, **I1**, **N2** — with an *exact* independently
    /// computed oracle rather than an inequality.
    ///
    /// Seeds the vault, optionally donates (inflating `A` without `T`, which is
    /// what makes `ZeroShares` reachable), then predicts the minted shares and
    /// the withdrawn amount in the harness and asserts equality — or, when the
    /// harness predicts a rejection, asserts that exact error and an unchanged
    /// state.
    #[test]
    fn prop_exact_share_accounting(
        seeder in idx(),
        depositor in idx(),
        d1 in 1i128..=1_000_000i128,
        d2 in amount_strategy(),
        donation in prop_oneof![3 => Just(0i128), 2 => 1i128..=5_000_000i128],
        w in amount_strategy(),
    ) {
        let f = Fixture::new();
        f.init_and_fund();

        // First deposit into an empty vault must mint 1:1.
        let s1 = f.vault().deposit(&f.pool[seeder], &d1);
        prop_assert!(
            s1 == d1,
            "first deposit into an empty vault minted {s1} shares for {d1} assets; \
             expected a 1:1 mint"
        );
        prop_assert!(
            f.vault().total_shares() == d1,
            "after the seed deposit T == {}, expected {d1}", f.vault().total_shares()
        );

        if donation > 0 {
            f.token().transfer(&f.pool[seeder], &f.vault_id, &donation);
        }

        // ── deposit arm ──────────────────────────────────────────────────────
        let t0 = f.vault().total_shares();
        let a0 = f.assets();
        let b0 = f.balances();
        prop_assert!(a0 > 0, "precondition: A must be positive here, got {a0}");

        // Independent oracle for the mint.
        let predicted: Option<i128> = if d2 <= 0 {
            None // must abort with InvalidAmount
        } else {
            d2.checked_mul(t0).map(|n| n / a0)
        };

        let r = f.vault().try_deposit(&f.pool[depositor], &d2);
        match (&r, predicted) {
            (Ok(Ok(shares)), Some(p)) => {
                prop_assert!(
                    p > 0,
                    "deposit({d2}) minted {shares} shares but the harness predicted {p} <= 0, \
                     which must abort with ZeroShares (A0 = {a0}, T0 = {t0})"
                );
                prop_assert!(
                    *shares == p,
                    "I3/deposit: minted {shares} shares, harness predicted {p} \
                     (amount = {d2}, T0 = {t0}, A0 = {a0})"
                );
                prop_assert!(
                    f.vault().total_shares() == t0 + p,
                    "I1/deposit: T == {} after minting {p}, expected {}",
                    f.vault().total_shares(), t0 + p
                );
                prop_assert!(
                    f.assets() == a0 + d2,
                    "deposit: A == {} after depositing {d2}, expected {}",
                    f.assets(), a0 + d2
                );
                prop_assert!(
                    f.assets() >= f.vault().total_shares(),
                    "N2 broken after deposit: A == {} < T == {}",
                    f.assets(), f.vault().total_shares()
                );
            }
            (Err(Ok(VaultError::InvalidAmount)), None) => {
                prop_assert!(
                    f.vault().total_shares() == t0 && f.balances() == b0 && f.assets() == a0,
                    "rejected deposit({d2}) still moved state"
                );
            }
            (Err(Ok(VaultError::ZeroShares)), Some(p)) => {
                prop_assert!(
                    p == 0,
                    "deposit({d2}) aborted with ZeroShares but the harness predicted {p} \
                     shares (T0 = {t0}, A0 = {a0})"
                );
                prop_assert!(
                    f.vault().total_shares() == t0 && f.balances() == b0 && f.assets() == a0,
                    "rejected deposit({d2}) still moved state"
                );
            }
            (Err(Ok(VaultError::Overflow)), None) => {
                // d2 * t0 overflowed i128 — the harness predicted the same.
                prop_assert!(
                    f.vault().total_shares() == t0 && f.balances() == b0 && f.assets() == a0,
                    "overflowing deposit({d2}) still moved state"
                );
            }
            (Err(Err(_)), _) => {
                // Token-side rejection (e.g. insufficient underlying balance for
                // an extreme operand). Still must be a clean rollback.
                prop_assert!(
                    f.vault().total_shares() == t0 && f.balances() == b0 && f.assets() == a0,
                    "host-level abort on deposit({d2}) still moved state: \
                     T {t0} -> {}, A {a0} -> {}",
                    f.vault().total_shares(), f.assets()
                );
            }
            (res, pred) => {
                prop_assert!(
                    false,
                    "deposit({d2}) returned {res:?} but the harness predicted {pred:?} \
                     (T0 = {t0}, A0 = {a0})"
                );
            }
        }

        // ── withdraw arm ─────────────────────────────────────────────────────
        let t2 = f.vault().total_shares();
        let a2 = f.assets();
        let b2 = f.balances();
        let holder = depositor;
        let held = b2[holder];

        let expected_err: Option<VaultError> = if w <= 0 {
            Some(VaultError::InvalidAmount)
        } else if held < w {
            Some(VaultError::InsufficientBalance)
        } else {
            None
        };

        let rw = f.vault().try_withdraw(&f.pool[holder], &w);
        match (&rw, expected_err) {
            (Ok(Ok(amount)), None) => {
                let predicted_amount = if t2 == 0 { 0 } else { w.saturating_mul(a2) / t2 };
                prop_assert!(
                    *amount == predicted_amount,
                    "withdraw({w}) paid {amount}, harness predicted {predicted_amount} \
                     (A = {a2}, T = {t2}, held = {held})"
                );
                prop_assert!(
                    f.vault().total_shares() == t2 - w,
                    "I1/withdraw: T == {} after burning {w}, expected {}",
                    f.vault().total_shares(), t2 - w
                );
                prop_assert!(
                    f.vault().balance_of(&f.pool[holder]) == held - w,
                    "I1/withdraw: B(holder) == {} after burning {w}, expected {}",
                    f.vault().balance_of(&f.pool[holder]), held - w
                );
                prop_assert!(
                    f.assets() == a2 - predicted_amount,
                    "withdraw: A == {} , expected {}", f.assets(), a2 - predicted_amount
                );
                prop_assert!(
                    f.assets() >= f.vault().total_shares(),
                    "N2 broken after withdraw: A == {} < T == {}",
                    f.assets(), f.vault().total_shares()
                );
                check_price_monotone(
                    0,
                    &Op::Withdraw { actor: holder, shares: w },
                    a2,
                    t2,
                    f.assets(),
                    f.vault().total_shares(),
                )?;
            }
            (Err(Ok(e)), Some(expected)) => {
                prop_assert!(
                    *e == expected,
                    "withdraw({w}) aborted with {e:?}, harness predicted {expected:?} \
                     (held = {held}, T = {t2}, A = {a2})"
                );
                prop_assert!(
                    f.vault().total_shares() == t2 && f.balances() == b2 && f.assets() == a2,
                    "rejected withdraw({w}) still moved state"
                );
            }
            (res, pred) => {
                prop_assert!(
                    false,
                    "withdraw({w}) returned {res:?} but the harness predicted {pred:?} \
                     (held = {held}, T = {t2}, A = {a2})"
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P3 — I8, with an exact error oracle
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(64))]

    /// Invariant **I8** — `transfer_shares` conserves `T`; moves exactly
    /// `shares` when `from != to`; is a no-op on balances when `from == to`.
    /// The `from == to` case is *forced* by `pair_strategy`.
    ///
    /// Because the vault is unpaused and `mock_all_auths` is on, the harness can
    /// predict the exact rejection reason, so a rejection is asserted against a
    /// closed-form oracle rather than "some error".
    #[test]
    fn prop_i8_transfer_shares(
        seeder in idx(),
        (from, to) in pair_strategy(),
        seed in 1i128..=1_000_000i128,
        seed2 in 1i128..=1_000_000i128,
        shares in amount_strategy(),
    ) {
        let f = Fixture::new();
        f.init_and_fund();

        f.vault().deposit(&f.pool[seeder], &seed);
        f.vault().deposit(&f.pool[from], &seed2);

        let t0 = f.vault().total_shares();
        let b0 = f.balances();
        let a0 = f.assets();

        let expected_err: Option<VaultError> = if shares <= 0 {
            Some(VaultError::InvalidAmount)
        } else if b0[from] < shares {
            Some(VaultError::InsufficientBalance)
        } else {
            None
        };

        let r = f
            .vault()
            .try_transfer_shares(&f.pool[from], &f.pool[to], &shares);

        let t1 = f.vault().total_shares();
        let b1 = f.balances();

        match (&r, expected_err) {
            (Ok(Ok(())), None) => {
                prop_assert!(
                    t1 == t0,
                    "I8 broken: transfer_shares(pool[{from}], pool[{to}], {shares}) changed \
                     T from {t0} to {t1}"
                );
                if from == to {
                    prop_assert!(
                        b1[from] == b0[from],
                        "I8 broken: self-transfer of {shares} changed B(pool[{from}]) from {} \
                         to {}", b0[from], b1[from]
                    );
                } else {
                    prop_assert!(
                        b1[from] == b0[from] - shares,
                        "I8 broken: B(from = pool[{from}]) went {} -> {}, expected {}",
                        b0[from], b1[from], b0[from] - shares
                    );
                    prop_assert!(
                        b1[to] == b0[to] + shares,
                        "I8 broken: B(to = pool[{to}]) went {} -> {}, expected {}",
                        b0[to], b1[to], b0[to] + shares
                    );
                }
                for i in 0..POOL_SIZE {
                    if i != from && i != to {
                        prop_assert!(
                            b1[i] == b0[i],
                            "I8 broken: unrelated B(pool[{i}]) went {} -> {}", b0[i], b1[i]
                        );
                    }
                }
                prop_assert!(
                    f.assets() == a0,
                    "I8: transfer_shares changed A from {a0} to {}", f.assets()
                );
                // I10' for the *recipient*: `to` may be a first-time writer.
                if from != to && b0[to] == 0 {
                    let ttl = f.balance_ttl(&f.pool[to]);
                    prop_assert!(
                        ttl.is_some_and(|v| v >= BUMP_AMOUNT),
                        "I10' broken: after the first write to B(pool[{to}]) the persistent \
                         TTL is {ttl:?}, expected >= {BUMP_AMOUNT}"
                    );
                }
            }
            (Err(Ok(e)), Some(expected)) => {
                prop_assert!(
                    *e == expected,
                    "I8/error oracle: transfer_shares(pool[{from}], pool[{to}], {shares}) \
                     aborted with {e:?}, harness predicted {expected:?} \
                     (B(from) = {}, T = {t0})", b0[from]
                );
                prop_assert!(
                    t1 == t0 && b1 == b0 && f.assets() == a0,
                    "I8: rejected transfer still moved state — T {t0} -> {t1}, \
                     balances {b0:?} -> {b1:?}"
                );
            }
            (res, pred) => {
                prop_assert!(
                    false,
                    "transfer_shares(pool[{from}], pool[{to}], {shares}) returned {res:?} \
                     but the harness predicted {pred:?} (B(from) = {}, T = {t0})", b0[from]
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P4 — I4, admin custody
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **I4** — `admin()` is constant across `deposit`, `withdraw`,
    /// `transfer_shares` and `pause`; it changes only via `set_admin`, and only
    /// when the incumbent authorized. `new_admin` authorization is deliberately
    /// *not* asserted.
    #[test]
    fn prop_i4_admin_custody(
        new_admin in idx(),
        actor in idx(),
        other in idx(),
        d in 1i128..=1_000_000i128,
        w in 1i128..=1_000_000i128,
        s in 1i128..=1_000i128,
    ) {
        let f = Fixture::new();
        f.init_and_fund();

        let admin0 = f.vault().admin();
        prop_assert!(
            admin0 == f.pool[0],
            "initialize(admin = pool[0]) but admin() == {admin0:?}"
        );

        // Ordinary operations must not touch the admin.
        f.vault().deposit(&f.pool[actor], &d);
        prop_assert!(
            f.vault().admin() == admin0,
            "I4 broken: deposit changed admin() from {admin0:?} to {:?}", f.vault().admin()
        );

        let _ = f.vault().try_withdraw(&f.pool[actor], &w.min(d));
        prop_assert!(
            f.vault().admin() == admin0,
            "I4 broken: withdraw changed admin() from {admin0:?} to {:?}", f.vault().admin()
        );

        let _ = f
            .vault()
            .try_transfer_shares(&f.pool[actor], &f.pool[other], &s);
        prop_assert!(
            f.vault().admin() == admin0,
            "I4 broken: transfer_shares changed admin() from {admin0:?} to {:?}",
            f.vault().admin()
        );

        // Handover by the incumbent (auth mocked) must land exactly.
        f.vault().set_admin(&f.pool[new_admin]);
        prop_assert!(
            f.vault().admin() == f.pool[new_admin],
            "I4 broken: after set_admin(pool[{new_admin}]) admin() == {:?}, expected {:?}",
            f.vault().admin(), f.pool[new_admin]
        );

        f.vault().pause();
        prop_assert!(
            f.vault().admin() == f.pool[new_admin],
            "I4 broken: pause changed admin() from {:?} to {:?}",
            f.pool[new_admin], f.vault().admin()
        );

        // Without the incumbent's authorization the handover must abort and the
        // admin must not budge.
        let before = f.vault().admin();
        let t_before = f.vault().total_shares();
        let b_before = f.balances();
        f.env.set_auths(&[]);
        let r = f.vault().try_set_admin(&f.pool[actor]);
        prop_assert!(
            matches!(r, Err(Err(InvokeError::Abort))),
            "I4 broken: set_admin under revoked auth returned {r:?}; expected a host-level \
             auth abort"
        );
        prop_assert!(
            f.vault().admin() == before,
            "I4 broken: unauthorized set_admin still moved admin() from {before:?} to {:?}",
            f.vault().admin()
        );
        prop_assert!(
            f.vault().total_shares() == t_before && f.balances() == b_before,
            "unauthorized set_admin perturbed value state: T {t_before} -> {}, \
             balances {b_before:?} -> {:?}",
            f.vault().total_shares(), f.balances()
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P5 — I5, the no-auth arm
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **I5** — `B(a)` decreases only inside a call that `a`
    /// authorized. This is the dedicated revoked-auth arm: the main loop runs
    /// under `mock_all_auths` and therefore cannot observe it.
    ///
    /// `a` is a *pool* principal, not a freshly generated address: otherwise the
    /// property degenerates into "an unknown caller is rejected".
    #[test]
    fn prop_i5_no_auth_cannot_decrease_balance(
        holder in idx(),
        counterparty in idx(),
        seed in 1i128..=1_000_000i128,
        shares in amount_strategy(),
        which in 0usize..2,
    ) {
        let f = Fixture::new();
        f.init_and_fund();
        f.vault().deposit(&f.pool[holder], &seed);

        let t0 = f.vault().total_shares();
        let b0 = f.balances();
        let a0 = f.assets();
        prop_assert!(b0[holder] > 0, "precondition: holder must own shares, got {}", b0[holder]);

        // Revoke all authorization for the next invocation.
        f.env.set_auths(&[]);

        let r: Result<Result<(), ()>, VErr> = if which == 0 {
            match f.vault().try_withdraw(&f.pool[holder], &shares) {
                Ok(Ok(_)) => Ok(Ok(())),
                Ok(Err(_)) => Err(Err(InvokeError::Abort)),
                Err(e) => Err(e),
            }
        } else {
            match f
                .vault()
                .try_transfer_shares(&f.pool[holder], &f.pool[counterparty], &shares)
            {
                Ok(Ok(())) => Ok(Ok(())),
                Ok(Err(_)) => Err(Err(InvokeError::Abort)),
                Err(e) => Err(e),
            }
        };

        // `require_auth` is the *first* statement of both entry points, so the
        // abort must be a host auth abort — not Paused, not InvalidAmount, not
        // InsufficientBalance. A contract-level error here would mean the call
        // was rejected for an unrelated reason.
        prop_assert!(
            matches!(r, Err(Err(InvokeError::Abort))),
            "I5 broken: with auth revoked, {} returned {r:?}; expected a host-level auth \
             abort (a VaultError here would mean the call was rejected for the wrong reason)",
            if which == 0 { "withdraw" } else { "transfer_shares" }
        );

        let b1 = f.balances();
        prop_assert!(
            f.vault().total_shares() == t0,
            "I5 broken: unauthorized call changed T from {t0} to {}", f.vault().total_shares()
        );
        prop_assert!(
            b1[holder] == b0[holder],
            "I5 broken: unauthorized call changed B(holder = pool[{holder}]) from {} to {}",
            b0[holder], b1[holder]
        );
        prop_assert!(
            b1[counterparty] == b0[counterparty],
            "I5 broken: unauthorized call changed B(to = pool[{counterparty}]) from {} to {}",
            b0[counterparty], b1[counterparty]
        );
        prop_assert!(
            b1 == b0,
            "I5 broken: unauthorized call changed the balance vector {b0:?} -> {b1:?}"
        );
        prop_assert!(
            f.assets() == a0,
            "I5 broken: unauthorized call moved underlying tokens, A {a0} -> {}", f.assets()
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P6 — I9, re-initialization
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **I9** — while initialized, every further `initialize` fails
    /// with `AlreadyInitialized` and leaves `admin()`, `is_paused()` and `T`
    /// unchanged.
    ///
    /// The `admin'` / `token'` arguments are freshly generated addresses: here an
    /// address is *data*, not an actor, so the fixed-pool rule does not apply.
    #[test]
    fn prop_i9_reinitialize_rejected(
        actor in idx(),
        deposit in 1i128..=1_000_000i128,
        handover in idx(),
        do_pause in any::<bool>(),
        attempts in 1usize..4,
    ) {
        let f = Fixture::new();
        f.init_and_fund();
        f.vault().deposit(&f.pool[actor], &deposit);
        f.vault().set_admin(&f.pool[handover]);
        if do_pause {
            f.vault().pause();
        }

        let admin0 = f.vault().admin();
        let paused0 = f.vault().is_paused();
        let t0 = f.vault().total_shares();
        let b0 = f.balances();

        for n in 0..attempts {
            let rogue_admin = Address::generate(&f.env);
            let rogue_token = Address::generate(&f.env);
            let r = f.vault().try_initialize(&rogue_admin, &rogue_token);

            prop_assert!(
                matches!(r, Err(Ok(VaultError::AlreadyInitialized))),
                "I9 broken on attempt {n}: initialize on an initialized vault returned \
                 {r:?}, expected Err(Ok(AlreadyInitialized))"
            );
            prop_assert!(
                f.vault().admin() == admin0,
                "I9 broken on attempt {n}: admin() moved from {admin0:?} to {:?}",
                f.vault().admin()
            );
            prop_assert!(
                f.vault().is_paused() == paused0,
                "I9 broken on attempt {n}: is_paused() moved from {paused0} to {}",
                f.vault().is_paused()
            );
            prop_assert!(
                f.vault().total_shares() == t0,
                "I9 broken on attempt {n}: T moved from {t0} to {}", f.vault().total_shares()
            );
            prop_assert!(
                f.balances() == b0,
                "I9 broken on attempt {n}: balances moved from {b0:?} to {:?}", f.balances()
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P7 — I10', persistent balance TTL
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **I10'** — immediately after a call that writes `a`'s balance
    /// *for the first time*, the remaining TTL of the persistent `Balance(a)`
    /// entry is at least `BUMP_AMOUNT`.
    ///
    /// Only *first* writes are asserted. On a repeated write the remaining TTL
    /// still exceeds `BUMP_THRESHOLD`, so `extend_ttl` is legitimately a no-op
    /// and the TTL has decayed by however many ledgers elapsed — asserting
    /// there would be asserting a false property.
    ///
    /// The ledger floors are pinned in `Fixture::new` (`min_persistent_entry_ttl
    /// = 16`); under the host's 4096 default this property would pass even if
    /// `extend_ttl` never fired for small bumps.
    #[test]
    fn prop_i10_balance_ttl_on_first_write(
        a in idx(),
        b in idx(),
        d1 in 1i128..=1_000_000i128,
        gap in 0u32..=400_000u32,
        moved in 1i128..=1_000i128,
    ) {
        prop_assume!(a != b);

        let f = Fixture::new();
        f.init_and_fund();

        prop_assert!(
            f.balance_ttl(&f.pool[a]).is_none(),
            "precondition: Balance(pool[{a}]) should not exist before the first write"
        );

        // First write to `a`'s balance.
        f.vault().deposit(&f.pool[a], &d1);
        let ttl_a = f.balance_ttl(&f.pool[a]);
        prop_assert!(
            ttl_a.is_some(),
            "I10' broken: deposit wrote no persistent Balance(pool[{a}]) entry"
        );
        prop_assert!(
            ttl_a.unwrap() >= BUMP_AMOUNT,
            "I10' broken: after the first write of B(pool[{a}]) the persistent TTL is {}, \
             expected >= BUMP_AMOUNT == {BUMP_AMOUNT} (seq = {}, floors pinned at \
             min_persistent_entry_ttl = {MIN_PERSISTENT_TTL})",
            ttl_a.unwrap(), f.seq()
        );

        // Let time pass, then make the *first* write to `b`'s balance.
        f.advance(gap);
        prop_assert!(
            f.balance_ttl(&f.pool[b]).is_none(),
            "precondition: Balance(pool[{b}]) should not exist before the first write"
        );

        let shares_a = f.vault().balance_of(&f.pool[a]);
        let to_move = moved.min(shares_a);
        prop_assume!(to_move > 0);
        f.vault()
            .transfer_shares(&f.pool[a], &f.pool[b], &to_move);

        let ttl_b = f.balance_ttl(&f.pool[b]);
        prop_assert!(
            ttl_b.is_some(),
            "I10' broken: transfer_shares wrote no persistent Balance(pool[{b}]) entry"
        );
        prop_assert!(
            ttl_b.unwrap() >= BUMP_AMOUNT,
            "I10' broken: after the first write of B(pool[{b}]) at seq {} the persistent TTL \
             is {}, expected >= BUMP_AMOUNT == {BUMP_AMOUNT}",
            f.seq(), ttl_b.unwrap()
        );
        // `a`'s entry is deliberately NOT asserted here: that was a repeated
        // write in which extend_ttl is a legitimate no-op.
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P8 — N1, instance TTL
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **N1** — after any successful `initialize`, `deposit`,
    /// `withdraw`, `set_admin` or `pause`, the instance entry's remaining TTL is
    /// at least `BUMP_THRESHOLD`.
    ///
    /// `transfer_shares` reaches no bumping path. That asymmetry is a recorded
    /// observation, not an assertion — it is checked below only to the extent
    /// that it must not *shorten* anything, which it cannot.
    #[test]
    fn prop_n1_instance_ttl(
        actor in idx(),
        other in idx(),
        d in 1i128..=1_000_000i128,
        gap1 in 0u32..=200_000u32,
        gap2 in 0u32..=200_000u32,
        new_admin in idx(),
    ) {
        let f = Fixture::new();
        f.init_and_fund();
        prop_assert!(
            f.instance_ttl() >= BUMP_THRESHOLD,
            "N1 broken after initialize: instance TTL is {}, expected >= {BUMP_THRESHOLD}",
            f.instance_ttl()
        );

        f.advance(gap1);
        f.vault().deposit(&f.pool[actor], &d);
        prop_assert!(
            f.instance_ttl() >= BUMP_THRESHOLD,
            "N1 broken after deposit at seq {}: instance TTL is {}, expected >= \
             {BUMP_THRESHOLD}", f.seq(), f.instance_ttl()
        );

        f.advance(gap2);
        let held = f.vault().balance_of(&f.pool[actor]);
        prop_assume!(held > 0);
        f.vault().withdraw(&f.pool[actor], &held);
        prop_assert!(
            f.instance_ttl() >= BUMP_THRESHOLD,
            "N1 broken after withdraw at seq {}: instance TTL is {}, expected >= \
             {BUMP_THRESHOLD}", f.seq(), f.instance_ttl()
        );

        // transfer_shares: recorded, not asserted (no bumping path).
        let _ = f
            .vault()
            .try_transfer_shares(&f.pool[actor], &f.pool[other], &1i128);

        f.vault().set_admin(&f.pool[new_admin]);
        prop_assert!(
            f.instance_ttl() >= BUMP_THRESHOLD,
            "N1 broken after set_admin at seq {}: instance TTL is {}, expected >= \
             {BUMP_THRESHOLD}", f.seq(), f.instance_ttl()
        );

        f.vault().pause();
        prop_assert!(
            f.instance_ttl() >= BUMP_THRESHOLD,
            "N1 broken after pause at seq {}: instance TTL is {}, expected >= \
             {BUMP_THRESHOLD}", f.seq(), f.instance_ttl()
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P9 — I11, temporary-tier non-interference (differential)
// ─────────────────────────────────────────────────────────────────────────────

/// One quiescent observation. Deliberately contains no `Address` values: the two
/// runs use two independent `Env`s, so principals are compared by pool index.
#[derive(Debug, PartialEq, Eq)]
struct Obs {
    t: i128,
    balances: Vec<i128>,
    admin_idx: Option<usize>,
    paused: bool,
    assets: i128,
    tag: String,
}

fn observe(f: &Fixture, out: &Outcome) -> Obs {
    Obs {
        t: f.vault().total_shares(),
        balances: f.balances(),
        admin_idx: f.admin_idx(),
        paused: f.vault().is_paused(),
        assets: f.assets(),
        tag: out.tag(),
    }
}

proptest! {
    #![proptest_config(cfg(32))]

    /// Invariant **I11** — the value of `last_activity(a)`, including its being
    /// absent, has no effect on any other entry point.
    ///
    /// Differential: the same operation sequence is run twice. Run B advances the
    /// ledger past `TEMP_TTL` before every operation, so every temporary entry
    /// has lapsed by the time the next call reads state. Every observable other
    /// than `last_activity` itself must match, step for step.
    #[test]
    fn prop_i11_temporary_tier_non_interference(
        ops in prop::collection::vec(mutating_op_strategy(), 1..7)
    ) {
        // ── run A: no ledger advance, temp entries always live ───────────────
        let fa = Fixture::new();
        fa.init_and_fund();
        let mut trace_a = Vec::new();
        for op in &ops {
            let out = fa.apply(op);
            // Positive control: the temp entry really is written on success.
            match &out {
                Outcome::DepositOk { actor, .. } | Outcome::WithdrawOk { actor, .. } => {
                    let la = fa.vault().last_activity(&fa.pool[*actor]);
                    prop_assert!(
                        la == Some(fa.seq()),
                        "run A: last_activity(pool[{actor}]) == {la:?} after a successful \
                         {op:?}, expected Some({})", fa.seq()
                    );
                }
                Outcome::TransferOk { from, .. } => {
                    let la = fa.vault().last_activity(&fa.pool[*from]);
                    prop_assert!(
                        la == Some(fa.seq()),
                        "run A: last_activity(pool[{from}]) == {la:?} after a successful \
                         transfer, expected Some({})", fa.seq()
                    );
                }
                _ => {}
            }
            trace_a.push(observe(&fa, &out));
        }

        // ── run B: every temporary entry lapses between operations ───────────
        let fb = Fixture::new();
        fb.init_and_fund();
        let mut trace_b = Vec::new();
        for (step, op) in ops.iter().enumerate() {
            fb.advance(TEMP_TTL + 1);
            // Positive control: the differential arm is actually exercising the
            // lapsed-entry case.
            for i in 0..POOL_SIZE {
                let la = fb.vault().last_activity(&fb.pool[i]);
                prop_assert!(
                    la.is_none(),
                    "run B, step {step}: last_activity(pool[{i}]) == {la:?} after advancing \
                     {} ledgers; the temporary entry should have lapsed (TEMP_TTL = \
                     {TEMP_TTL}, min_temp_entry_ttl pinned to {MIN_TEMP_TTL})",
                    TEMP_TTL + 1
                );
            }
            let out = fb.apply(op);
            trace_b.push(observe(&fb, &out));
        }

        prop_assert!(
            trace_a.len() == trace_b.len(),
            "I11: trace lengths differ ({} vs {})", trace_a.len(), trace_b.len()
        );
        for (step, (oa, ob)) in trace_a.iter().zip(trace_b.iter()).enumerate() {
            prop_assert!(
                oa == ob,
                "I11 broken at step {step} ({:?}): observables diverge when the temporary \
                 tier lapses.\n  live-temp run : {oa:?}\n  lapsed-temp run: {ob:?}",
                ops[step]
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P10 — I12, pause semantics
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **I12** — (a) `is_paused()` never goes `true -> false`;
    /// (b) while paused, `deposit`, `withdraw` and `transfer_shares` each abort
    /// with exactly `VaultError::Paused` and leave `T` and every `B(a)`
    /// unchanged, while `set_admin` and `pause` remain callable and `pause` is
    /// idempotent.
    #[test]
    fn prop_i12_pause_semantics(
        actor in idx(),
        other in idx(),
        new_admin in idx(),
        seed in 1i128..=1_000_000i128,
        dep in amount_strategy(),
        wit in amount_strategy(),
        mov in amount_strategy(),
        extra_pauses in 1usize..4,
        gap in 0u32..=100_000u32,
    ) {
        let f = Fixture::new();
        f.init_and_fund();
        f.vault().deposit(&f.pool[actor], &seed);

        prop_assert!(!f.vault().is_paused(), "a fresh vault must not be paused");

        f.vault().pause();
        prop_assert!(f.vault().is_paused(), "I12: pause() did not set is_paused()");

        let t0 = f.vault().total_shares();
        let b0 = f.balances();
        let a0 = f.assets();
        let admin0 = f.vault().admin();

        // (b) the three mutators must abort with exactly Paused.
        let rd = f.vault().try_deposit(&f.pool[actor], &dep);
        prop_assert!(
            matches!(rd, Err(Ok(VaultError::Paused))),
            "I12(b) broken: deposit({dep}) while paused returned {rd:?}, expected \
             Err(Ok(Paused))"
        );

        let rw = f.vault().try_withdraw(&f.pool[actor], &wit);
        prop_assert!(
            matches!(rw, Err(Ok(VaultError::Paused))),
            "I12(b) broken: withdraw({wit}) while paused returned {rw:?}, expected \
             Err(Ok(Paused))"
        );

        let rt = f
            .vault()
            .try_transfer_shares(&f.pool[actor], &f.pool[other], &mov);
        prop_assert!(
            matches!(rt, Err(Ok(VaultError::Paused))),
            "I12(b) broken: transfer_shares({mov}) while paused returned {rt:?}, expected \
             Err(Ok(Paused))"
        );

        prop_assert!(
            f.vault().total_shares() == t0,
            "I12(b) broken: T moved from {t0} to {} while paused", f.vault().total_shares()
        );
        prop_assert!(
            f.balances() == b0,
            "I12(b) broken: balances moved from {b0:?} to {:?} while paused", f.balances()
        );
        prop_assert!(
            f.assets() == a0,
            "I12(b) broken: A moved from {a0} to {} while paused", f.assets()
        );

        // pause is idempotent and set_admin stays callable.
        for n in 0..extra_pauses {
            f.advance(gap);
            f.vault().pause();
            prop_assert!(
                f.vault().is_paused(),
                "I12(a) broken: pause #{n} cleared is_paused()"
            );
            prop_assert!(
                f.vault().total_shares() == t0 && f.balances() == b0,
                "I12: repeated pause #{n} perturbed value state — T {t0} -> {}, \
                 balances {b0:?} -> {:?}", f.vault().total_shares(), f.balances()
            );
        }

        f.vault().set_admin(&f.pool[new_admin]);
        prop_assert!(
            f.vault().admin() == f.pool[new_admin],
            "I12: set_admin must remain callable while paused; admin() == {:?}, expected {:?} \
             (was {admin0:?})", f.vault().admin(), f.pool[new_admin]
        );
        prop_assert!(
            f.vault().is_paused(),
            "I12(a) broken: set_admin cleared is_paused()"
        );
        prop_assert!(
            f.vault().total_shares() == t0 && f.balances() == b0,
            "I12: set_admin while paused perturbed value state"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P11 — N3, view purity under interleaving
// ─────────────────────────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(cfg(48))]

    /// Invariant **N3** — `total_shares`, `balance_of`, `admin`, `is_paused` and
    /// `last_activity` are pure: calling them any number of times in any order
    /// leaves `T`, every `B(a)`, `admin()` and `is_paused()` unchanged. Also
    /// asserts that repeated calls are *self-consistent* (same answer each time),
    /// which is the observable form of "no hidden write".
    #[test]
    fn prop_n3_views_are_pure(
        actor in idx(),
        seed in 1i128..=1_000_000i128,
        do_pause in any::<bool>(),
        order in prop::collection::vec(0usize..5, 1..40),
        gap in 0u32..=100_000u32,
    ) {
        let f = Fixture::new();
        f.init_and_fund();
        f.vault().deposit(&f.pool[actor], &seed);
        if do_pause {
            f.vault().pause();
        }
        f.advance(gap);

        let t0 = f.vault().total_shares();
        let b0 = f.balances();
        let admin0 = f.vault().admin();
        let paused0 = f.vault().is_paused();
        let la0 = f.vault().last_activity(&f.pool[actor]);
        let assets0 = f.assets();

        for (n, which) in order.iter().enumerate() {
            match which {
                0 => prop_assert!(
                    f.vault().total_shares() == t0,
                    "N3 broken at view call {n}: total_shares() returned {}, expected {t0}",
                    f.vault().total_shares()
                ),
                1 => prop_assert!(
                    f.vault().balance_of(&f.pool[actor]) == b0[actor],
                    "N3 broken at view call {n}: balance_of(pool[{actor}]) returned {}, \
                     expected {}", f.vault().balance_of(&f.pool[actor]), b0[actor]
                ),
                2 => prop_assert!(
                    f.vault().admin() == admin0,
                    "N3 broken at view call {n}: admin() returned {:?}, expected {admin0:?}",
                    f.vault().admin()
                ),
                3 => prop_assert!(
                    f.vault().is_paused() == paused0,
                    "N3 broken at view call {n}: is_paused() returned {}, expected {paused0}",
                    f.vault().is_paused()
                ),
                _ => prop_assert!(
                    f.vault().last_activity(&f.pool[actor]) == la0,
                    "N3 broken at view call {n}: last_activity(pool[{actor}]) returned {:?}, \
                     expected {la0:?}", f.vault().last_activity(&f.pool[actor])
                ),
            }
        }

        prop_assert!(
            f.vault().total_shares() == t0,
            "N3 broken: T moved from {t0} to {} across {} view calls",
            f.vault().total_shares(), order.len()
        );
        prop_assert!(
            f.balances() == b0,
            "N3 broken: balances moved from {b0:?} to {:?} across view calls", f.balances()
        );
        prop_assert!(
            f.vault().admin() == admin0,
            "N3 broken: admin() moved from {admin0:?} to {:?} across view calls",
            f.vault().admin()
        );
        prop_assert!(
            f.vault().is_paused() == paused0,
            "N3 broken: is_paused() moved from {paused0} to {} across view calls",
            f.vault().is_paused()
        );
        prop_assert!(
            f.assets() == assets0,
            "N3 broken: A moved from {assets0} to {} across view calls", f.assets()
        );
        // I6 / N2 still hold at this quiescent point.
        prop_assert!(t0 >= 0, "I6 broken: T == {t0} < 0");
        prop_assert!(
            assets0 >= t0,
            "N2 broken at a quiescent point: A == {assets0} < T == {t0}"
        );
    }
}
```

## Assumptions I could not verify

1. **Auth failure maps to `Err(Err(InvokeError::Abort))`.** `require_auth` failure under
   `env.set_auths(&[])` raises a host `Auth`-category error, not a contract error, so the
   generated `try_*` should surface it as `Err(Err(InvokeError::Abort))` rather than
   `Err(Err(InvokeError::Contract(_)))`. This is asserted literally in P4 and P5. If the host
   instead reports a `Contract(code)` variant, those two `matches!` arms need widening to
   `Err(Err(_))` — but **not** to `Err(_)`, because `Err(Ok(VaultError::…))` must stay a
   failure (it would mean the call was rejected for an unrelated reason).
2. **`InvokeError` is re-exported at `soroban_sdk::InvokeError`.** If it is not, it lives at
   `soroban_sdk::xdr`-adjacent paths in some versions; adjust the import.
3. **`env.register_stellar_asset_contract_v2(admin)` returns a value with `.address()`.**
   Taken from the prompt; the exact struct name is not referenced in the file.
4. **`env.register(Vault, ())`** — the two-argument form with `()` constructor args.
5. **`soroban_sdk::testutils::storage::Persistent` exposes both `has` and `get_ttl`.**
   `get_ttl` panics on a missing key in the implementations I know, so `Fixture::balance_ttl`
   gates on `has` first. If `has` is not on the testutils trait, it is on the ordinary
   `storage().persistent()` API inside `as_contract`, which is what is being called here.
6. **`get_ttl` returns *remaining* TTL (`live_until_ledger - current_sequence`)**, not the
   absolute live-until ledger. Every TTL assertion (`>= BUMP_AMOUNT`, `>= BUMP_THRESHOLD`)
   depends on this reading. If it returns the absolute ledger, the comparisons must become
   `ttl >= seq + BUMP_AMOUNT`.
7. **`LedgerInfo` field names** `sequence_number`, `timestamp`, `min_persistent_entry_ttl`,
   `min_temp_entry_ttl`, `max_entry_ttl`.
8. **`TokenClient::try_transfer` exists**; only `matches!(r, Ok(Ok(())))` is used, so its exact
   error type never needs naming.
9. **`prop_assert!` supports inline `{name}` format captures** (Rust 2021 captured
   identifiers). It expands to `format!`, so this should hold; if the crate's macro predates it,
   the messages need positional arguments.
10. **`Option::is_some_and`** (used once in P3) requires Rust 1.70+.
11. **`proptest-arbitrary-interop` / `arbitrary` are unused.** Every generator here is a native
    proptest strategy; `arb::<i128>()` would add nothing over `any::<i128>()` and the
    `SorobanArbitrary` path is not needed because principals come from a pool rather than from
    fuzzed bytes.
12. **Entry-expiry margins.** The sequence property advances at most `14 × 20_000 = 280_000`
    ledgers and I11 at most `6 × 17_281 ≈ 104_000`, both chosen to stay below the Stellar asset
    contract's own balance-bump amount (~518_400) so that the *token's* entries cannot lapse
    mid-run and masquerade as a vault bug. If the SAC in this SDK version bumps by less, these
    bounds must come down.
13. **`Address::generate` produces deterministic, pool-order-stable addresses** within an `Env`.
    I11 does not rely on this (it compares pool *indices*, never addresses), but P4/P9 assume
    `pool[0]` is a stable distinct principal.

## Invariants I could not express as a property, and why

Every curated invariant (I1, I3, I4, I5, I6, I8, I9, I10′, I11, I12, N1, N2, N3) is asserted by
at least one property. The following are expressed **more weakly than the prose**, and the gap is
stated rather than papered over:

- **I1 — `H` is the pool, not "every address".** The contract exposes no enumeration of share
  holders, so `Σ_{a∈H} B(a)` can only range over principals the harness itself drove. If the
  contract ever credited shares to an address outside the pool, `T == Σ B(a)` would break and be
  *caught* — but the converse leak (debiting an address outside the pool) is invisible. This is
  inherent to the public API.
- **I4 — "only when the *incumbent* admin authorized" is only half-observable.** Under
  `mock_all_auths` every `require_auth` succeeds, and there is no way to authorize *one specific*
  address while denying another through the public client surface used here (that needs
  `mock_auths` with explicit `MockAuth` entries, whose exact 26.1 shape I did not want to guess).
  P4 therefore asserts the two reachable endpoints: incumbent-authorized handover lands exactly,
  and *all-auth-revoked* handover aborts with the admin unmoved. The middle case — a *different*
  pool principal authorizing while the incumbent does not — is not covered. Flagged as the single
  biggest hole in this harness.
- **I5 — same limitation, same shape.** "Only `a` authorized" is tested as "nobody authorized".
  A contract that accepted *any* signer rather than specifically `a` would pass P5.
- **I10′ — only first writes.** Asserting the TTL floor after a *repeated* write would be
  asserting a false property (`extend_ttl` is a legitimate no-op above the threshold, so the TTL
  has decayed by the elapsed ledgers). The consequence is that a bug which bumps correctly on
  entry creation but silently stops bumping thereafter is **not** detectable through this
  invariant as curated.
- **N1 for `transfer_shares`** is deliberately not asserted, per the curation note: the function
  reaches no bumping path, and that asymmetry is a recorded observation. P8 exercises the call so
  it appears in traces, but does not fail on it.
- **I3 under harness overflow** is skipped rather than failed, per the curation note, so extreme
  operands that would make `A·T` exceed `i128` contribute nothing to this invariant. With the
  fixture's `MINT_PER_ACTOR` of 1e12 this is effectively unreachable, which also means the
  contract's own `checked_mul`/`Overflow` path is only reached via out-of-range *generated*
  operands that fail earlier at `require_positive` or at the token contract. The `Overflow` arm in
  P2 is therefore written but rarely exercised — a coverage weakness worth noting, not a property
  I could strengthen without minting near `i128::MAX`, which would break N2's headroom.

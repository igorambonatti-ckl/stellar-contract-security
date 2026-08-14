#![no_std]
//! # `soroban-vault` — the fuzzing target for this IDP
//!
//! A single-asset deposit/withdraw vault with shares. Small enough to finish,
//! rich enough to carry real invariants, and it exercises every Soroban-specific
//! hazard identified in Topics 1–2.
//!
//! Specified in [Topic 3 §5](../../../03-solution-architecture/README.md).
//!
//! ## Storage tiers — deliberately all three
//!
//! | Tier | Holds | Why this tier |
//! |---|---|---|
//! | Instance | `admin`, `token`, `paused`, `total_shares` | Small global config + accounting, shares the instance TTL |
//! | Persistent | per-address share balances | Core user data; must survive, must be TTL-managed |
//! | Temporary | per-address last-activity ledger | **Non-authoritative telemetry only** — see below |
//!
//! ## The temporary tier is never authoritative
//!
//! `last_activity` is a convenience read-out and **nothing is ever gated on
//! it**. That is invariant I11: auth-critical state must never live in a tier
//! that can silently expire. The P1 spikes confirmed temporary entries are
//! genuinely unrecoverable after expiry — unlike persistent entries, which
//! protocol 23 auto-restores. The `bug_temp_nonce` seed makes this value
//! authoritative, which is exactly the bug class scenario S14 describes.
//!
//! ## TTL constants
//!
//! `extend_ttl(threshold, extend_to)` extends **only if** the remaining TTL is
//! already below `threshold` (established in the P1 spikes — the tutorial idiom
//! `extend_ttl(50, 100)` is a no-op for thousands of ledgers against the host's
//! 4096-ledger floor). The constants below are chosen so the call actually
//! fires: a fresh entry starts at 4095, well under `BUMP_THRESHOLD`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
};

/// ~30 days at 5s ledgers. A fresh entry (TTL 4095) is below this, so the bump fires.
pub const BUMP_THRESHOLD: u32 = 518_400;
/// ~60 days at 5s ledgers. Comfortably under the 6_312_000 host maximum.
pub const BUMP_AMOUNT: u32 = 1_036_800;
/// Short-lived: this data is telemetry and is *expected* to vanish.
pub const TEMP_TTL: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InsufficientBalance = 4,
    Paused = 5,
    Overflow = 6,
    ZeroShares = 7,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance tier.
    Admin,
    Token,
    Paused,
    TotalShares,
    /// Persistent tier — core user data.
    Balance(Address),
    /// Temporary tier — non-authoritative telemetry.
    LastActivity(Address),
}

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Initialize the vault. Guarded so it can only ever succeed once (I9).
    pub fn initialize(env: Env, admin: Address, token: Address) {
        // I9 — re-initialization must always abort. Removing this guard is the
        // `bug_reinit` seed, and it is the Parity / front-run-init bug class
        // (scenarios S13, S19).
        #[cfg(not(feature = "bug_reinit"))]
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, VaultError::AlreadyInitialized);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        Self::bump_instance(&env);
    }

    // ── Core operations ──────────────────────────────────────────────────────

    /// Deposit `amount` of the underlying token; returns the shares minted.
    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        from.require_auth();
        Self::require_not_paused(&env);
        Self::require_positive(&env, amount);

        let token_addr = Self::token_address(&env);
        let client = token::TokenClient::new(&env, &token_addr);
        let vault = env.current_contract_address();

        // Assets held *before* the incoming transfer — the correct basis for
        // the share price.
        let assets_before = client.balance(&vault);
        let total = Self::total_shares_internal(&env);

        let shares = if total == 0 {
            amount
        } else {
            // amount * total / assets_before
            let numerator = Self::checked_mul(&env, amount, total);
            if assets_before <= 0 {
                panic_with_error!(&env, VaultError::InvalidAmount);
            }
            numerator / assets_before
        };

        // I3/I7 — a deposit that mints zero shares is value donated to existing
        // holders. Rejecting it closes the share-inflation vector (S18).
        #[cfg(not(feature = "bug_zero_amount"))]
        if shares <= 0 {
            panic_with_error!(&env, VaultError::ZeroShares);
        }

        client.transfer(&from, &vault, &amount);

        let balance = Self::balance_internal(&env, &from);
        Self::set_balance(&env, &from, Self::checked_add(&env, balance, shares));
        Self::set_total_shares(&env, Self::checked_add(&env, total, shares));
        Self::touch(&env, &from);

        shares
    }

    /// Burn `shares` and return the corresponding amount of the underlying token.
    pub fn withdraw(env: Env, from: Address, shares: i128) -> i128 {
        from.require_auth();
        Self::require_not_paused(&env);
        Self::require_positive(&env, shares);

        let balance = Self::balance_internal(&env, &from);
        if balance < shares {
            panic_with_error!(&env, VaultError::InsufficientBalance);
        }

        let token_addr = Self::token_address(&env);
        let client = token::TokenClient::new(&env, &token_addr);
        let vault = env.current_contract_address();

        let total = Self::total_shares_internal(&env);
        let assets = client.balance(&vault);

        // amount = shares * assets / total
        let amount = if total == 0 {
            0
        } else {
            Self::checked_mul(&env, shares, assets) / total
        };

        // Effects before interaction (CEI) — the reentrancy discipline from
        // scenario S02.
        Self::set_balance(&env, &from, Self::checked_sub(&env, balance, shares));
        Self::set_total_shares(&env, Self::checked_sub(&env, total, shares));

        if amount > 0 {
            client.transfer(&vault, &from, &amount);
        }
        Self::touch(&env, &from);

        amount
    }

    /// Move `shares` between two holders.
    pub fn transfer_shares(env: Env, from: Address, to: Address, shares: i128) {
        // I5 — the sender must authorize. Dropping this is `bug_missing_auth`,
        // the SOR-001 / Wormhole bug class.
        #[cfg(not(feature = "bug_missing_auth"))]
        from.require_auth();

        Self::require_not_paused(&env);
        Self::require_positive(&env, shares);

        let from_balance = Self::balance_internal(&env, &from);
        if from_balance < shares {
            panic_with_error!(&env, VaultError::InsufficientBalance);
        }

        // I8 — a self-transfer must be a no-op. Handling it by reading both
        // balances and writing both back would duplicate the shares, which is
        // the `bug_self_transfer` seed (scenario S17).
        #[cfg(not(feature = "bug_self_transfer"))]
        if from == to {
            Self::touch(&env, &from);
            return;
        }

        let to_balance = Self::balance_internal(&env, &to);
        Self::set_balance(&env, &from, Self::checked_sub(&env, from_balance, shares));
        Self::set_balance(&env, &to, Self::checked_add(&env, to_balance, shares));
        Self::touch(&env, &from);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// Hand the admin role to `new_admin`. Only the current admin may do this (I4).
    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
    }

    /// Halt all state-mutating entry points (I12). Only the admin may do this (I4).
    pub fn pause(env: Env) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &true);
        Self::bump_instance(&env);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    pub fn total_shares(env: Env) -> i128 {
        Self::total_shares_internal(&env)
    }

    pub fn balance_of(env: Env, who: Address) -> i128 {
        Self::balance_internal(&env, &who)
    }

    pub fn admin(env: Env) -> Address {
        Self::admin_address(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Ledger of the address's last vault operation.
    ///
    /// **Non-authoritative.** Lives in temporary storage and may vanish at any
    /// time; nothing in this contract is gated on it (I11).
    pub fn last_activity(env: Env, who: Address) -> Option<u32> {
        env.storage().temporary().get(&DataKey::LastActivity(who))
    }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

impl Vault {
    fn admin_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::NotInitialized))
    }

    fn token_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::NotInitialized))
    }

    fn require_admin(env: &Env) {
        let admin = Self::admin_address(env);

        // With `bug_temp_nonce`, admin authority is additionally gated on a
        // temporary-storage value. When that entry expires the check silently
        // changes behaviour — invariant I11, scenario S14.
        #[cfg(feature = "bug_temp_nonce")]
        {
            let seen: Option<u32> = env
                .storage()
                .temporary()
                .get(&DataKey::LastActivity(admin.clone()));
            if seen.is_none() {
                // "Never acted, so cannot be the real admin" — plausible-looking
                // and catastrophically wrong.
                panic_with_error!(env, VaultError::NotInitialized);
            }
        }

        admin.require_auth();
    }

    fn require_not_paused(env: &Env) {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(env, VaultError::Paused);
        }
    }

    fn require_positive(env: &Env, value: i128) {
        // I7 — non-positive amounts must be rejected outright. Accepting them is
        // the `bug_zero_amount` seed.
        #[cfg(not(feature = "bug_zero_amount"))]
        if value <= 0 {
            panic_with_error!(env, VaultError::InvalidAmount);
        }
        #[cfg(feature = "bug_zero_amount")]
        if value < 0 {
            panic_with_error!(env, VaultError::InvalidAmount);
        }
    }

    fn total_shares_internal(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    fn set_total_shares(env: &Env, value: i128) {
        env.storage().instance().set(&DataKey::TotalShares, &value);
        Self::bump_instance(env);
    }

    fn balance_internal(env: &Env, who: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(who.clone()))
            .unwrap_or(0)
    }

    fn set_balance(env: &Env, who: &Address, value: i128) {
        let key = DataKey::Balance(who.clone());
        env.storage().persistent().set(&key, &value);

        // I10′ — a correct contract keeps its own entries alive rather than
        // silently relying on protocol-23 auto-restoration, which costs rent.
        // Omitting this bump is the `bug_no_ttl` seed.
        #[cfg(not(feature = "bug_no_ttl"))]
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
    }

    /// Record non-authoritative activity telemetry in the temporary tier.
    fn touch(env: &Env, who: &Address) {
        let key = DataKey::LastActivity(who.clone());
        env.storage()
            .temporary()
            .set(&key, &env.ledger().sequence());
        env.storage().temporary().extend_ttl(&key, TEMP_TTL, TEMP_TTL);
    }

    fn bump_instance(env: &Env) {
        #[cfg(not(feature = "bug_no_ttl"))]
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
        #[cfg(feature = "bug_no_ttl")]
        let _ = env;
    }

    fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
        // I6 — all arithmetic is checked. `bug_overflow` swaps this for wrapping
        // arithmetic, the BeautyChain / SOR-005 bug class.
        //
        // Note it uses `wrapping_add`, not a bare `+`. A bare `+` panics on
        // overflow in debug builds *and* in this workspace's release profile
        // (`overflow-checks = true`, the Soroban template default), so it would
        // not actually be a bug — see `results/seeds.md`.
        #[cfg(feature = "bug_overflow")]
        {
            let _ = env;
            return a.wrapping_add(b);
        }
        #[cfg(not(feature = "bug_overflow"))]
        a.checked_add(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }

    fn checked_sub(env: &Env, a: i128, b: i128) -> i128 {
        a.checked_sub(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }

    fn checked_mul(env: &Env, a: i128, b: i128) -> i128 {
        #[cfg(feature = "bug_overflow")]
        {
            let _ = env;
            return a.wrapping_mul(b);
        }
        #[cfg(not(feature = "bug_overflow"))]
        a.checked_mul(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }
}

#[cfg(test)]
mod testkit;
mod test;
mod test_invariants;

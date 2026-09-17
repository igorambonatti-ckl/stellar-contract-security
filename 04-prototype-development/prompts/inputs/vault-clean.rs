#![no_std]
//! # `soroban-vault`
//!
//! A single-asset deposit/withdraw vault with shares.
//!
//! ## Storage tiers
//!
//! | Tier | Holds |
//! |---|---|
//! | Instance | `admin`, `token`, `paused`, `total_shares` |
//! | Persistent | per-address share balances |
//! | Temporary | per-address last-activity ledger |
//!
//! ## TTL constants
//!
//! `extend_ttl(threshold, extend_to)` extends only if the remaining TTL is
//! already below `threshold`. The constants below are chosen so the call
//! actually fires against the host's 4096-ledger floor.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
};

/// ~30 days at 5s ledgers.
pub const BUMP_THRESHOLD: u32 = 518_400;
/// ~60 days at 5s ledgers. Comfortably under the 6_312_000 host maximum.
pub const BUMP_AMOUNT: u32 = 1_036_800;
/// Short-lived.
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
    /// Persistent tier.
    Balance(Address),
    /// Temporary tier.
    LastActivity(Address),
}

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// Initialize the vault.
    pub fn initialize(env: Env, admin: Address, token: Address) {
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

        // Assets held *before* the incoming transfer.
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

        // Effects before interaction.
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
        from.require_auth();

        Self::require_not_paused(&env);
        Self::require_positive(&env, shares);

        let from_balance = Self::balance_internal(&env, &from);
        if from_balance < shares {
            panic_with_error!(&env, VaultError::InsufficientBalance);
        }

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

    /// Hand the admin role to `new_admin`.
    pub fn set_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);
    }

    /// Halt all state-mutating entry points.
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
        if value <= 0 {
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
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_AMOUNT);
    }

    /// Record activity telemetry in the temporary tier.
    fn touch(env: &Env, who: &Address) {
        let key = DataKey::LastActivity(who.clone());
        env.storage()
            .temporary()
            .set(&key, &env.ledger().sequence());
        env.storage().temporary().extend_ttl(&key, TEMP_TTL, TEMP_TTL);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
    }

    fn checked_add(env: &Env, a: i128, b: i128) -> i128 {
        a.checked_add(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }

    fn checked_sub(env: &Env, a: i128, b: i128) -> i128 {
        a.checked_sub(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }

    fn checked_mul(env: &Env, a: i128, b: i128) -> i128 {
        a.checked_mul(b)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Overflow))
    }
}

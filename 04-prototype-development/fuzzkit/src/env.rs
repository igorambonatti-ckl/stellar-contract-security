//! Test-host setup, with the TTL floors pinned rather than inherited.
//!
//! The host's default `min_persistent_entry_ttl` is 4096 ledgers. Any entry is
//! created at that floor, so an `extend_ttl(threshold, extend_to)` whose
//! `threshold` is below it is a **no-op for thousands of ledgers** — the call
//! runs, changes nothing, and the test passes.
//!
//! That is the failure mode where a TTL property passes for the wrong reason:
//! not because the contract manages its entries, but because the host's floor
//! was holding them up. Pinning the floors explicitly makes the contract's own
//! `extend_ttl` the only thing keeping an entry alive, which is what the property
//! is supposed to be asserting.

use soroban_sdk::testutils::Ledger;
use soroban_sdk::Env;

/// Ledger parameters to pin.
#[derive(Debug, Clone, Copy)]
pub struct LedgerPins {
    /// Starting sequence number. A known, non-zero value, so that TTL arithmetic
    /// in assertions is reproducible and so that "sequence 0" — which is
    /// indistinguishable from an absent `u32` behind `unwrap_or(0)` — is not the
    /// state every test starts in.
    pub start_sequence: u32,
    /// Floor for persistent entries. Pinned **low** so that a missing
    /// `extend_ttl` is observable.
    pub min_persistent_entry_ttl: u32,
    /// Floor for temporary entries.
    pub min_temp_entry_ttl: u32,
    /// Host maximum. Must exceed whatever the contract extends to, or every bump
    /// is silently clamped and the contract looks under-managed.
    pub max_entry_ttl: u32,
}

impl Default for LedgerPins {
    fn default() -> Self {
        Self {
            start_sequence: 1_000,
            min_persistent_entry_ttl: 16,
            min_temp_entry_ttl: 16,
            max_entry_ttl: 6_312_000,
        }
    }
}

impl LedgerPins {
    /// Apply these pins to an existing `Env`.
    pub fn apply(&self, env: &Env) {
        env.ledger().with_mut(|li| {
            li.sequence_number = self.start_sequence;
            li.min_persistent_entry_ttl = self.min_persistent_entry_ttl;
            li.min_temp_entry_ttl = self.min_temp_entry_ttl;
            li.max_entry_ttl = self.max_entry_ttl;
        });
    }
}

/// A fresh `Env` with the TTL floors pinned and all authorizations mocked.
///
/// Auth is mocked because most steps are not *about* authorization; the steps
/// that are should revoke it explicitly for the duration of one call. See
/// [`crate::oracle`] for why the assertion on such a call has to check *which*
/// error came back.
pub fn pinned_env(pins: LedgerPins) -> Env {
    let env = Env::default();
    env.mock_all_auths();
    pins.apply(&env);
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_are_applied() {
        let env = pinned_env(LedgerPins::default());
        assert_eq!(env.ledger().sequence(), 1_000);
    }

    #[test]
    fn floors_are_low_enough_that_a_missing_extend_is_observable() {
        let p = LedgerPins::default();
        // The whole point: an entry must *not* start out above a realistic
        // extend_ttl threshold, or the contract's own bump is unobservable.
        assert!(p.min_persistent_entry_ttl < 4_096);
        assert!(p.max_entry_ttl > p.min_persistent_entry_ttl);
    }

    #[test]
    fn start_sequence_is_not_zero() {
        // Sequence 0 is indistinguishable from an absent u32 read through
        // unwrap_or(0), which would make some assertions vacuous.
        assert_ne!(LedgerPins::default().start_sequence, 0);
    }

    #[test]
    fn custom_pins_round_trip() {
        let pins = LedgerPins {
            start_sequence: 77,
            min_persistent_entry_ttl: 8,
            min_temp_entry_ttl: 4,
            max_entry_ttl: 1_000_000,
        };
        let env = pinned_env(pins);
        assert_eq!(env.ledger().sequence(), 77);
    }
}

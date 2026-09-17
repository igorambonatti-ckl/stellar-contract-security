//! Principals: a fixed pool, fuzzed by index.
//!
//! **A freshly generated `Address` cannot be authorized in the test host.** Fuzz
//! raw address bytes and every access-control property collapses into "an unknown
//! caller is rejected" — which is trivially true, tells you nothing, and reports
//! as coverage. The fuzzable quantity is *which* principal acts, so the input is
//! an **index** into a pool registered up front.
//!
//! The pool must also contain the slots a contract's implicit "principals are not
//! contracts" assumption never considers:
//!
//! - **the contract under test itself** — passing it as a counterparty makes a
//!   token transfer read and write the same account, and can strand value in an
//!   address that can never sign to move it;
//! - **any contract it calls** (typically the token) — the same aliasing, one
//!   step removed;
//! - **a principal that is never authorized** — without it, no auth property is
//!   falsifiable.
//!
//! Indices are drawn with a **skew**, not uniformly. The aliasing slots are
//! rare-but-high-signal: most of their draws abort early, so giving them an equal
//! share would spend a large fraction of the budget on calls that never reach the
//! contract body.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

/// What a pool slot is for. Lets a harness ask "is this the unauthorized one?"
/// without hard-coding an index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The privileged principal, if the contract has one. Always slot 0.
    Admin,
    /// An ordinary actor, expected to be able to authorize.
    Actor,
    /// The contract under test.
    SelfContract,
    /// A contract the subject calls — typically the token.
    Callee,
    /// A valid principal for which authorization is never granted.
    Unauthorized,
}

/// Declarative description of the pool to build.
#[derive(Debug, Clone)]
pub struct PoolSpec {
    actors: usize,
    self_contract: Option<Address>,
    callee: Option<Address>,
    unauthorized: bool,
    weights: Option<Vec<u8>>,
}

impl PoolSpec {
    /// `actors` ordinary principals, plus an admin in slot 0.
    pub fn new(actors: usize) -> Self {
        Self {
            actors,
            self_contract: None,
            callee: None,
            unauthorized: true,
            weights: None,
        }
    }

    /// Include the address of the contract under test as an actor slot.
    pub fn with_contract(mut self, id: Address) -> Self {
        self.self_contract = Some(id);
        self
    }

    /// Include the address of a contract the subject calls — usually the token.
    pub fn with_callee(mut self, id: Address) -> Self {
        self.callee = Some(id);
        self
    }

    /// Drop the never-authorized principal. Only sensible for a contract with no
    /// authorization at all; otherwise this silently removes the negative control
    /// for every auth property.
    pub fn without_unauthorized(mut self) -> Self {
        self.unauthorized = false;
        self
    }

    /// Override the relative draw weights, one entry per slot, in slot order.
    /// Defaults favour ordinary actors and make the aliasing slots rare.
    pub fn with_weights(mut self, weights: impl IntoIterator<Item = u8>) -> Self {
        self.weights = Some(weights.into_iter().collect());
        self
    }

    /// Register the principals and build the pool.
    pub fn build(self, env: &Env) -> Pool {
        let mut addresses = Vec::new();
        let mut roles = Vec::new();

        addresses.push(Address::generate(env));
        roles.push(Role::Admin);

        for _ in 0..self.actors {
            addresses.push(Address::generate(env));
            roles.push(Role::Actor);
        }
        if let Some(id) = self.callee {
            addresses.push(id);
            roles.push(Role::Callee);
        }
        if let Some(id) = self.self_contract {
            addresses.push(id);
            roles.push(Role::SelfContract);
        }
        if self.unauthorized {
            addresses.push(Address::generate(env));
            roles.push(Role::Unauthorized);
        }

        let weights = self.weights.unwrap_or_else(|| {
            roles
                .iter()
                .map(|r| match r {
                    Role::Actor => 20,
                    Role::Admin => 12,
                    Role::Unauthorized => 8,
                    Role::SelfContract => 8,
                    Role::Callee => 4,
                })
                .collect()
        });
        assert_eq!(
            weights.len(),
            addresses.len(),
            "one weight per slot: got {} weights for {} slots",
            weights.len(),
            addresses.len()
        );

        // Expand into a 256-entry lookup so an index draw is one byte and one
        // array read — this runs on every step of every fuzz iteration.
        let total: u32 = weights.iter().map(|w| *w as u32).sum();
        assert!(total > 0, "at least one slot must have a non-zero weight");
        let mut table = Vec::with_capacity(256);
        for i in 0..256u32 {
            let mut target = i * total / 256;
            let mut chosen = 0usize;
            for (slot, w) in weights.iter().enumerate() {
                let w = *w as u32;
                if target < w {
                    chosen = slot;
                    break;
                }
                target -= w;
                chosen = slot;
            }
            table.push(chosen);
        }

        Pool {
            addresses,
            roles,
            table,
        }
    }
}

/// A registered pool of principals, drawn by index.
#[derive(Debug)]
pub struct Pool {
    addresses: Vec<Address>,
    roles: Vec<Role>,
    table: Vec<usize>,
}

impl Pool {
    /// Map one fuzzer byte onto a slot, with the configured skew.
    pub fn index(&self, byte: u8) -> usize {
        self.table[byte as usize]
    }

    /// Map one fuzzer byte onto a slot, restricted to slots that can authorize.
    /// Use where the point of the step is *not* to test authorization, so that
    /// those steps are not silently wasted on the unauthorized principal.
    pub fn index_authorized(&self, byte: u8) -> usize {
        let i = self.index(byte);
        if self.roles[i] == Role::Unauthorized {
            self.slot_of(Role::Actor).unwrap_or(0)
        } else {
            i
        }
    }

    /// The address in a slot.
    pub fn address(&self, slot: usize) -> &Address {
        &self.addresses[slot % self.addresses.len()]
    }

    /// The role of a slot.
    pub fn role(&self, slot: usize) -> Role {
        self.roles[slot % self.roles.len()]
    }

    /// First slot with the given role.
    pub fn slot_of(&self, role: Role) -> Option<usize> {
        self.roles.iter().position(|r| *r == role)
    }

    /// Every slot, in order.
    pub fn addresses(&self) -> &[Address] {
        &self.addresses
    }

    /// Number of slots.
    pub fn len(&self) -> usize {
        self.addresses.len()
    }

    /// Whether the pool is empty. Never true for a pool built by [`PoolSpec`].
    pub fn is_empty(&self) -> bool {
        self.addresses.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::default()
    }

    #[test]
    fn admin_is_slot_zero_and_roles_are_in_declaration_order() {
        let e = env();
        let p = PoolSpec::new(3).build(&e);
        assert_eq!(p.role(0), Role::Admin);
        assert_eq!(p.role(1), Role::Actor);
        assert_eq!(p.role(3), Role::Actor);
        assert_eq!(p.role(4), Role::Unauthorized);
        assert_eq!(p.len(), 5);
    }

    #[test]
    fn aliasing_slots_hold_the_addresses_they_were_given() {
        let e = env();
        let contract = Address::generate(&e);
        let token = Address::generate(&e);
        let p = PoolSpec::new(2)
            .with_contract(contract.clone())
            .with_callee(token.clone())
            .build(&e);

        let c = p.slot_of(Role::SelfContract).unwrap();
        let t = p.slot_of(Role::Callee).unwrap();
        assert_eq!(p.address(c), &contract);
        assert_eq!(p.address(t), &token);
    }

    #[test]
    fn every_byte_maps_to_a_valid_slot() {
        let e = env();
        let p = PoolSpec::new(3).build(&e);
        for b in 0..=255u8 {
            assert!(p.index(b) < p.len());
        }
    }

    #[test]
    fn every_slot_is_reachable_and_actors_dominate() {
        let e = env();
        let p = PoolSpec::new(3)
            .with_contract(Address::generate(&e))
            .with_callee(Address::generate(&e))
            .build(&e);

        let mut counts = vec![0usize; p.len()];
        for b in 0..=255u8 {
            counts[p.index(b)] += 1;
        }
        // No slot is unreachable — an unreachable aliasing slot would be a silent
        // loss of coverage.
        assert!(counts.iter().all(|c| *c > 0), "counts = {counts:?}");

        let actors: usize = (0..p.len())
            .filter(|i| p.role(*i) == Role::Actor)
            .map(|i| counts[i])
            .sum();
        let callee = counts[p.slot_of(Role::Callee).unwrap()];
        assert!(actors > callee * 4, "actors {actors} should dominate callee {callee}");
    }

    #[test]
    fn index_authorized_never_returns_the_unauthorized_slot() {
        let e = env();
        let p = PoolSpec::new(3).build(&e);
        let u = p.slot_of(Role::Unauthorized).unwrap();
        for b in 0..=255u8 {
            assert_ne!(p.index_authorized(b), u);
        }
    }

    #[test]
    fn custom_weights_are_honoured() {
        let e = env();
        // Only the last slot may ever be drawn.
        let p = PoolSpec::new(1).with_weights([0, 0, 1]).build(&e);
        for b in 0..=255u8 {
            assert_eq!(p.index(b), 2);
        }
    }
}

#![cfg(test)]
//! # Spike B — does `SorobanArbitrary` produce usable `Address` values?
//!
//! Topic 3 open question 1. If every generated address fails `require_auth`
//! uniformly, then invariants I4/I5 (access control) are trivially satisfied and
//! fuzzing them proves nothing. This spike establishes whether generated
//! addresses can be made to produce *meaningful* auth outcomes — both accept and
//! reject.

extern crate std;
use std::collections::HashSet;
use std::format;
use std::vec::Vec as StdVec;

use super::*;
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest_arbitrary_interop::arb;
use soroban_sdk::testutils::arbitrary::SorobanArbitrary;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::IntoVal;

type AddressPrototype = <Address as SorobanArbitrary>::Prototype;

/// B1 — generated prototypes convert to `Address` and are reasonably distinct.
///
/// A generator that collapses to a handful of values would make address-space
/// fuzzing pointless.
#[test]
fn b1_generated_addresses_are_distinct() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let env = Env::default();
    let mut seen: HashSet<std::string::String> = HashSet::new();

    for _ in 0..200 {
        let proto = arb::<AddressPrototype>()
            .new_tree(&mut runner)
            .unwrap()
            .current();
        let addr: Address = proto.into_val(&env);
        seen.insert(format!("{:?}", addr));
    }

    assert!(
        seen.len() > 100,
        "expected a wide address distribution, got {} distinct of 200",
        seen.len()
    );
}

/// B2 — without any mocked auth, `require_auth` rejects. The baseline.
#[test]
fn b2_unauthorized_call_is_rejected() {
    let env = Env::default();
    let contract_id = env.register(SpikeContract, ());
    let client = SpikeContractClient::new(&env, &contract_id);
    let user = Address::generate(&env);

    assert!(
        client.try_auth_action(&user).is_err(),
        "no auth mocked → require_auth must reject"
    );
}

/// B3 — **the discriminating test.** Auth mocked for address A; calling as A
/// succeeds and calling as B fails, within the same `Env`.
///
/// This is what makes access-control fuzzing meaningful: the outcome depends on
/// *which* principal acts, not uniformly on "generated addresses never pass".
#[test]
fn b3_auth_outcome_depends_on_which_principal_acts() {
    let env = Env::default();
    let contract_id = env.register(SpikeContract, ());
    let client = SpikeContractClient::new(&env, &contract_id);

    let authorized = Address::generate(&env);
    let other = Address::generate(&env);

    let authorized_ok = client
        .mock_auths(&[MockAuth {
            address: &authorized,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "auth_action",
                args: (authorized.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_auth_action(&authorized);

    let other_rejected = client.try_auth_action(&other);

    assert!(authorized_ok.is_ok(), "the authorized principal must succeed");
    assert!(other_rejected.is_err(), "a different principal must be rejected");
}

/// B4 — arbitrary-generated addresses work as *contract arguments*, but cannot
/// themselves be authorized: `MockAuth` needs an address the host knows about.
///
/// Recorded as a constraint on harness design, not as a failure.
#[test]
fn b4_arbitrary_addresses_are_usable_as_arguments() {
    let mut runner = proptest::test_runner::TestRunner::deterministic();
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SpikeContract, ());
    let client = SpikeContractClient::new(&env, &contract_id);

    let mut addrs: StdVec<Address> = StdVec::new();
    for _ in 0..20 {
        let proto = arb::<AddressPrototype>()
            .new_tree(&mut runner)
            .unwrap()
            .current();
        addrs.push(proto.into_val(&env));
    }

    for (i, a) in addrs.iter().enumerate() {
        client.set_balance(a, &(i as i128));
    }
    for (i, a) in addrs.iter().enumerate() {
        assert_eq!(client.get_balance(a), i as i128);
    }
}

proptest! {
    /// B5 — the shape the real harness will use: fuzz an *index into a fixed
    /// pool* of host-known principals, rather than raw address bytes.
    ///
    /// This is the fallback the plan predicted, and it is strictly better for
    /// access control: it explores "who acts" against "who is authorized".
    #[test]
    fn b5_indexed_principal_pool_explores_auth_space(
        actor_idx in 0usize..4,
        owner_idx in 0usize..4,
    ) {
        let env = Env::default();
        let contract_id = env.register(SpikeContract, ());
        let client = SpikeContractClient::new(&env, &contract_id);

        let pool: StdVec<Address> = (0..4).map(|_| Address::generate(&env)).collect();
        let actor = &pool[actor_idx];
        let owner = &pool[owner_idx];

        let result = client
            .mock_auths(&[MockAuth {
                address: owner,
                invoke: &MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "auth_action",
                    args: (actor.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_auth_action(actor);

        // The invariant under test: the call succeeds exactly when the acting
        // principal is the authorized one.
        prop_assert_eq!(result.is_ok(), actor_idx == owner_idx);
    }
}

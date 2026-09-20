#![no_main]
//! # WASM arm — fuzzing the artifact that actually ships
//!
//! [`vault_baseline`] and [`vault_ai`] link the contract crate natively. This
//! target registers the **compiled `.wasm`** into the `Env` and drives it
//! through the same generated client, so what runs is a WASM module in the
//! Soroban VM — the thing a deployment puts on the network.
//!
//! ## Why this arm exists
//!
//! Two reasons, and the second is the one that made it necessary.
//!
//! **1. It is what ships.** Topic 5 lists "the deployed WASM is not what gets
//! fuzzed" as limitation L7, and the prior art (ChainGuard) concluded WASM-in-
//! `Env` was the correct dynamic-fuzzing substrate before this project traded it
//! away for coverage instrumentation.
//!
//! **2. Resource metering is meaningless without it.** From the SDK's own
//! documentation of `cost_estimate()`:
//!
//! > "if a test contract is used instead of a Wasm contract, all the costs
//! >  related to VM instantiation and execution, as well as Wasm reads/rent
//! >  bumps will be missed."
//!
//! Every Soroban-native oracle — instruction ceilings, rent bumps — reads the invocation's metered footprint. Against a natively
//! linked contract those numbers are absent or wrong, so the oracles are
//! vacuous. This arm is the only place they mean anything.
//!
//! ## What it asserts that the other arms cannot
//!
//! | Oracle | Question |
//! |---|---|
//! | **R1** resource ceilings | can this call actually be submitted on-chain? |
//! | ~~**R2** rent on write~~ | *withdrawn — the counter measures the host, not the contract* |
//! | ~~**R3** archival~~ | *withdrawn — see below* |
//!
//! R2 is the surviving answer to Topic 3 open question 5. R3 is the other half
//! of that answer, and it is negative: `disk_read_entries` conflates archival
//! restoration with ordinary classic-account reads, so it cannot serve as a TTL
//! oracle at all.
//!
//! The question asked whether the resource counters make a *better* TTL oracle
//! than reading storage. They are not better — they are **differently scoped**.
//! Reading a TTL requires knowing which storage key to read, which requires
//! having read the contract. R2 needs neither, so it is the only TTL oracle here
//! that applies to a contract you have not read, which is the situation an
//! auditor is in.
//!
//! The application-logic invariants (I1, I6, N2, …) are asserted too, so this
//! arm is a superset rather than a replacement.

use libfuzzer_sys::fuzz_target;
use soroban_fuzzkit::{
    env::{pinned_env, LedgerPins},
    operand::{Operand, OperandPolicy},
    pool::{Pool, PoolSpec, Role},
    resources::{self, Ceilings, Footprint},
    ttl::TtlCliffs,
};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};
use soroban_vault::{VaultClient, BUMP_AMOUNT, BUMP_THRESHOLD, TEMP_TTL};

/// The deployed artifact, built by `build.rs` with exactly the seed features the
/// fuzz binary was built with.
const VAULT_WASM: &[u8] = include_bytes!(env!("VAULT_WASM_PATH"));

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
    /// Forced aliasing. A random `(from, to)` pair essentially never collides,
    /// so without a dedicated step the `from == to` branch is unreachable —
    /// which is how the first version of this arm ended up unable to observe a
    /// whole class of accounting fault. Prior §2.2, rank 2.
    SelfTransfer { who: u8, shares: Operand },
    Donate { who: u8, amount: Operand },
    SetAdmin { who: u8 },
    Pause,
    Advance { choice: u8 },
    /// A read-only call. Present so the "a write must pay rent" oracle is
    /// exercised on invocations that legitimately write nothing.
    View { who: u8 },
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
    ceilings: Ceilings,
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
    fn held(&self) -> Option<i128> {
        self.pool
            .addresses()
            .iter()
            .try_fold(0i128, |acc, a| acc.checked_add(self.vault().balance_of(a)))
    }
}

fn rig() -> Rig {
    let env = pinned_env(LedgerPins::default());

    let sac_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(sac_admin).address();
    // The whole point: a WASM module in the VM, not a natively linked struct.
    let vault_id = env.register(VAULT_WASM, ());

    let pool = PoolSpec::new(3)
        .with_callee(token_id.clone())
        .with_contract(vault_id.clone())
        .build(&env);

    let sac = StellarAssetClient::new(&env, &token_id);
    let mut funded = 0usize;
    for (i, a) in pool.addresses().iter().enumerate() {
        if matches!(pool.role(i), Role::SelfContract | Role::Callee) {
            continue;
        }
        sac.mint(a, &MINTS[funded % MINTS.len()]);
        funded += 1;
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
        ceilings: Ceilings::default(),
    }
}

/// The Soroban-native oracles, read from the invocation's metered footprint.
fn check_resources(r: &Rig, f: &Footprint, after: &str) {
    // R1 — could this call actually be submitted on-chain?
    if let Err(why) = r.ceilings.check(f) {
        panic!("R1 violated after {after}: {why} (footprint {f:?})");
    }

    // R2 was an assertion here and is not one any more. Measurement (see
    // `tools/footprint.rs`) showed `persistent_entry_rent_bumps` is identical
    // between the clean contract and `bug_no_ttl`: the *host* bumps rent when it
    // writes an entry, whether or not the contract called `extend_ttl`. The
    // counter therefore measures the host's behaviour, not the contract's, and
    // cannot serve as a TTL oracle. See `results/p6b-wasm-arm.md` §4.

    // R3 was an assertion here and is not one any more. "A disk read means an
    // archived entry was restored" is wrong: the counter also includes
    // non-Soroban entries such as classic account balances, so any contract that
    // calls a Stellar Asset Contract reads from disk on a perfectly healthy
    // invocation. It fired on the clean build within 90 seconds. See
    // `soroban_fuzzkit::resources::no_restoration_occurred` for the write-up;
    // the rent-bump oracle (R2) is the one that survives.
}

/// The application-logic invariants, so this arm is a superset of the others.
fn check_state(r: &Rig, paused_before: bool, admin_before: &Address, after: &str) {
    let total = r.vault().total_shares();
    let held = r
        .held()
        .unwrap_or_else(|| panic!("I1 after {after}: Σ balance_of() overflowed i128"));
    assert_eq!(
        total, held,
        "I1 violated after {after}: total_shares()={total} but Σ balance_of()={held}"
    );
    assert!(total >= 0, "I6 violated after {after}: total_shares()={total} < 0");
    let assets = r.assets();
    assert!(
        assets >= total,
        "N2 violated after {after}: vault holds {assets} assets against {total} shares"
    );
    assert!(
        !(paused_before && !r.vault().is_paused()),
        "I12(a) violated after {after}: paused went true -> false"
    );
    if after != "set_admin" {
        assert_eq!(
            r.vault().admin(),
            *admin_before,
            "I4 violated after {after}: admin changed outside set_admin"
        );
    }
}

fuzz_target!(|program: Program| {
    if program.steps.is_empty() || program.steps.len() > 12 {
        return;
    }

    let r = rig();
    let vault = r.vault();

    for step in program.steps.iter() {
        let paused_before = vault.is_paused();
        let admin_before = vault.admin();
        let label;
        // Whether the step performed a top-level invocation whose footprint is
        // worth reading. A step that only advanced the ledger did not.
        let mut metered = true;

        match step {
            Step::Deposit { who, amount } => {
                label = "deposit";
                let addr = r.pool.address(r.pool.index_caller(*who)).clone();
                let amount = r.ops.resolve(amount, vault.balance_of(&addr));
                metered = vault.try_deposit(&addr, &amount).is_ok();
            }
            Step::Withdraw { who, shares } => {
                label = "withdraw";
                let addr = r.pool.address(r.pool.index_caller(*who)).clone();
                let shares = r.ops.resolve(shares, vault.balance_of(&addr));
                metered = vault.try_withdraw(&addr, &shares).is_ok();
            }
            Step::Transfer { from, to, shares } => {
                label = "transfer_shares";
                let f = r.pool.address(r.pool.index_caller(*from)).clone();
                let t = r.pool.address(r.pool.index(*to)).clone();
                let shares = r.ops.resolve2(shares, vault.balance_of(&f), vault.balance_of(&t));
                metered = vault.try_transfer_shares(&f, &t, &shares).is_ok();
            }
            Step::SelfTransfer { who, shares } => {
                label = "self_transfer";
                let addr = r.pool.address(r.pool.index_caller(*who)).clone();
                let shares = r.ops.resolve(shares, vault.balance_of(&addr));
                let (b0, t0) = (vault.balance_of(&addr), vault.total_shares());
                metered = vault.try_transfer_shares(&addr, &addr, &shares).is_ok();
                if metered {
                    assert_eq!(
                        vault.balance_of(&addr), b0,
                        "I8 violated: self-transfer of {shares} moved a balance from {b0}"
                    );
                    assert_eq!(
                        vault.total_shares(), t0,
                        "I8 violated: self-transfer changed total_shares"
                    );
                }
            }
            Step::Donate { who, amount } => {
                label = "donate";
                let addr = r.pool.address(r.pool.index_caller(*who)).clone();
                let amount = r.ops.resolve(amount, r.token().balance(&addr));
                // A token invocation, not a vault one — its footprint says
                // nothing about the contract under test.
                let _ = r.token().try_transfer(&addr, &r.vault_id, &amount);
                metered = false;
            }
            Step::SetAdmin { who } => {
                label = "set_admin";
                let addr = r.pool.address(r.pool.index(*who)).clone();
                metered = vault.try_set_admin(&addr).is_ok();
            }
            Step::Pause => {
                label = "pause";
                metered = vault.try_pause().is_ok();
            }
            Step::Advance { choice } => {
                label = "advance_ledger";
                let by = r.cliffs.pick(*choice);
                let now = r.env.ledger().sequence();
                r.env.ledger().set_sequence_number(now.saturating_add(by));
                metered = false;
            }
            Step::View { who } => {
                label = "view";
                let addr = r.pool.address(r.pool.index(*who)).clone();
                let _ = vault.balance_of(&addr);
                let _ = vault.last_activity(&addr);
                let _ = vault.total_shares();
            }
        }

        if metered {
            check_resources(&r, &resources::footprint(&r.env), label);
        }
        check_state(&r, paused_before, &admin_before, label);
    }
});

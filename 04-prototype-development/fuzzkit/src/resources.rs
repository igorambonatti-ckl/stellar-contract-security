//! Soroban's own failure modes: resources, rent and archival.
//!
//! Everything else in this crate shapes *inputs*. This module is about an
//! oracle, and it is the one with no analogue outside Soroban.
//!
//! A Soroban invocation is metered. It consumes CPU instructions and memory
//! against a per-transaction ceiling, it reads and writes ledger entries, and —
//! uniquely — it pays **rent** to keep those entries alive. Three bug classes
//! follow, none of which an application-logic oracle can see:
//!
//! 1. **Unusable on-chain.** A call that works in a test but exceeds the
//!    network's instruction or memory limit cannot be submitted. The contract is
//!    correct and the function is dead.
//! 2. **Silent rent omission.** A contract that writes a persistent entry
//!    without extending its TTL leaves the entry to be archived. Under protocol
//!    23 the data survives — it is auto-restored — so *nothing observable breaks*
//!    until someone pays an unexpected restoration cost.
//! 3. **Silent reliance on restoration.** The counterpart: a contract that keeps
//!    working only because the protocol keeps reviving its entries. This one has
//!    **no working oracle here** — see [`no_restoration_occurred`] for why the
//!    obvious one does not hold.
//!
//! ## Why this only works against deployed WASM
//!
//! The SDK is explicit:
//!
//! > "if a test contract is used instead of a Wasm contract, all the costs
//! >  related to VM instantiation and execution, as well as Wasm reads/rent
//! >  bumps will be missed."
//!
//! A natively-linked contract reports rent bumps of zero whether or not it
//! manages its TTLs, so every oracle here is vacuous against it. Register the
//! `.wasm` — see [`crate::pool`] for the counterpart requirement on principals.
//!
//! ## Why these oracles are worth having even though TTLs are readable
//!
//! You can detect a missing `extend_ttl` by reading the entry's TTL directly.
//! That requires knowing **which storage key** to read, which requires having
//! read the contract. These oracles need neither: they observe the invocation's
//! own resource footprint. That makes them the only TTL oracles in this crate
//! that apply to a contract you have not read — which is the situation an
//! auditor is actually in.

use soroban_sdk::Env;

/// The resource footprint of one top-level invocation.
///
/// A projection of the SDK's `InvocationResources` onto the fields that carry
/// an oracle. Copied out rather than borrowed so a before/after pair can be held
/// across a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Footprint {
    /// Modelled CPU instructions.
    pub instructions: i64,
    /// Modelled memory, in bytes.
    pub mem_bytes: i64,
    /// Ledger entries written.
    pub write_entries: u32,
    /// Bytes written to the ledger.
    pub write_bytes: u32,
    /// Entries that had to be read **from disk**.
    ///
    /// Tempting as a restoration detector and unusable as one — it also counts
    /// non-Soroban entries such as classic account balances. See
    /// [`no_restoration_occurred`].
    pub disk_read_entries: u32,
    /// Persistent entries whose rent was bumped.
    pub persistent_entry_rent_bumps: u32,
    /// Temporary entries whose rent was bumped.
    pub temporary_entry_rent_bumps: u32,
}

/// Read the footprint of the most recent top-level invocation.
///
/// Panics if invocation metering is disabled. `Env::default()` enables it, so in
/// practice this only fires if the harness built its `Env` some other way.
pub fn footprint(env: &Env) -> Footprint {
    let r = env.cost_estimate().resources();
    Footprint {
        instructions: r.instructions,
        mem_bytes: r.mem_bytes,
        write_entries: r.write_entries,
        write_bytes: r.write_bytes,
        disk_read_entries: r.disk_read_entries,
        persistent_entry_rent_bumps: r.persistent_entry_rent_bumps,
        temporary_entry_rent_bumps: r.temporary_entry_rent_bumps,
    }
}

/// Per-transaction ceilings.
///
/// The defaults mirror the network limits the SDK itself applies via
/// `InvocationResourceLimits::mainnet()`, which `Env::default()` already
/// enforces — so a call that exceeds them aborts rather than returning. Keeping
/// them here lets a harness assert *proximity* as well as compliance: a function
/// at 80 % of the instruction budget is one state-growth away from being
/// unusable, and that is worth knowing before it is.
#[derive(Debug, Clone, Copy)]
pub struct Ceilings {
    /// Instruction ceiling. Mainnet: 600 000 000 per transaction.
    pub instructions: i64,
    /// Memory ceiling in bytes. Mainnet: 40 MiB.
    pub mem_bytes: i64,
    /// Ledger entries written. Mainnet: 50.
    pub write_entries: u32,
    /// Bytes written. Mainnet: 132 096.
    pub write_bytes: u32,
}

impl Default for Ceilings {
    fn default() -> Self {
        Self {
            instructions: 600_000_000,
            mem_bytes: 41_943_040,
            write_entries: 50,
            write_bytes: 132_096,
        }
    }
}

impl Ceilings {
    /// Fraction of the instruction ceiling consumed, in `0.0..=1.0+`.
    pub fn instruction_ratio(&self, f: &Footprint) -> f64 {
        f.instructions as f64 / self.instructions as f64
    }

    /// `Err` with a human-readable reason if any ceiling is exceeded.
    pub fn check(&self, f: &Footprint) -> Result<(), String> {
        if f.instructions > self.instructions {
            return Err(format!(
                "instructions {} exceed the per-transaction ceiling {}",
                f.instructions, self.instructions
            ));
        }
        if f.mem_bytes > self.mem_bytes {
            return Err(format!(
                "memory {} bytes exceeds the ceiling {}",
                f.mem_bytes, self.mem_bytes
            ));
        }
        if f.write_entries > self.write_entries {
            return Err(format!(
                "{} written entries exceed the ceiling {}",
                f.write_entries, self.write_entries
            ));
        }
        if f.write_bytes > self.write_bytes {
            return Err(format!(
                "{} written bytes exceed the ceiling {}",
                f.write_bytes, self.write_bytes
            ));
        }
        Ok(())
    }
}

/// **A persistent write must bump rent.**
///
/// The contract-agnostic form of "this contract manages its TTLs". If an
/// invocation wrote persistent state and bumped no persistent rent, it has
/// created or updated an entry it is not paying to keep alive — which under
/// protocol 23 fails silently, because the entry is auto-restored on next
/// access and the only symptom is a cost somebody else pays.
///
/// Requires deployed WASM: a natively-linked contract reports no rent bumps at
/// all and this returns `true` vacuously.
pub fn persistent_write_bumped_rent(f: &Footprint) -> bool {
    f.write_entries == 0 || f.persistent_entry_rent_bumps > 0 || f.temporary_entry_rent_bumps > 0
}

/// **Not a usable oracle — kept as a documented negative result.**
///
/// The obvious archival detector is "live Soroban state is in memory, so a disk
/// read means the host restored an archived entry". It does not hold.
/// `disk_read_entries` counts, in the SDK's own words, *"the total number of
/// restored Soroban ledger entries **and non-Soroban entries (such as 'classic'
/// account balances)**"*.
///
/// Any contract that calls a Stellar Asset Contract therefore reads from "disk"
/// on a perfectly healthy invocation, and asserting `disk_read_entries == 0`
/// fails on a correct contract. This was written as an assertion, fired on the
/// clean build within 90 seconds, and is retained as a predicate only so the
/// mistake is recorded rather than repeated.
///
/// Use [`persistent_write_bumped_rent`] instead: the rent-bump counter measures
/// what the contract *did*, not what the host had to fetch, and does not
/// conflate the two.
#[deprecated(
    note = "conflates archival restoration with classic-account reads; use persistent_write_bumped_rent"
)]
pub fn no_restoration_occurred(f: &Footprint) -> bool {
    f.disk_read_entries == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp() -> Footprint {
        Footprint::default()
    }

    #[test]
    fn ceilings_accept_a_modest_invocation() {
        let f = Footprint {
            instructions: 1_000_000,
            mem_bytes: 1_000_000,
            write_entries: 3,
            write_bytes: 400,
            ..fp()
        };
        assert!(Ceilings::default().check(&f).is_ok());
    }

    #[test]
    fn each_ceiling_is_enforced_independently() {
        let c = Ceilings::default();
        for (label, f) in [
            ("instructions", Footprint { instructions: c.instructions + 1, ..fp() }),
            ("memory", Footprint { mem_bytes: c.mem_bytes + 1, ..fp() }),
            ("entries", Footprint { write_entries: c.write_entries + 1, ..fp() }),
            ("bytes", Footprint { write_bytes: c.write_bytes + 1, ..fp() }),
        ] {
            assert!(c.check(&f).is_err(), "{label} ceiling not enforced");
        }
    }

    #[test]
    fn instruction_ratio_reports_proximity() {
        let c = Ceilings::default();
        let f = Footprint { instructions: c.instructions / 2, ..fp() };
        assert!((c.instruction_ratio(&f) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn a_write_without_a_rent_bump_is_flagged() {
        // The bug_no_ttl shape: state written, nothing paid to keep it alive.
        let f = Footprint { write_entries: 1, persistent_entry_rent_bumps: 0, ..fp() };
        assert!(!persistent_write_bumped_rent(&f));
    }

    #[test]
    fn a_write_with_a_rent_bump_passes() {
        let f = Footprint { write_entries: 1, persistent_entry_rent_bumps: 1, ..fp() };
        assert!(persistent_write_bumped_rent(&f));
    }

    #[test]
    fn an_invocation_that_wrote_nothing_is_not_flagged() {
        // A read-only call owes no rent; flagging it would be a false positive
        // on every view function.
        assert!(persistent_write_bumped_rent(&fp()));
    }

    #[test]
    fn a_temporary_bump_also_counts_as_paying_rent() {
        let f = Footprint { write_entries: 1, temporary_entry_rent_bumps: 1, ..fp() };
        assert!(persistent_write_bumped_rent(&f));
    }

    #[test]
    #[allow(deprecated)]
    fn disk_reads_do_not_identify_restoration() {
        // Retained to document the negative result: this predicate is `false`
        // for an invocation that merely touched a classic account balance, so
        // using it as an oracle fails on a correct contract.
        assert!(!no_restoration_occurred(&Footprint { disk_read_entries: 1, ..fp() }));
    }
}

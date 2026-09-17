//! Ledger position as a fuzzable dimension.
//!
//! Soroban's state archival makes behaviour depend on *when* a call happens, not
//! only on its arguments. That dependence is a **step function**: nothing changes
//! for thousands of ledgers, then an entry lapses and everything does.
//!
//! A uniform `u32` advance lands on one of those steps essentially never, so a
//! harness that draws advances uniformly reports that it exercised state archival
//! while never having crossed a cliff. The fix is to draw from a table built
//! *around* the thresholds that matter, probing each one from both sides.
//!
//! Which thresholds matter is contract-specific — they are whatever the contract
//! passes to `extend_ttl`, plus the host's own floors — so they are supplied by
//! the caller. Building the probe points around them is not.

/// Ledger advances concentrated on TTL cliffs.
#[derive(Debug, Clone)]
pub struct TtlCliffs {
    advances: Vec<u32>,
}

impl TtlCliffs {
    /// Build a probe table around the given thresholds.
    ///
    /// For each threshold `t` the table gets `t - 1`, `t` and `t + 1` — the
    /// three-point probe that distinguishes "just before the cliff", "exactly on
    /// it" and "just past it", which is what tells an off-by-one in a TTL
    /// comparison from a genuine expiry.
    ///
    /// It also always includes `0` and `1` (a step that advances nothing still
    /// has to be representable, and `1` is the smallest real advance), and two
    /// horizons well beyond the largest threshold, so that "everything has
    /// lapsed" is reachable in a single step.
    ///
    /// Pass the contract's own `extend_ttl` arguments and the host's
    /// `min_persistent_entry_ttl` / `min_temp_entry_ttl`. Duplicates and
    /// overflowing values are removed.
    pub fn around(thresholds: &[u32]) -> Self {
        let mut advances = vec![0u32, 1];
        for t in thresholds {
            for probe in [t.saturating_sub(1), *t, t.saturating_add(1)] {
                advances.push(probe);
            }
        }
        let max = thresholds.iter().copied().max().unwrap_or(0);
        advances.push(max.saturating_mul(2));
        advances.push(max.saturating_add(max / 2));

        advances.sort_unstable();
        advances.dedup();
        Self { advances }
    }

    /// A table with no cliffs — only `0` and `1`. For contracts that do not
    /// manage TTLs at all; using it says so explicitly rather than by omission.
    pub fn none() -> Self {
        Self {
            advances: vec![0, 1],
        }
    }

    /// Map one fuzzer byte onto an advance.
    pub fn pick(&self, byte: u8) -> u32 {
        self.advances[byte as usize % self.advances.len()]
    }

    /// The probe points, ascending.
    pub fn advances(&self) -> &[u32] {
        &self.advances
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_threshold_is_probed_from_both_sides() {
        let c = TtlCliffs::around(&[17_280, 518_400]);
        for t in [17_280u32, 518_400] {
            assert!(c.advances().contains(&(t - 1)), "missing {t}-1");
            assert!(c.advances().contains(&t), "missing {t}");
            assert!(c.advances().contains(&(t + 1)), "missing {t}+1");
        }
    }

    #[test]
    fn zero_and_one_are_always_present() {
        let c = TtlCliffs::around(&[42]);
        assert!(c.advances().contains(&0));
        assert!(c.advances().contains(&1));
    }

    #[test]
    fn a_horizon_beyond_every_threshold_is_reachable_in_one_step() {
        let c = TtlCliffs::around(&[100, 5_000]);
        assert!(c.advances().iter().any(|a| *a > 5_000));
    }

    #[test]
    fn table_is_sorted_and_deduplicated() {
        // Adjacent thresholds produce overlapping probes.
        let c = TtlCliffs::around(&[100, 101]);
        let mut sorted = c.advances().to_vec();
        sorted.sort_unstable();
        assert_eq!(sorted, c.advances());
        let mut deduped = sorted.clone();
        deduped.dedup();
        assert_eq!(deduped, c.advances());
    }

    #[test]
    fn saturates_at_the_type_boundary() {
        let c = TtlCliffs::around(&[u32::MAX, 0]);
        assert!(c.advances().contains(&u32::MAX));
        assert!(c.advances().contains(&0));
        assert!(c.pick(7) <= u32::MAX);
    }

    #[test]
    fn every_byte_picks_a_valid_advance() {
        let c = TtlCliffs::around(&[17_280, 518_400, 1_036_800]);
        for b in 0..=255u8 {
            assert!(c.advances().contains(&c.pick(b)));
        }
    }

    #[test]
    fn none_has_no_cliffs() {
        assert_eq!(TtlCliffs::none().advances(), &[0, 1]);
    }
}

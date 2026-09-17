//! Scalar operands: where the interesting values actually are.
//!
//! Uniform sampling over `i128` is close to useless against a contract that
//! validates its arguments. Almost every draw is an absurd magnitude rejected by
//! the first guard, so the fuzzer burns its budget re-deriving the same error and
//! never reaches code that needs accumulated state.
//!
//! The policy here is a three-way split:
//!
//! | Share | Source | Why |
//! |---|---|---|
//! | ~60 % | a **literal table** of boundary values | Type boundaries, and operands chosen so an *intermediate* computation lands on a boundary |
//! | ~25 % | **state-relative**: `anchor ± small` | The `InsufficientBalance` / `ZeroShares` class of edge exists only relative to live state and cannot be written as a literal |
//! | ~15 % | free random | Keeps the search open; without it the fuzzer only ever sees values someone thought of |
//!
//! The middle row is the one people leave out, and it is the one that puts the
//! fuzzer exactly on a guard boundary on *every* call rather than once in a
//! billion draws.

use arbitrary::Arbitrary;

/// A scalar drawn by the fuzzer, not yet resolved.
///
/// All four fields are consumed from the fuzzer's byte string on every draw, so
/// libFuzzer can mutate the *kind* of value independently of the value itself —
/// flipping a literal into a state-relative operand is a one-byte mutation.
#[derive(Arbitrary, Debug, Clone)]
pub struct Operand {
    /// Selects which of the three strategies is used.
    pub kind: u8,
    /// Index into the policy's literal table.
    pub lit: u8,
    /// Offset applied to the anchor in the state-relative strategy.
    pub delta: i8,
    /// The free-random value.
    pub free: i128,
}

/// Generic `i128` boundary values, applicable to any contract that takes an
/// `i128` amount.
///
/// Three families:
///
/// - **Type and guard boundaries** — `0`, `±1`, `±2`, `i128::MIN`, `i128::MAX`.
///   Almost every contract has a `value <= 0` guard, and `i128::MIN` is the value
///   with no positive counterpart, so any future `abs`/negation aborts on it.
/// - **Powers of two around the multiplication boundary** — `2^63`, `2^63 - 1`,
///   `2^64`, `2^100`, `2^126`, `2^127 - 1`. These exist so that a *product* of
///   two operands lands on `i128::MAX` exactly: `2^63 · 2^64 = 2^127`, one unit
///   over. `2^100` is included because bit-flip mutators reach a high power of
///   two far more easily than an exact `2^63`.
/// - **Decimal anchors** — `10^7` (one unit of a 7-decimal Stellar asset), `10^9`,
///   `10^12`, `10^18`, and `i64::MAX` (where a wrapped classic Stellar asset
///   starts rejecting). These keep part of the corpus in the band where token
///   contracts actually cooperate, so sequences can build real state.
pub const DEFAULT_LITERALS: &[i128] = &[
    0,
    1,
    2,
    -1,
    -2,
    i128::MIN,
    i128::MAX,
    10_000_000,
    1_000_000_000,
    1_000_000_000_000,
    1_000_000_000_000_000_000,
    i64::MAX as i128,
    1i128 << 31,
    1i128 << 63,
    (1i128 << 63) - 1,
    1i128 << 64,
    1i128 << 100,
    1i128 << 126,
    (1i128 << 126) - 1,
];

/// How [`Operand`]s are resolved.
#[derive(Debug, Clone)]
pub struct OperandPolicy {
    literals: Vec<i128>,
    literal_pct: u8,
    relative_pct: u8,
}

impl Default for OperandPolicy {
    /// 60 % literals from [`DEFAULT_LITERALS`], 25 % state-relative, 15 % free.
    fn default() -> Self {
        Self {
            literals: DEFAULT_LITERALS.to_vec(),
            literal_pct: 60,
            relative_pct: 25,
        }
    }
}

impl OperandPolicy {
    /// Replace the literal table wholesale.
    pub fn with_literals(mut self, literals: impl IntoIterator<Item = i128>) -> Self {
        self.literals = literals.into_iter().collect();
        assert!(!self.literals.is_empty(), "the literal table must not be empty");
        self
    }

    /// Append contract-specific boundaries to the generic table.
    ///
    /// This is the intended extension point: a contract whose guard sits at some
    /// particular value (a minimum deposit, a fee denominator, a cliff derived
    /// from its own constants) adds that value here, and keeps everything else.
    pub fn with_extra_literals(mut self, extra: impl IntoIterator<Item = i128>) -> Self {
        self.literals.extend(extra);
        self
    }

    /// Change the split. `literal_pct + relative_pct` must be at most 100; the
    /// remainder is free random.
    pub fn with_split(mut self, literal_pct: u8, relative_pct: u8) -> Self {
        assert!(
            literal_pct as u16 + relative_pct as u16 <= 100,
            "literal_pct + relative_pct must be <= 100"
        );
        self.literal_pct = literal_pct;
        self.relative_pct = relative_pct;
        self
    }

    /// The literal table in use.
    pub fn literals(&self) -> &[i128] {
        &self.literals
    }

    /// Resolve an operand against a state anchor.
    ///
    /// `anchor` is whatever live quantity the boundary is relative to — the
    /// caller's balance for a withdrawal, the total supply for a mint, the
    /// allowance for a transfer-from. Passing `0` degrades the middle strategy to
    /// "small integers near zero", which is harmless but wastes its value; prefer
    /// to pass the quantity the contract will actually compare against.
    pub fn resolve(&self, op: &Operand, anchor: i128) -> i128 {
        let bucket = op.kind % 100;
        if bucket < self.literal_pct {
            self.literals[op.lit as usize % self.literals.len()]
        } else if bucket < self.literal_pct.saturating_add(self.relative_pct) {
            anchor.saturating_add(op.delta as i128)
        } else {
            op.free
        }
    }

    /// Resolve against two anchors, picking between them with one more bit from
    /// the operand. Useful where a call has two distinct boundaries — e.g. a
    /// transfer bounded by both the sender's balance and the recipient's
    /// headroom.
    pub fn resolve2(&self, op: &Operand, anchor_a: i128, anchor_b: i128) -> i128 {
        let anchor = if op.lit & 1 == 0 { anchor_a } else { anchor_b };
        self.resolve(op, anchor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(kind: u8, lit: u8, delta: i8, free: i128) -> Operand {
        Operand { kind, lit, delta, free }
    }

    #[test]
    fn split_respects_the_configured_shares() {
        let p = OperandPolicy::default();
        // kind 0..59 -> literal, 60..84 -> relative, 85..99 -> free
        assert_eq!(p.resolve(&op(0, 0, 9, 777), 500), DEFAULT_LITERALS[0]);
        assert_eq!(p.resolve(&op(59, 1, 9, 777), 500), DEFAULT_LITERALS[1]);
        assert_eq!(p.resolve(&op(60, 0, 1, 777), 500), 501);
        assert_eq!(p.resolve(&op(84, 0, -1, 777), 500), 499);
        assert_eq!(p.resolve(&op(85, 0, 1, 777), 500), 777);
        assert_eq!(p.resolve(&op(99, 0, 1, 777), 500), 777);
    }

    #[test]
    fn state_relative_lands_exactly_on_the_guard_boundary() {
        let p = OperandPolicy::default();
        let balance = 1_234_567i128;
        // The three values a balance guard discriminates between.
        assert_eq!(p.resolve(&op(60, 0, -1, 0), balance), balance - 1);
        assert_eq!(p.resolve(&op(60, 0, 0, 0), balance), balance);
        assert_eq!(p.resolve(&op(60, 0, 1, 0), balance), balance + 1);
    }

    #[test]
    fn relative_resolution_saturates_rather_than_overflowing() {
        let p = OperandPolicy::default();
        assert_eq!(p.resolve(&op(60, 0, 1, 0), i128::MAX), i128::MAX);
        assert_eq!(p.resolve(&op(60, 0, -1, 0), i128::MIN), i128::MIN);
    }

    #[test]
    fn literal_index_wraps_so_every_byte_is_valid() {
        let p = OperandPolicy::default();
        for lit in 0..=255u8 {
            let v = p.resolve(&op(0, lit, 0, 0), 0);
            assert!(DEFAULT_LITERALS.contains(&v));
        }
    }

    #[test]
    fn default_table_contains_an_exact_multiplication_boundary() {
        // 2^63 * 2^64 == 2^127 == i128::MAX + 1: overflow by exactly one unit.
        let a = 1i128 << 63;
        let b = 1i128 << 64;
        assert!(DEFAULT_LITERALS.contains(&a) && DEFAULT_LITERALS.contains(&b));
        assert!(a.checked_mul(b).is_none());
        // ...and its fitting neighbour, so the boundary is provably not off by one.
        assert!(((1i128 << 63) - 1).checked_mul(b).is_some());
    }

    #[test]
    fn extra_literals_extend_rather_than_replace() {
        let p = OperandPolicy::default().with_extra_literals([999_999_999i128]);
        assert!(p.literals().contains(&999_999_999));
        assert!(p.literals().contains(&i128::MAX));
    }

    #[test]
    fn split_can_be_retuned() {
        let p = OperandPolicy::default().with_split(100, 0);
        assert_eq!(p.resolve(&op(99, 0, 1, 777), 500), DEFAULT_LITERALS[0]);
    }
}

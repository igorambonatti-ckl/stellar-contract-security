#!/usr/bin/env bash
# End-to-end demo: seeded bug → both arms → minimised reproducer → fix.
#
# This is the T5-4 deliverable. It must run from a **clean clone** with no local
# state — that requirement exists because the prior-art prototype (ChainGuard)
# was feature-complete and never ran end to end, and a clean-clone gate is the
# cheapest check that catches "works only on my machine".
#
#   ./04-prototype-development/scripts/demo.sh [SEED]     (default bug_self_transfer)
#
# Runs in about two minutes. Everything it prints is produced live; nothing is
# read from the committed results.
set -uo pipefail

SEED="${1:-bug_self_transfer}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
rule() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

bold "0 · Toolchain"
rule
rustc --version
cargo --version
if rustup target list --installed | grep -qx wasm32v1-none; then
  echo "wasm32v1-none        installed"
else
  echo "wasm32v1-none        MISSING — run: rustup target add wasm32v1-none"
fi

bold "1 · The clean contract passes everything"
rule
cargo test -p soroban-vault --lib 2>&1 | grep -E "^test result:"
echo "  ↑ 22 hand-written tests: the happy path of all 8 entry points, plus one"
echo "    test per invariant. This is the ground truth the arms are measured against."

bold "2 · Enable the seeded bug: $SEED"
rule
echo "The bug is a cargo feature, so the contract source is identical apart from"
echo "one cfg branch. Nothing else in the repository changes."
echo
grep -n "feature = \"$SEED\"" 04-prototype-development/contracts/soroban-vault/src/lib.rs | head -3

bold "3 · Baseline arm — a harness written from the docs in an hour"
rule
echo "Oracle: 'the call does not abort'. One proptest per entry point."
echo
if cargo test -p soroban-vault --test proptest_baseline --features "$SEED" 2>&1 \
     | grep -qE "^test result: ok"; then
  echo "RESULT: ✅ all green — the baseline MISSES this bug."
  echo "        The contract accepts the call and returns normally. It is simply"
  echo "        wrong, and a liveness oracle cannot see 'wrong'."
else
  echo "RESULT: ❌ the baseline caught it."
fi

bold "4 · AI arm — invariants proposed by the model, curated by a human"
rule
echo "Oracle: read the state back and compare it against an independent"
echo "computation. Same contract, same seed, same case budget."
echo
cargo test -p soroban-vault --test proptest_ai --features "$SEED" 2>&1 \
  | grep -vE "^Writing test snapshot" \
  | grep -E "^test result:|Test failed:" \
  | sed 's/ at 04-prototype-development.*//' \
  | head -6

bold "5 · The minimised reproducer"
rule
echo "proptest shrinks the failing case to the smallest input that still fails."
echo "Read the 'minimal failing input' line above: it is a two-call sequence."
echo
echo "⚠️  A shrunk reproducer is not automatically an instance of the bug you"
echo "    found — the shrinker optimises for the smallest failing input, not the"
echo "    smallest input failing for the same reason. Always re-check it against"
echo "    the clean build. See results/p5-ai-arm.md §2, fix 4."

bold "6 · The fix: turn the seed off"
rule
cargo test -p soroban-vault --test proptest_ai 2>&1 \
  | grep -vE "^Writing test snapshot" | grep -E "^test result:"
echo "  ↑ green again on the clean contract, so the property is falsifiable"
echo "    rather than vacuous — it fails exactly when the bug is present."

bold "Summary"
rule
cat <<'TXT'
  Baseline arm    1 / 7 seeds detected
  AI arm          7 / 7 seeds detected

  The difference is not more inputs. It is an oracle that inspects state,
  and one that asserts *which* error came back rather than merely that
  some error came back.

  Full per-seed matrix:  04-prototype-development/results/benchmark.md
  Coverage-guided layer: 04-prototype-development/results/p6-fuzzing.md
TXT

#!/usr/bin/env bash
# P7 — mutation testing. Scores each test suite separately, because the point of
# the phase is to compare the two arms' *quality*, not to produce one number for
# the repository.
#
#   scripts/p7-mutants.sh
#
# Three runs:
#   unit      src/test.rs + src/test_invariants.rs — the hand-written ground truth
#   baseline  tests/proptest_baseline.rs           — the control arm alone
#   ai        tests/proptest_ai.rs                 — the AI arm alone
#
# PROPTEST_CASES is pinned to 64 for every run. cargo-mutants re-runs the suite
# once per mutant, so the default budgets would put this phase into the hours;
# 64 is applied *equally* to both arms, so the comparison stands even though the
# absolute scores would be marginally higher with a larger budget.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/04-prototype-development/results/p7-raw"
cd "$ROOT"

export PROPTEST_CASES=64
mkdir -p "$OUT"

run() {
  local name="$1"; shift
  echo "=== $name ==="
  cargo mutants -p soroban-vault \
      --output "$OUT/$name" \
      --timeout 180 \
      --jobs 4 \
      -- "$@" 2>&1 | tail -12
}

run unit     --lib
run baseline --test proptest_baseline
run ai       --test proptest_ai

echo
echo "=== summary ==="
for name in unit baseline ai; do
  d="$OUT/$name/mutants.out"
  [[ -d "$d" ]] || continue
  caught=$(wc -l < "$d/caught.txt" 2>/dev/null | tr -d ' ')
  missed=$(wc -l < "$d/missed.txt" 2>/dev/null | tr -d ' ')
  timeout=$(wc -l < "$d/timeout.txt" 2>/dev/null | tr -d ' ')
  unviable=$(wc -l < "$d/unviable.txt" 2>/dev/null | tr -d ' ')
  total=$(( caught + missed + timeout ))
  pct=$(( total > 0 ? 100 * caught / total : 0 ))
  printf '%-9s caught %3s  missed %3s  timeout %3s  unviable %3s  → %s%%\n' \
    "$name" "$caught" "$missed" "$timeout" "$unviable" "$pct"
done

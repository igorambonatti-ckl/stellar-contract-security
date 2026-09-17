#!/usr/bin/env bash
# P6 — coverage-guided fuzzing matrix: two arms × (clean + 7 seeds).
#
# Records time-to-first-crash (TTFC) per arm per seed, or "not found within
# budget", which is a valid result and is reported as such.
#
# Usage:  scripts/p6-fuzz-matrix.sh [BUDGET_SECONDS]      (default 300)
#
# Seed selection goes through the `default` feature in fuzz/Cargo.toml rather
# than `cargo fuzz --features`, which cargo-fuzz 0.13.2 silently ignores. Each
# build is *verified* to have picked up the seed by requiring `soroban-vault` to
# recompile; a build that comes back entirely "Fresh" aborts the run rather than
# recording a false "missed".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FUZZ_DIR="04-prototype-development/fuzz"
MANIFEST="$ROOT/$FUZZ_DIR/Cargo.toml"
OUT="$ROOT/04-prototype-development/results/p6-raw.tsv"
CRASHES="$ROOT/04-prototype-development/results/crashes"
BUDGET="${1:-300}"

SEEDS=(clean bug_overflow bug_missing_auth bug_zero_amount bug_self_transfer \
       bug_no_ttl bug_temp_nonce bug_reinit)
ARMS=(vault_baseline vault_ai)

mkdir -p "$CRASHES"
printf 'arm\tseed\tverdict\tttfc_seconds\truns\tartifact\n' > "$OUT"

restore_manifest() { set_seed clean; }
trap restore_manifest EXIT

set_seed() {
  local seed="$1"
  if [[ "$seed" == clean ]]; then
    perl -0pi -e 's/^default = \[.*\]$/default = []/m' "$MANIFEST"
  else
    perl -0pi -e "s/^default = \\[.*\\]\$/default = [\"$seed\"]/m" "$MANIFEST"
  fi
}

for seed in "${SEEDS[@]}"; do
  set_seed "$seed"

  for arm in "${ARMS[@]}"; do
    echo "=== $arm / $seed (budget ${BUDGET}s) ==="

    # Build, and verify the seed actually reached the contract crate.
    build_log="$(cd "$ROOT" && cargo +nightly fuzz build --fuzz-dir "$FUZZ_DIR" \
                   --sanitizer none "$arm" 2>&1)"
    if [[ $? -ne 0 ]]; then
      echo "BUILD FAILED for $arm/$seed"; echo "$build_log" | tail -20; exit 1
    fi
    if [[ "$seed" != clean ]] && ! grep -q "Compiling soroban-vault v" <<<"$build_log"; then
      echo "ABORT: '$seed' did not trigger a rebuild of soroban-vault — the"
      echo "feature did not take effect and the result would be a false 'missed'."
      exit 1
    fi

    # Fresh corpus per cell, so one arm's accumulated corpus cannot flatter the
    # other and a TTFC is measured from a cold start.
    corpus="$ROOT/$FUZZ_DIR/corpus/${arm}_${seed}"
    rm -rf "$corpus"; mkdir -p "$corpus"

    start=$(date +%s)
    run_log="$(cd "$ROOT" && cargo +nightly fuzz run --fuzz-dir "$FUZZ_DIR" \
                 --sanitizer none "$arm" "$corpus" -- \
                 -max_total_time="$BUDGET" -print_final_stats=1 2>&1)"
    elapsed=$(( $(date +%s) - start ))

    runs="$(grep -oE 'stat::number_of_executed_units: *[0-9]+' <<<"$run_log" \
            | grep -oE '[0-9]+' | tail -1)"
    runs="${runs:-0}"

    artifact="$(grep -oE 'artifacts/[^ ]*/(crash|panic)-[a-f0-9]+' <<<"$run_log" | tail -1)"

    if [[ -n "$artifact" ]]; then
      verdict=detected
      # Minimise the reproducer and keep it permanently.
      if (cd "$ROOT" && cargo +nightly fuzz tmin --fuzz-dir "$FUZZ_DIR" \
            --sanitizer none "$arm" "$ROOT/$FUZZ_DIR/$artifact" >/dev/null 2>&1); then :; fi
      dest="$CRASHES/${arm}_${seed}"
      cp "$ROOT/$FUZZ_DIR/$artifact" "$dest.input" 2>/dev/null
      grep -E 'thread .* panicked|assertion|I[0-9]+ violated|N[0-9]+ violated|Error\(Contract' \
        <<<"$run_log" | head -5 > "$dest.txt"
      echo "  DETECTED in ${elapsed}s after ${runs} runs"
    else
      verdict=missed
      elapsed=""
      echo "  not found within ${BUDGET}s (${runs} runs)"
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$arm" "$seed" "$verdict" "$elapsed" "$runs" "${artifact:-}" >> "$OUT"
  done
done

echo
echo "=== matrix written to $OUT ==="
column -t -s $'\t' "$OUT"

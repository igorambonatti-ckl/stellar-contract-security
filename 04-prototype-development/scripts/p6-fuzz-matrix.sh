#!/usr/bin/env bash
# P6 — coverage-guided fuzzing matrix: two arms × (clean + 7 seeds).
#
# Records time-to-first-crash (TTFC) per arm per seed, or "not found within
# budget", which is a valid result and is reported as such.
#
#   scripts/p6-fuzz-matrix.sh [BUDGET_SECONDS]      (default 300)
#
# Resumable: cells already present in results/p6-raw.tsv are skipped, so an
# aborted run can be continued without discarding hours of measurement.
#
# ── Why the seed is selected by editing Cargo.toml ───────────────────────────
# `cargo fuzz --features` is accepted and silently dropped by cargo-fuzz 0.13.2
# (`cargo fuzz build -v --features X` shows every crate "Fresh"). Plain
# `cargo build --features X` in the same directory honours it. So the seed goes
# through the `default` feature instead.
#
# That substitution is *verified*, not assumed: the first cell of each seed
# group must show `soroban-vault` recompiling. A run that silently fuzzed the
# clean contract while claiming to fuzz a seed would report a false "missed",
# which is exactly the failure this script exists to avoid.
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
[[ -s "$OUT" ]] || printf 'arm\tseed\tverdict\tttfc_seconds\truns\tartifact\n' > "$OUT"

set_seed() {
  if [[ "$1" == clean ]]; then
    perl -0pi -e 's/^default = \[.*\]$/default = []/m' "$MANIFEST"
  else
    perl -0pi -e "s/^default = \\[.*\\]\$/default = [\"$1\"]/m" "$MANIFEST"
  fi
}

# Always leave the manifest on the clean contract, however this exits.
trap 'set_seed clean' EXIT

for seed in "${SEEDS[@]}"; do
  set_seed "$seed"

  # Guard: the manifest must actually say what we think it says.
  if [[ "$seed" == clean ]]; then
    grep -qx 'default = \[\]' "$MANIFEST" || { echo "manifest not clean"; exit 1; }
  else
    grep -qx "default = \[\"$seed\"\]" "$MANIFEST" || { echo "manifest not set to $seed"; exit 1; }
  fi

  first_arm_of_group=1

  for arm in "${ARMS[@]}"; do
    # (`grep -P` is unavailable on macOS and fails silently, which on the first
    # attempt made every cell re-run instead of resuming — hence awk.)
    if awk -F'\t' -v a="$arm" -v s="$seed" '$1==a && $2==s {f=1} END{exit !f}' "$OUT"; then
      echo "=== $arm / $seed — already recorded, skipping ==="
      first_arm_of_group=0
      continue
    fi

    echo "=== $arm / $seed (budget ${BUDGET}s) ==="

    build_log="$(cd "$ROOT" && cargo +nightly fuzz build --fuzz-dir "$FUZZ_DIR" \
                   --sanitizer none "$arm" 2>&1)"
    if [[ $? -ne 0 ]]; then
      echo "BUILD FAILED for $arm/$seed"; echo "$build_log" | tail -20; exit 1
    fi

    # Only the first arm of a seed group is expected to recompile the contract;
    # the second arm legitimately reuses that build.
    if (( first_arm_of_group )) && [[ "$seed" != clean ]] \
       && ! grep -q "Compiling soroban-vault v" <<<"$build_log"; then
      echo "ABORT: '$seed' did not recompile soroban-vault — the feature did not"
      echo "take effect, and the result would be a false 'missed'."
      exit 1
    fi
    first_arm_of_group=0

    # Fresh corpus per cell, so one arm's accumulated corpus cannot flatter the
    # other and TTFC is measured from a cold start.
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
      dest="$CRASHES/${arm}_${seed}"
      # Minimise the reproducer, then keep it permanently.
      (cd "$ROOT" && cargo +nightly fuzz tmin --fuzz-dir "$FUZZ_DIR" \
         --sanitizer none "$arm" "$ROOT/$FUZZ_DIR/$artifact" >/dev/null 2>&1) || true
      cp "$ROOT/$FUZZ_DIR/$artifact" "$dest.input" 2>/dev/null
      {
        echo "# $arm / $seed — first crash after ${elapsed}s, ${runs} runs"
        grep -E "panicked|assertion|I[0-9]+'? (broken|violated)|N[0-9]+ (broken|violated)|Error\(Contract" \
          <<<"$run_log" | head -6
      } > "$dest.txt"
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

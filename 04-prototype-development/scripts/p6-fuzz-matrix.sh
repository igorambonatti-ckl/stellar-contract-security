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
# That substitution is *verified*, not assumed — a run that silently fuzzed the
# clean contract while claiming to fuzz a seed would report a false "missed",
# which is exactly the failure this script exists to avoid.
#
# Verification is `cargo tree -e features -i soroban-vault`, which prints the
# feature set cargo actually resolved. Two weaker checks were tried first and
# both produced false alarms:
#
#   * "the contract must recompile" — cargo caches artifacts per feature set, so
#     a seed built in an earlier session legitimately does not rebuild;
#   * "the second arm must recompile too" — it correctly reuses the first arm's
#     build.
#
# Only the resolved feature set is authoritative.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FUZZ_DIR="04-prototype-development/fuzz"
MANIFEST="$ROOT/$FUZZ_DIR/Cargo.toml"
# Overridable so a second round can be measured into its own file without
# discarding the first, and so a single arm can be re-run in isolation.
OUT="${P6_OUT:-$ROOT/04-prototype-development/results/p6-raw.tsv}"
CRASHES="$ROOT/04-prototype-development/results/crashes"
BUDGET="${1:-300}"
# Per-unit timeout. libFuzzer only consults `-max_total_time` *between* runs, so
# a single pathological input stalls the whole cell: the WASM arm's first matrix
# spent 997 seconds on one input and reported ~1 000 executions per cell instead
# of ~100 000, which read as "detects nothing" when it had barely run. With this
# set, a unit that blows the budget is reported as a crash — which is also the
# right semantics, since an invocation that slow is one that cannot be submitted
# on-chain.
UNIT_TIMEOUT="${P6_UNIT_TIMEOUT:-20}"

SEEDS=(clean bug_overflow bug_missing_auth bug_zero_amount bug_self_transfer \
       bug_no_ttl bug_temp_nonce bug_reinit)
read -r -a ARMS <<< "${P6_ARMS:-vault_baseline vault_ai}"

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

  # Guard: cargo must have *resolved* the feature we think we set. This is the
  # check that would have caught the silently-dropped `--features` flag.
  resolved="$(cd "$ROOT/$FUZZ_DIR" && cargo tree -e features -i soroban-vault 2>/dev/null \
              | grep -oE 'soroban-vault feature "bug_[a-z_]+"' | sed 's/.*"\(.*\)"/\1/' | sort -u)"
  if [[ "$seed" == clean ]]; then
    if [[ -n "$resolved" ]]; then
      echo "ABORT: expected no seed feature, cargo resolved: $resolved"; exit 1
    fi
  elif [[ "$resolved" != "$seed" ]]; then
    echo "ABORT: expected seed '$seed', cargo resolved: '${resolved:-<none>}'."
    echo "The seed did not take effect and the result would be a false 'missed'."
    exit 1
  fi
  echo "--- seed verified: ${resolved:-clean}"

  for arm in "${ARMS[@]}"; do
    # (`grep -P` is unavailable on macOS and fails silently, which on the first
    # attempt made every cell re-run instead of resuming — hence awk.)
    if awk -F'\t' -v a="$arm" -v s="$seed" '$1==a && $2==s {f=1} END{exit !f}' "$OUT"; then
      echo "=== $arm / $seed — already recorded, skipping ==="
      continue
    fi

    echo "=== $arm / $seed (budget ${BUDGET}s) ==="

    build_log="$(cd "$ROOT" && cargo +nightly fuzz build --fuzz-dir "$FUZZ_DIR" \
                   --sanitizer none "$arm" 2>&1)"
    if [[ $? -ne 0 ]]; then
      echo "BUILD FAILED for $arm/$seed"; echo "$build_log" | tail -20; exit 1
    fi

    # Fresh corpus per cell, so one arm's accumulated corpus cannot flatter the
    # other and TTFC is measured from a cold start.
    corpus="$ROOT/$FUZZ_DIR/corpus/${arm}_${seed}"
    rm -rf "$corpus"; mkdir -p "$corpus"

    start=$(date +%s)
    run_log="$(cd "$ROOT" && cargo +nightly fuzz run --fuzz-dir "$FUZZ_DIR" \
                 --sanitizer none "$arm" "$corpus" -- \
                 -max_total_time="$BUDGET" -timeout="$UNIT_TIMEOUT" \
                 -print_final_stats=1 2>&1)"
    elapsed=$(( $(date +%s) - start ))

    runs="$(grep -oE 'stat::number_of_executed_units: *[0-9]+' <<<"$run_log" \
            | grep -oE '[0-9]+' | tail -1)"
    runs="${runs:-0}"
    # `timeout-` artifacts count: a unit that exceeds the per-unit budget is a
    # detection, not a stall to be discarded.
    artifact="$(grep -oE 'artifacts/[^ ]*/(crash|panic|timeout)-[a-f0-9]+' <<<"$run_log" | tail -1)"

    if [[ -n "$artifact" ]]; then
      verdict=detected
      dest="$CRASHES/${arm}_${seed}"
      # Minimise the reproducer, then keep it permanently.
      (cd "$ROOT" && cargo +nightly fuzz tmin --fuzz-dir "$FUZZ_DIR" \
         --sanitizer none "$arm" "$ROOT/$FUZZ_DIR/$artifact" >/dev/null 2>&1) || true
      cp "$ROOT/$FUZZ_DIR/$artifact" "$dest.input" 2>/dev/null
      {
        echo "# $arm / $seed — first crash after ${elapsed}s, ${runs} runs"
        grep -E "panicked|assertion|I[0-9]+'? (broken|violated)|[NR][0-9]+ (broken|violated)|ERROR: libFuzzer: timeout|Slowest unit|Error\(Contract" \
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

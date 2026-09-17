#!/usr/bin/env bash
# Coverage of `soroban-vault`, per arm.
#
#   scripts/coverage.sh [LABEL]
#
# Answers the question the seeded-bug benchmark cannot: does the coverage-guided
# fuzzer reach code the hand-written proptest strategies never reach? Detection
# counts say what each arm *caught*; this says what each arm *saw*.
#
# The fuzz arms are measured with `cargo fuzz coverage` over the corpus that
# campaign produced. The proptest arms are measured with `cargo llvm-cov`, which
# instruments the same source, so the region counts are comparable.
#
# Writes results/coverage-<LABEL>.tsv.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FUZZ_DIR="04-prototype-development/fuzz"
LABEL="${1:-current}"
OUT="$ROOT/04-prototype-development/results/coverage-${LABEL}.tsv"
SRC="$ROOT/04-prototype-development/contracts/soroban-vault/src/lib.rs"
# The nightly toolchain's own llvm-cov: Xcode's is older than the LLVM that
# produced the profile and rejects it with "unsupported instrumentation profile
# format version".
LLVM="$HOME/.rustup/toolchains/nightly-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin"
IGNORE='(registry|rustc|fuzz_targets|fuzzkit|/tests/)'

cd "$ROOT"
printf 'arm\tregions\tmissed\tregion_cov\tlines\tmissed_lines\tline_cov\n' > "$OUT"

report_row() {  # $1 = arm label, $2 = binary, $3 = profdata
  local row
  row="$("$LLVM/llvm-cov" report "$2" -instr-profile="$3" \
          -ignore-filename-regex="$IGNORE" 2>/dev/null \
        | awk -v src="$SRC" '$1==src {print $2"\t"$3"\t"$4"\t"$8"\t"$9"\t"$10}')"
  if [[ -z "$row" ]]; then
    echo "  !! no coverage rows for $1"; return 1
  fi
  printf '%s\t%s\n' "$1" "$row" >> "$OUT"
  echo "  $1: $row"
}

# ── Fuzz arms ────────────────────────────────────────────────────────────────
for arm in vault_baseline vault_ai; do
  corpus="$ROOT/$FUZZ_DIR/corpus/${arm}_clean"
  [[ -d "$corpus" ]] || { echo "skip $arm — no corpus at $corpus"; continue; }
  echo "=== $arm ($(ls "$corpus" | wc -l | tr -d ' ') corpus inputs) ==="
  cargo +nightly fuzz coverage --fuzz-dir "$FUZZ_DIR" --sanitizer none "$arm" "$corpus" \
    >/dev/null 2>&1
  report_row "fuzz_$arm" \
    "$ROOT/target/aarch64-apple-darwin/coverage/aarch64-apple-darwin/release/$arm" \
    "$ROOT/$FUZZ_DIR/coverage/$arm/coverage.profdata"
done

# ── proptest arms ────────────────────────────────────────────────────────────
for t in proptest_baseline proptest_ai; do
  echo "=== $t ==="
  cargo llvm-cov --no-report clean --workspace >/dev/null 2>&1
  PROPTEST_CASES="${PROPTEST_CASES:-256}" \
    cargo llvm-cov --no-report -p soroban-vault --test "$t" >/dev/null 2>&1
  cargo llvm-cov report --ignore-filename-regex "$IGNORE" 2>/dev/null \
    | awk -v src="lib.rs" -v arm="$t" '$1 ~ src {print arm"\t"$2"\t"$3"\t"$4"\t"$8"\t"$9"\t"$10}' \
    >> "$OUT"
  tail -1 "$OUT" | sed 's/^/  /'
done

echo
echo "=== $OUT ==="
column -t -s $'\t' "$OUT"

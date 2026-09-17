# Prompt P3 — Prioritise inputs

**Version:** 1.0 · **Model:** Claude Opus 5 (`claude-opus-5`) · **Insertion point:** Topic 3 §6, row P3

**Input:** the clean contract view (`prompts/inputs/vault-clean.rs`) — signatures and bodies.
**Output:** per-type edge-case tables and suspicious call sequences, saved verbatim to
`prompts/raw/prioritise-inputs.out.md`, then folded into the harness's generation strategies.

> Same integrity rule as [P1](propose-invariants.md): the model sees the clean contract view only.

---

## The prompt

You are tuning the **input generators** for a fuzzing campaign against the Soroban contract whose
source is provided. The harness already exists; what it lacks is a good prior over *which* values
and *which call orders* are worth spending budget on.

Random uniform sampling over `i128` is close to useless — almost every draw is an absurd magnitude
that the contract rejects in its first guard, so the fuzzer never reaches the interesting code. Your
job is to say where the interesting values actually are.

### Part 1 — Per-argument edge-case tables

For every public entry point, and every argument of it, produce a table:

| Argument | Type | Values worth trying | Why this value is interesting |
|---|---|---|---|

Cover at minimum: boundary values of the type, boundary values of the *contract's own guards*,
values that are individually valid but jointly pathological, and values chosen so that an
intermediate computation — not the argument itself — lands on a boundary. For the last category be
explicit about the arithmetic: if you want a product to land near a power of two, say which operands
produce it.

Note the platform detail that the workspace compiles with `overflow-checks` enabled, so a value that
merely overflows a native `+` aborts the call rather than silently wrapping.

### Part 2 — Address arguments

Addresses cannot be usefully sampled at random in this harness: a freshly generated `Address` cannot
be authorized, so every property about *who* is acting would collapse to "an unknown caller is
rejected". Assume instead a **fixed pool of pre-registered principals**, and that what gets fuzzed is
an **index into the pool**. Given that, say which principals the pool should contain, and which
index combinations are worth prioritising.

### Part 3 — Call sequences

Single calls find shallow bugs. State-dependent faults need an ordering. Propose ranked **call
sequences** (2–5 calls) that are worth using as corpus seeds, each with:

| Sequence | What state it builds | What it would expose |
|---|---|---|

Prioritise sequences that establish non-trivial state before the call under test, that interleave
distinct principals, and that advance the ledger between calls where the contract's behaviour can
depend on ledger position.

### Discipline

- Derive everything from the code in front of you. Do not speculate about bugs that may have been
  planted; reason about where the code's own structure makes a mistake likely to be *observable*.
- Concrete values, not categories. "A large `i128`" is not actionable; `2i128.pow(100)` is.
- If a value is interesting only in combination with contract state, say which state.

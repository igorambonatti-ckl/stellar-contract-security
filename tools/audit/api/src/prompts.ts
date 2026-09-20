import type { ContractInfo } from './inspect.js';

/**
 * The three prompts, parameterised for an arbitrary contract.
 *
 * These are the versioned prompts from `04-prototype-development/prompts/`,
 * with the vault-specific wording lifted out. The discipline sections are kept
 * verbatim, because each line in them was earned:
 *
 * - "assert *which* error" exists because a seeded arithmetic bug passed an
 *   `is_err()` oracle — the wrapped product tripped a downstream guard, so the
 *   buggy contract did abort, just with the wrong error.
 * - "state the assumption" exists because the one runtime bug the model shipped
 *   was pre-marked in its own assumptions section, including the wrong way to
 *   fix it.
 * - "prefer properties that can fail silently" exists because six of seven
 *   planted bugs never abort, and a liveness oracle is blind to all six.
 */

const SYSTEM =
  'You are a smart-contract security engineer specialising in Soroban, ' +
  "Stellar's Rust/WASM smart contract platform. You answer with precision and " +
  'never speculate: you assert only what is demonstrable from the code in front ' +
  'of you, and you mark anything you are taking on faith as an assumption.';

export function systemPrompt(): string {
  return SYSTEM;
}

function contractContext(info: ContractInfo, source: string): string {
  const tiers = Object.entries(info.tiers)
    .filter(([, used]) => used)
    .map(([t]) => t)
    .join(', ') || 'none detected';

  return `# Contract under analysis

Crate: \`${info.crateName}\`
Entry points: ${info.entryPoints.length}
Storage tiers touched: ${tiers}
Calls \`extend_ttl\`: ${info.extendsTtl ? 'yes' : 'no'}
Calls other contracts: ${info.callsOtherContracts ? 'yes' : 'no'}
Declared error codes: ${info.errorCodes.map((e) => `${e.name}=${e.code}`).join(', ') || 'none'}

## Source

\`\`\`rust
${source}
\`\`\`
`;
}

export function proposeInvariants(info: ContractInfo, source: string): string {
  return `${contractContext(info, source)}

# Task

Produce the **invariant catalogue** a fuzzing harness for this contract should
assert: the properties that must hold for every possible sequence of calls, for
any inputs, at any ledger sequence.

## What counts as a good invariant

It must be expressible as an executable assertion inside a \`soroban_sdk::Env\`
test harness. Prefer properties that:

- relate **two or more observable quantities** — a sum, a before/after
  comparison, a conservation law — over properties that restate a single line;
- can fail **silently**, i.e. the contract returns normally but the state is
  wrong. A property whose only failure mode is a panic is weak, because
  liveness checking already catches it;
- exercise the platform's own hazards, not just application logic.

## Soroban-specific ground to cover

- **Storage tiers.** Which tier can silently disappear, and what must therefore
  never be read from it?
- **TTL and archival.** \`extend_ttl(threshold, extend_to)\` extends only when the
  remaining TTL is already **below** \`threshold\`. Persistent entries that expire
  are auto-restored at a rent cost; temporary entries are **not** restored.
- **Authorization.** \`require_auth()\` on an \`Address\`, and which entry points
  lack it.
- **Arithmetic.** The Soroban project template enables \`overflow-checks\`, so a
  bare \`+\` aborts rather than wrapping.

## Output format

Return **only** a JSON array, no prose around it. Each element:

\`\`\`json
{
  "id": "I1",
  "statement": "the property, formal enough to implement, using the contract's own identifiers",
  "class": "supply conservation | value conservation | access control | arithmetic | input validation | state machine | soroban storage tier | soroban ttl",
  "observation": "the concrete calls and reads a harness makes to observe a violation",
  "silent": true,
  "assumption": "what you are taking on faith, so a human can check it",
  "confidence": "high | medium | low",
  "rationale": "one clause justifying the confidence"
}
\`\`\`

Rank most valuable first. **Never speculate.** If an invariant might not hold on
the correct contract, still include it, mark confidence \`low\`, and say exactly
what you are unsure about in \`assumption\`.`;
}

export interface CuratedInvariant {
  id: string;
  statement: string;
  class: string;
  observation: string;
}

export function generateHarness(
  info: ContractInfo,
  source: string,
  invariants: CuratedInvariant[],
): string {
  const list = invariants
    .map((i) => `### ${i.id} — ${i.class}\n\n${i.statement}\n\n*How to observe:* ${i.observation}`)
    .join('\n\n');

  return `${contractContext(info, source)}

# Curated invariants

A human has accepted these ${invariants.length} properties. Assert exactly these.

${list}

# Task

Write a single Rust file for \`tests/audit_generated.rs\` — an integration test,
so it links the crate as an external dependency and may only use its public API.

## Non-negotiable

**1. Assert state, not liveness.** "The call did not panic" is not an oracle.
Every property must read state back and compare it against an independently
computed expectation. Where the only available assertion is "this must abort",
use \`try_*\`, assert **which** error came back, and assert that state did **not**
change. "Some error occurred" is not acceptable — it passes when the contract
fails for an unrelated reason.

**2. Principals come from a fixed pool.** A freshly generated \`Address\` cannot
be authorized in the test host, so fuzzing raw address bytes collapses every
access-control property into "an unknown caller is rejected". Register a small
pool and fuzz an **index** into it.

**3. Pin the ledger TTL floors** via \`env.ledger().with_mut(...)\` —
\`min_persistent_entry_ttl\`, \`min_temp_entry_ttl\`, \`max_entry_ttl\`, and a known
starting sequence. The host default of 4096 silently swallows small TTL
operations and makes TTL properties pass for the wrong reason.

**4. Generators must reach the interesting values.** Do not narrow every
generator to a comfortable range to keep the correct contract passing. Where a
property needs extreme operands, generate them and assert the *disjunction*:
either the call aborts with the right error and leaves state untouched, or it
succeeds and the relation holds.

**5. Every property names the invariant it checks**, by ID, in a doc comment,
and fails with a message saying what relation broke and with which values.

## Environment

\`soroban_sdk\` with \`testutils\`, and \`proptest\` are available as
dev-dependencies. \`Env::default()\`, \`env.mock_all_auths()\`,
\`env.set_auths(&[])\`, \`env.register(Contract, ())\`,
\`env.register_stellar_asset_contract_v2(admin).address()\`.

## Output

1. The complete file in one \`\`\`rust block. No elisions, no \`todo!()\`.
2. Then **"Assumptions I could not verify"** — anything guessed about the SDK
   surface, so a human can check it before compiling.
3. Then **"Invariants I could not express, and why."** An honest "cannot be
   expressed through the public API" is more useful than a property that
   silently checks something weaker.`;
}

export function prioritiseInputs(info: ContractInfo, source: string): string {
  return `${contractContext(info, source)}

# Task

Produce the **input prior** for a fuzzing campaign against this contract: where
the interesting values actually are.

Uniform sampling over \`i128\` is close to useless — almost every draw is an
absurd magnitude rejected by the first guard, so the fuzzer never reaches code
that needs accumulated state.

## Output format

Return **only** JSON, no prose:

\`\`\`json
{
  "literals": [
    { "value": "0", "why": "exact boundary of the positivity guard" }
  ],
  "stateRelative": [
    { "expr": "balance + 1", "why": "the InsufficientBalance edge, unreachable as a literal" }
  ],
  "pool": [
    { "role": "admin", "why": "the only principal that passes the admin check" }
  ],
  "sequences": [
    { "steps": ["initialize", "deposit(U1, 10^9)", "advance 1036801", "withdraw(U1, ...)"],
      "builds": "what state this establishes",
      "exposes": "what it would reveal" }
  ],
  "ledgerAdvances": [
    { "value": "17280", "why": "exact temporary-tier expiry boundary" }
  ]
}
\`\`\`

Be concrete. "A large \`i128\`" is not actionable; \`2^100\` is. Where you want a
*product* to land on a boundary, say which operands produce it. For ledger
advances, probe each TTL threshold from both sides.`;
}

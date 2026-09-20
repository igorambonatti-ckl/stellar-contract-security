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

Write a single Rust file for \`tests/audit_generated.rs\`.

**It is an integration test of the crate \`${info.crateName}\`.** Import the
contract from the crate directly:

\`\`\`rust
use ${info.crateName.replace(/-/g, '_')}::{/* Contract type, Client, error enum, DataKey */};
\`\`\`

**Do not use \`contractimport!\`.** It loads a \`.wasm\` from a build path that does
not exist at test time, and the file will fail to compile with
\`No such file or directory\`. The crate is a normal dependency of its own
integration tests — link it, do not load bytecode.

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

### The \`try_*\` signature — get this right

The generated client gives you \`foo(..)\`, which panics on a contract error, and
\`try_foo(..)\`, which does not. **\`try_foo\` returns a nested \`Result\`:**

\`\`\`rust
Result<Result<T, ConversionError>, Result<soroban_sdk::Error, InvokeError>>
//     ^ Ok(Ok(value)) on success        ^ Err(Ok(e)) carries the error value
\`\`\`

Consequences, all of which are routine mistakes:

- The failure channel carries **\`soroban_sdk::Error\`**, not the contract's own
  error enum — unless the entry point *declares* a \`Result\` return type. This
  contract's entry points return plain values and abort via \`panic_with_error!\`,
  so expect \`soroban_sdk::Error\`.
- Compare against a specific error with
  \`e == soroban_sdk::Error::from_contract_error(MyError::Foo as u32)\`.
- \`Result\` does not implement \`Display\`. In an assertion message use \`{:?}\`,
  never \`{}\`.
${
  info.exampleTest
    ? `
### A test from this crate that already compiles

Use it as the authority on the API surface — the client name, how the fixture is
built, how errors are matched. Where it disagrees with your recollection of the
SDK, **it is right and you are wrong**.

\`\`\`rust
${info.exampleTest.source}
\`\`\`
`
    : ''
}

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

/**
 * Devolve os erros do compilador ao modelo.
 *
 * Esta etapa existe porque errar a superfície do SDK é o modo de falha
 * dominante, e é barato de corrigir: no benchmark de referência, 16 dos 17
 * erros de compilação vinham de uma única suposição errada sobre a assinatura
 * gerada pelo cliente. O compilador é um revisor preciso e literal — devolver o
 * que ele disse costuma bastar.
 */
export function fixHarness(
  info: ContractInfo,
  source: string,
  code: string,
  errors: string,
): string {
  return `The harness below does not compile. Fix it.

# Contract source, for reference

\`\`\`rust
${source}
\`\`\`

# Current harness

\`\`\`rust
${code}
\`\`\`

# Compiler output

\`\`\`
${errors}
\`\`\`

# Task

Return the **complete corrected file** in one \`\`\`rust block. Not a diff, not a
fragment — the whole file, ready to write over the old one.

Rules:

- The crate is \`${info.crateName}\`; import from \`${info.crateName.replace(/-/g, '_')}\`.
  **Never** \`contractimport!\`.
- If a method the compiler rejects does not exist, **do not invent a replacement
  name**. Either use an API you are certain of, or delete that assertion and say
  so in a comment on the line. A property that silently checks something weaker
  is worse than a missing one.
- Do not weaken an assertion just to make it compile. Where the only available
  assertion is "this must abort", keep asserting **which** error came back.
- Keep every property that already compiles unchanged.`;
}

/**
 * Um teste para **uma** invariante.
 *
 * Pedir um arquivo de 1200 linhas com 25 propriedades é tudo-ou-nada: um erro
 * em qualquer uma derruba o arquivo inteiro, e foi o que aconteceu com todos os
 * modelos testados — 43 a 59 erros por tentativa, em modelos que escrevem Rust
 * correto quando o escopo é pequeno.
 *
 * Um teste por invariante troca uma falha total por falhas isoladas: o que não
 * compila cai, o resto segue. Também casa com a etapa de validação, que já dá
 * veredito por invariante, e deixa cada chamada curta o bastante para caber
 * folgada no limite de saída de qualquer modelo.
 */
export function generateOneTest(
  info: ContractInfo,
  source: string,
  inv: CuratedInvariant,
): string {
  return `${contractContext(info, source)}
${
  info.exampleTest
    ? `## A test from this crate that already compiles\n\nThis is the authority on the API surface — the client name, how the fixture is\nbuilt, how errors are matched. Where it disagrees with your recollection of the\nSDK, **it is right and you are wrong**. Copy its fixture setup.\n\n\`\`\`rust\n${info.exampleTest.source}\n\`\`\`\n`
    : ''
}
# Invariant to test

**${inv.id}** — ${inv.class}

${inv.statement}

*How to observe:* ${inv.observation}

# Task

Write **one** \`#[test]\` function that asserts this single invariant, plus any
helper it needs. Nothing else.

\`\`\`rust
#[test]
fn ${inv.id.toLowerCase().replace(/[^a-z0-9]/g, '')}_<descritivo>() {
    // ...
}
\`\`\`

The function name **must start with \`${inv.id.toLowerCase().replace(/[^a-z0-9]/g, '')}\`** — the
pipeline matches a failing test back to its invariant by that prefix, and a test
whose failure cannot be attributed is not a finding.

## Rules

- **Assert state, not liveness.** Read state back and compare against a value you
  computed yourself. Where the only assertion available is "this must abort", use
  \`try_*\`, assert **which** error came back, and assert state did not change.
- \`try_foo\` returns \`Result<Result<T, _>, Result<soroban_sdk::Error, InvokeError>>\`.
  The error side carries \`soroban_sdk::Error\`, not the contract's enum, unless the
  entry point declares a \`Result\` return type. Compare with
  \`soroban_sdk::Error::from_contract_error(MyError::Foo as u32)\`. \`Result\` has no
  \`Display\` — use \`{:?}\` in messages.
- Principals come from addresses you register in the fixture, never from raw
  fuzzed bytes: a generated \`Address\` cannot be authorized.
- If the invariant touches TTL, pin the ledger floors with
  \`env.ledger().with_mut(...)\` — the host default of 4096 swallows small TTL
  operations and the property passes for the wrong reason.
- Prefer a plain \`#[test]\` over \`proptest!\` unless the property genuinely needs
  generated inputs.

## Output

Return **only** the Rust code in one \`\`\`rust block: **your own \`use\` statements**,
then the test function and any helper it needs. No prose.

Your snippet is placed inside its own \`mod ${inv.id.toLowerCase()} { ... }\`, so import
everything you use — \`soroban_sdk::testutils::{Address as _, Ledger as _}\`,
\`use ${info.crateName.replace(/-/g, '_')}::*;\`, and anything else. Nothing is in scope
that you do not import, and nothing you import can collide with another test.

If this invariant cannot be expressed through the public API, return exactly:

\`\`\`rust
// IMPOSSIVEL: <reason>
\`\`\``;
}

/**
 * Devolve ao modelo os erros de **um** teste.
 *
 * A etapa de correção existia antes e não funcionava: o arquivo inteiro vinha
 * com 43 a 59 erros, e devolver tudo de uma vez pedia ao modelo que consertasse
 * um arquivo que ele já tinha demonstrado não saber escrever. Com um teste por
 * chamada o erro é curto, específico, e quase sempre sobre uma assinatura só.
 */
export function fixOneTest(
  info: ContractInfo,
  inv: CuratedInvariant,
  code: string,
  errors: string,
): string {
  return `This test, for invariant **${inv.id}** (${inv.statement}), does not compile.

# The test

\`\`\`rust
${code}
\`\`\`

# What the compiler said

\`\`\`
${errors}
\`\`\`
${
  info.exampleTest
    ? `\n# A test from this crate that *does* compile\n\nIt is the authority on the real API surface. Where it disagrees with your\nrecollection of the SDK, it is right and you are wrong.\n\n\`\`\`rust\n${info.exampleTest.source}\n\`\`\`\n`
    : ''
}
# Task

Return the **complete corrected snippet** in one \`\`\`rust block — \`use\` statements
plus the test, ready to drop into its own \`mod\`. No prose, no diff.

- The function name must still start with \`${inv.id.toLowerCase().replace(/[^a-z0-9]/g, '')}\`.
- Import from \`${info.crateName.replace(/-/g, '_')}\`. **Never** \`contractimport!\`.
- If the compiler says a method does not exist, **do not invent another name for
  it**. Use an API you are certain of, or drop that assertion and say so in a
  comment. A property that silently checks something weaker is worse than none.
- Do not weaken an assertion to make it compile. "This must abort" still has to
  say **which** error came back.

If the invariant cannot be expressed against the real API, return exactly:

\`\`\`rust
// IMPOSSIVEL: <reason>
\`\`\``;
}

/** Cabeçalho do arquivo: só os atributos. Cada teste traz os próprios imports. */
export function harnessHeader(_info: ContractInfo): string {
  return `//! Harness gerado pela auditoria assistida por IA.
//!
//! Um teste por invariante, cada um no seu próprio \`mod\` com os próprios
//! imports: o nome do módulo é o ID da invariante, então uma falha é sempre
//! atribuível, e dois testes não colidem por importar a mesma coisa.

#![allow(unused_imports, unused_variables, dead_code, unused_mut)]
`;
}

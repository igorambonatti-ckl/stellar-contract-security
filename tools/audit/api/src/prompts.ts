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

/**
 * A técnica sem a qual a propriedade desta classe é vazia.
 *
 * Isto não é estilo, e não é específico de nenhum contrato — é keyed pela
 * *classe* da invariante, não pelo domínio. Cada bloco corresponde a uma forma
 * de um teste ficar verde sem medir nada, observada contra bugs reais:
 *
 * - controle de acesso, sob `mock_all_auths()`, é vacuamente verdadeiro: um
 *   contrato sem `require_auth` se comporta igual a um com;
 * - aritmética com literais escolhidos a dedo nunca chega perto de um limite,
 *   porque os valores que uma pessoa escolhe à mão são os confortáveis;
 * - TTL sem avançar o ledger além da borda nunca observa a expiração.
 *
 * Nos três casos o teste compila, roda, fica verde e não mede nada — a única
 * classe de erro que este projeto trata como grave.
 */
function tecnicaPorClasse(c: string): string {
  const k = (c || '').toLowerCase();

  if (/access control|auth|permission|owner|admin/.test(k)) {
    return `## This is an access-control property — \`mock_all_auths()\` would void it

\`env.mock_all_auths()\` makes **every** \`require_auth\` succeed. Under it, a
contract that is missing an authorization check behaves exactly like one that
has it, so the property is vacuously true and proves nothing.

Assert the negative directly: with \`env.set_auths(&[])\` — no authorization
available — call the entry point as a principal that should not be allowed, and
assert it **fails**, and that state did not change. Then, separately, assert the
authorized path still works. A test that only exercises the happy path is not an
access-control test.`;
  }

  if (/arithmetic|overflow|precision|rounding|input validation|bounds/.test(k)) {
    return `## This property needs a range, not a chosen literal

A hand-picked pair of round numbers never approaches a boundary — the values a
person picks by hand are the comfortable ones. Use \`proptest!\` and generate
operands that actually reach the edges: \`0\`, \`1\`, \`i128::MAX\`, \`i128::MAX / 2\`,
and values immediately above and below the contract's own guards.

Do **not** narrow the generator to keep the correct contract green. Assert the
**disjunction**: either the call aborts with the specific error it should and
state is untouched, or it succeeds and the relation holds. Narrowing the range
until everything passes is how a harness reports success without testing
anything.`;
  }

  if (/ttl|archival|expiry|storage tier|temporary|persistent/.test(k)) {
    return `## This property needs the ledger to actually move

Pin the floors first with \`env.ledger().with_mut(...)\` —
\`min_persistent_entry_ttl\`, \`min_temp_entry_ttl\`, \`max_entry_ttl\`, and a known
\`sequence_number\`. The host default of 4096 silently swallows small TTL
operations.

Then **advance \`sequence_number\` past the cliff** and read back. A TTL property
that never crosses an expiry boundary observes nothing. Probe both sides: one
ledger before the cliff the entry must still be there; one after, it must be gone
(temporary) or restorable (persistent).

\`env.ledger().with_mut(|l| l.sequence_number += N)\` is how you move it. It does
exist — do not claim otherwise and skip the check.

### Reading a TTL from a test

Storage is scoped to the contract, so a TTL read only works from inside its
context:

\`\`\`rust
let ttl = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
let ttl = env.as_contract(&contract_id, || env.storage().persistent().get_ttl(&key));
\`\`\`

Without this, a property about \`extend_ttl\` has nothing to assert on and
degrades into "the call did not panic", which is not an oracle. If the invariant
is about an entry being bumped, read the TTL before and after and compare — do
not settle for checking that the value is still readable.`;
  }

  if (/conservation|supply|value|balance|accounting/.test(k)) {
    return `## Sum both sides, across more than one actor

A conservation law checked with one principal and one operation is satisfied by
almost any implementation. Use at least two or three principals, run a sequence
of operations, and assert the **total** before equals the total after, plus or
minus exactly what moved. Include the contract's own holdings in the sum — a
quantity that leaks into the contract itself still balances if you only sum the
users.`;
  }

  return '';
}

/**
 * Um teste para **uma** invariante.
 *
 * Pedir um arquivo com todas as propriedades de uma vez é tudo-ou-nada: um erro
 * em qualquer uma derruba o arquivo inteiro, e foi o que aconteceu com todos os
 * modelos medidos — 43 a 59 erros por tentativa, em modelos que escrevem Rust
 * correto quando o escopo é pequeno.
 */
export function generateOneTest(
  info: ContractInfo,
  source: string,
  inv: CuratedInvariant,
): string {
  const slug = inv.id.toLowerCase().replace(/[^a-z0-9]/g, '');

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

${tecnicaPorClasse(inv.class)}

# Task

Write **one** \`#[test]\` function that asserts this single invariant, plus any
helper it needs. Nothing else.

The function name **must start with \`${slug}\`** — the pipeline matches a failing
test back to its invariant by that prefix, and a test whose failure cannot be
attributed is not a finding.

## Rules

- **Assert state, not liveness.** "The call did not panic" is not an oracle. Read
  state back and compare against a value you computed yourself. Where the only
  assertion available is "this must abort", use \`try_*\`, assert **which** error
  came back, and assert state did not change.
- \`try_foo\` returns \`Result<Result<T, _>, Result<soroban_sdk::Error, InvokeError>>\`.
  The error side carries \`soroban_sdk::Error\`, not the contract's own enum, unless
  the entry point declares a \`Result\` return type. Compare with
  \`soroban_sdk::Error::from_contract_error(MyError::Foo as u32)\`. \`Result\` has no
  \`Display\` — use \`{:?}\` in messages, never \`{}\`.
- Principals come from addresses you register in the fixture, never from raw
  fuzzed bytes: a generated \`Address\` cannot be authorized, so fuzzing address
  bytes collapses every access-control property into "an unknown caller is
  rejected".
- Use \`proptest!\` whenever the property quantifies over a **range** of inputs —
  any property about amounts, balances or ledger positions does. A plain
  \`#[test]\` with hand-picked literals only proves the property at the literals
  you picked. Reserve plain \`#[test]\` for properties about a fixed sequence of
  calls.

## Output

Return **only** the Rust code in one \`\`\`rust block: **your own \`use\` statements**,
then the test function and any helper it needs. No prose.

The pipeline wraps your snippet in \`mod ${slug} { ... }\` for you — **do not write
a \`mod\` yourself**, or it ends up nested. Import everything you use:
\`soroban_sdk::testutils::{Address as _, Ledger as _}\`,
\`use ${info.crateName.replace(/-/g, '_')}::*;\`, and anything else. Nothing is in
scope that you do not import, and nothing you import can collide with another
test.

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
 * chamada o erro é curto e quase sempre sobre uma assinatura só.
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

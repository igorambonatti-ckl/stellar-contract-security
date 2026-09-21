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

/**
 * A superfície do `Env` de teste, verificada.
 *
 * Existe porque o modo de falha dominante não é o modelo raciocinar mal sobre o
 * contrato — é ele errar o nome de um método do SDK. Nas medições deste
 * projeto, os erros de compilação que mataram os testes mais ambiciosos foram
 * todos desta família: `set_sequence` em vez de `set_sequence_number`,
 * `to_contract_error` que não existe, `Persistent::iter` que não existe, o
 * caminho errado do `StellarAssetClient`.
 *
 * E o efeito é pior do que parece: um teste que não compila é descartado, e os
 * testes que erram a API são justamente os que tentam fazer algo difícil. Sem
 * esta seção o pipeline seleciona sistematicamente as propriedades triviais.
 *
 * Cada linha aqui foi verificada contra `soroban-sdk` 26.1 nos spikes de P1
 * (`04-prototype-development/results/spikes.md`), não recordada.
 */
const API_TESTE = `## The test \`Env\` surface — verified, use these exact names

\`\`\`rust
let env = Env::default();
let id  = env.register(MyContract, ());          // -> Address
let c   = MyContractClient::new(&env, &id);

env.mock_all_auths();                            // every require_auth passes
env.set_auths(&[]);                              // no authorization available

env.ledger().with_mut(|l| {
    l.sequence_number = 100;
    l.timestamp = 1000;
    l.min_persistent_entry_ttl = 100;
    l.min_temp_entry_ttl = 16;
    l.max_entry_ttl = 1_000_000;
});
env.ledger().set_sequence_number(n);             // NOT \`set_sequence\`

// TTL and whole-storage reads come from **traits**, not inherent methods. The
// import is mandatory — without it the compiler says "no method named get_ttl
// found for struct Instance", which reads like the method does not exist.
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _, Temporary as _};

// EVERY env.storage() access from a test must be inside as_contract -- not
// just the TTL ones. has(), get(), set(), all of them. Outside it the SDK
// panics on a debug assertion whose message names storage.rs, not your code,
// so it reads like an SDK bug rather than a missing wrapper. One unwrapped
// has() in a rig turned every property red against the CORRECT contract and
// cost a whole measurement round.
env.as_contract(&id, || env.storage().instance().get_ttl());          // -> u32
env.as_contract(&id, || env.storage().persistent().get_ttl(&key));    // -> u32
env.as_contract(&id, || env.storage().temporary().get_ttl(&key));     // -> u32

// Every entry of a tier, as an untyped Map<Val, Val> -- rarely what you want;
// summing over the principals the rig created is simpler and typed:
env.as_contract(&id, || env.storage().persistent().all());

// A token to move around:
let tok = env.register_stellar_asset_contract_v2(admin.clone()).address();
soroban_sdk::token::StellarAssetClient::new(&env, &tok).mint(&who, &amount);
soroban_sdk::token::TokenClient::new(&env, &tok).balance(&who);
\`\`\`

### Things that do not exist — do not reach for them

- There is no \`iter()\` or \`keys()\` on storage. \`.all()\` from the testutils trait
  above is the only way to walk every entry, and it returns \`Map<Val, Val>\` —
  untyped, so every key and value needs converting back before it means
  anything. **Prefer summing over the principals the rig created**, which are
  typed and always in scope. Reach for \`.all()\` only when the property is
  genuinely about entries no test created, and expect to do the conversion
  work.
- **\`InvokeError\` has no \`to_contract_error()\`.** Compare the value instead:
  \`e == soroban_sdk::Error::from_contract_error(MyError::Foo as u32)\`.
- There is no \`soroban_sdk::testutils::EnvExt\`. Everything you need on \`Env\` is
  in \`soroban_sdk::testutils::{Address, Ledger}\` plus the storage traits above.

### Protocol 23 changed what is falsifiable

Persistent entries whose TTL has lapsed are **automatically restored** by the
host, and the test \`Env\` emulates that. So "a value written earlier is still
readable later" is **always true**, with or without \`extend_ttl\` — an assertion
that cannot fail and therefore cannot find anything.

What is still falsifiable is the TTL **number**: a restored entry comes back at
\`min_persistent_entry_ttl - 1\`, which is distinguishable from one that was
properly extended. Assert the number, not the readability.
`;

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

${API_TESTE}

# Task

Produce the **invariant catalogue** a fuzzing harness for this contract should
assert: the properties that must hold for every possible sequence of calls, for
any inputs, at any ledger sequence.

## How these will be checked

Each invariant becomes a function called **after every operation** of a randomly
generated sequence of calls, with three things in hand: the live state, a
snapshot of the state **immediately before** that operation, and the operation
itself. So write properties for a fuzzer, not scenarios — never "deposit 100,
then withdraw 50, then assert".

Two shapes are welcome, and the second is where the value is:

- **state predicates**, true in every reachable state;
- **transition properties**, relating before and after: "a call that was not
  authorized changed nothing", "the total rose by exactly what came in", "an
  operation that writes must have extended the entry's TTL". These catch the
  defects that leave the contract in a perfectly consistent but wrong state, and
  they are invisible to any single-state check.

A property that only holds under a precondition is welcome too: state the
precondition, and the check will read the state, or the operation, and skip when
it does not apply.

## What counts as a good invariant

It must be expressible as an executable assertion inside a \`soroban_sdk::Env\`
test harness. Prefer properties that:

- relate **two or more observable quantities** — a sum, a before/after
  comparison, a conservation law — over properties that restate a single line;
- can fail **silently**, i.e. the contract returns normally but the state is
  wrong. A property whose only failure mode is a panic is weak, because
  liveness checking already catches it;
- exercise the platform's own hazards, not just application logic.

## Two classes that catalogues keep leaving out

- **The authorized happy path never fails, at any ledger.** For each entry
  point: when the *right* principal calls it with *valid* arguments after
  initialization, it succeeds — no matter how many ledgers have passed. A
  contract that gates an admin call on a temporary-storage entry silently
  starts refusing its own admin once that entry expires; this is the property
  that sees it, and it needs the operation and its result, not just the state.
- **Every configured address and flag is immutable except through its own
  setter.** Token address, admin, pause flag: compare before and after each
  operation; only the designated call may change each one.

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

Aim for **12 to 20 proposals**. A reviewer will cut what does not hold up, so
breadth is the goal here: cover every entry point, every storage tier the
contract touches, every place two quantities must agree. Six proposals leave
nothing to cut and nothing to fuzz.

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
 * Um rig completo para um contrato inventado, como referência de forma.
 *
 * Duas coisas justificam gastar tanto prompt nisto.
 *
 * A primeira é que o rig é ponto único de falha: se ele não compila, nenhuma
 * invariante chega a ser testada. Na primeira medição desta arquitetura ele
 * morreu em quatro tentativas de reparo e o resultado foi zero.
 *
 * A segunda é que um dos erros não é adivinhável. O cliente gerado
 * (`FooClient<'a>`) **empresta** o `Env`, então uma struct com os dois é
 * auto-referencial e Rust recusa. A saída — guardar o `Env` e o `Address`, e
 * construir o cliente sob demanda — é óbvia depois de vista e custa uma rodada
 * inteira antes disso. O mesmo vale para `prop::sample::select`, que aceita
 * `Vec` e recusa array.
 *
 * O contrato do exemplo é fictício de propósito: mostra a forma sem sugerir
 * nada sobre o contrato em auditoria.
 */
const RIG_EXEMPLO = `### A complete rig for a different contract, as a shape reference

This is for an imaginary \`Bank\` contract with \`open\`, \`credit\`, \`debit\` and an
admin-only \`freeze\`. Copy the **shape**, not the operations.

\`\`\`rust
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use my_bank::*;

pub struct Rig {
    pub env: Env,
    pub id: Address,          // the contract
    pub token: Address,
    pub admin: Address,
    pub users: Vec<Address>,  // index into this; never generate an Address
    /// What the last operation returned, for transition properties.
    pub last: std::cell::RefCell<Option<Result<i128, soroban_sdk::Error>>>,
}

// The generated client borrows the Env, so a struct holding both would be
// self-referential and will not compile. Hold the ids, build clients on demand.
impl Rig {
    pub fn client(&self) -> BankClient<'_> { BankClient::new(&self.env, &self.id) }
    pub fn token(&self) -> TokenClient<'_> { TokenClient::new(&self.env, &self.token) }
    pub fn sac(&self) -> StellarAssetClient<'_> { StellarAssetClient::new(&self.env, &self.token) }
}

pub fn setup() -> Rig {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.sequence_number = 1000;
        l.timestamp = 1000;
        l.min_persistent_entry_ttl = 100;
        l.min_temp_entry_ttl = 16;
        l.max_entry_ttl = 1_000_000;
    });

    let admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let id = env.register(Bank, ());

    let mut users: Vec<Address> = (0..3).map(|_| Address::generate(&env)).collect();
    users.push(id.clone());   // the contract itself is a reachable principal

    let sac = StellarAssetClient::new(&env, &token);
    for u in &users { sac.mint(u, &(i128::MAX / 8)); }   // big enough for products to overflow

    BankClient::new(&env, &id).initialize(&admin, &token);
    Rig { env, id, token, admin, users, last: std::cell::RefCell::new(None) }
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub total: i128,
    pub balances: Vec<i128>,          // per users[i], in the contract
    pub token_balances: Vec<i128>,    // per users[i], in the token
    pub vault_token_balance: i128,
    pub frozen: Vec<bool>,
    pub instance_ttl: u32,
    pub balance_ttls: Vec<Option<u32>>, // persistent entry per users[i], None if absent
    pub sequence: u32,
    pub timestamp: u64,
    pub token_in_storage: Option<Address>,  // read from storage: no getter exists
    pub admin_key_present: bool,
}

pub fn snapshot(r: &Rig) -> Snapshot {
    use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
    let c = r.client(); let t = r.token();
    Snapshot {
        total: c.total(),
        balances: r.users.iter().map(|u| c.balance(u)).collect(),
        token_balances: r.users.iter().map(|u| t.balance(u)).collect(),
        vault_token_balance: t.balance(&r.id),
        frozen: r.users.iter().map(|u| c.is_frozen(u)).collect(),
        instance_ttl: r.env.as_contract(&r.id, || r.env.storage().instance().get_ttl()),
        sequence: r.env.ledger().sequence(),
        timestamp: r.env.ledger().timestamp(),
        token_in_storage: r.env.as_contract(&r.id, || r.env.storage().instance().get(&DataKey::Token)),
        admin_key_present: r.env.as_contract(&r.id, || r.env.storage().instance().has(&DataKey::Admin)),
        balance_ttls: r.users.iter().map(|u| r.env.as_contract(&r.id, || {
            let k = DataKey::Balance(u.clone());
            if r.env.storage().persistent().has(&k) { Some(r.env.storage().persistent().get_ttl(&k)) } else { None }
        })).collect(),
    }
}

#[derive(Debug, Clone)]
pub enum Op {
    Credit { who: usize, amount: i128 },
    Debit  { who: usize, amount: i128 },
    Freeze { who: usize },
    Unauthorized { who: usize },   // a call with no authorization available
    Advance(u32),
}

pub fn apply(r: &Rig, op: &Op) {
    let c = r.client();
    // try_* everywhere: the fuzzer will produce arguments the contract is right
    // to refuse, and a panic here would end the sequence before it got deep.
    match op {
        Op::Credit { who, amount } => {
            let res = c.try_credit(&r.users[who % r.users.len()], amount);
            *r.last.borrow_mut() = Some(match res { Ok(Ok(v)) => Ok(v), Err(Ok(e)) => Err(e), _ => Err(soroban_sdk::Error::from_contract_error(0)) });
        }
        Op::Debit  { who, amount } => {
            let res = c.try_debit(&r.users[who % r.users.len()], amount);
            *r.last.borrow_mut() = Some(match res { Ok(Ok(v)) => Ok(v), Err(Ok(e)) => Err(e), _ => Err(soroban_sdk::Error::from_contract_error(0)) });
        }
        Op::Freeze { who } => {
            let res = c.try_freeze(&r.users[who % r.users.len()]);
            *r.last.borrow_mut() = Some(match res { Ok(Ok(_)) => Ok(0), Err(Ok(e)) => Err(e), _ => Err(soroban_sdk::Error::from_contract_error(0)) });
        }
        Op::Unauthorized { who } => {
            r.env.set_auths(&[]);
            let res = c.try_freeze(&r.users[who % r.users.len()]);
            r.env.mock_all_auths();
            *r.last.borrow_mut() = Some(match res { Ok(Ok(_)) => Ok(0), Err(Ok(e)) => Err(e), _ => Err(soroban_sdk::Error::from_contract_error(0)) });
        }
        Op::Advance(n) => {
            let s = r.env.ledger().sequence();
            r.env.ledger().set_sequence_number(s.saturating_add(*n));
            *r.last.borrow_mut() = Some(Ok(0));
        }
    }
}

fn amount() -> impl Strategy<Value = i128> {
    prop_oneof![
        6 => 1i128..10_000i128,          // deep sequences need values that work
        2 => Just(0i128),                // the boundary of every positivity guard
        1 => Just(1i128),
        1 => Just(i128::MAX),
        1 => Just(i128::MAX / 2),
    ]
}

pub fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0usize..4, amount()).prop_map(|(who, amount)| Op::Credit { who, amount }),
        4 => (0usize..4, amount()).prop_map(|(who, amount)| Op::Debit  { who, amount }),
        1 => (0usize..4).prop_map(|who| Op::Freeze { who }),
        1 => (0usize..4).prop_map(|who| Op::Unauthorized { who }),
        // Ledger jumps land on and just past TTL cliffs, not uniformly.
        2 => prop_oneof![Just(1u32), Just(15), Just(17), Just(99), Just(101), Just(1_000)]
                 .prop_map(Op::Advance),
    ]
}
\`\`\`

Three shapes that cost a compile if you get them wrong:

- \`prop::sample::select\` takes a \`Vec\`, not an array. \`select(vec![0usize, 1, 2])\`.
- \`TokenClient\` and \`StellarAssetClient\` live in \`soroban_sdk::token\`, not at the
  crate root.
- **\`Op\` must derive \`Debug\`** (proptest prints the failing sequence), so it can only
  carry types that already do: \`usize\`, \`i128\`, \`u32\`, \`bool\`, \`Vec\` of those. **Never
  put a contract type in \`Op\`** — an enum from the contract almost never derives
  \`Debug\`, and \`\`TimeBoundKind\` doesn't implement \`Debug\`\` is a compile error no
  repair fixes. Encode it as an index or a bool in \`Op\`, and map to the contract
  type inside \`apply\`.
`;

/**
 * A curadoria, feita por uma segunda passada de IA em vez de por uma pessoa.
 *
 * O benchmark deste projeto mostrou que a curadoria é o passo que mais pesa —
 * 7/7 com ela, 2 a 5/7 sem. Pular o passo era o que "automático" significava
 * até aqui, e é por isso que o automático saturava. Este prompt faz o que a
 * pessoa fazia, com o critério que a pessoa usou, registrado em `AUDITING.md`
 * §2 e no ledger de `invariants.md`: rejeitar o que não pode falhar, o que só
 * restate uma linha, o que diz "tem que reverter" sem dizer com qual erro; e
 * demover uma cláusula barulhenta (que aborta) para a silenciosa.
 *
 * Não substitui o julgamento humano onde ele importa — é uma aproximação dele,
 * medida contra o mesmo benchmark. O que a mede é a detecção, não o prompt.
 */
export function curateInvariants(
  info: ContractInfo,
  source: string,
  invariants: any[],
): string {
  const lista = invariants.map((i) =>
    `### ${i.id} — ${i.class} (confidence: ${i.confidence ?? '?'})\n${i.statement}\n\n*Observe:* ${i.observation ?? ''}\n*Assumes:* ${i.assumption ?? ''}`,
  ).join('\n\n');

  return `${contractContext(info, source)}

${API_TESTE}

# Proposed invariants

${lista}

# Task

You are the **reviewer**, not the author. Decide, for each proposal, whether it
is worth turning into a fuzzing property. Be strict: a property that cannot fail
costs a test slot and proves nothing, and a property that fails for the wrong
reason produces a finding nobody can act on.

## The catalogue comes from two independent proposals — merge it

Two proposals were made and concatenated, so **duplicates are expected**. When
two entries state the same property, keep the better-formulated one and reject
the other with reason \`duplicate of Ix\`. Two entries about the same entry point
are *not* duplicates if they assert different relations.

## Reject only when one of these holds — and say which

- **It cannot fail.** True by construction of the SDK or the protocol, not of
  the contract's logic. Examples: a persistent entry being readable after its
  TTL lapsed (protocol 23 auto-restores); a bare \`+\` never wrapping under
  \`overflow-checks\`; a field of an unsigned type being non-negative.
- **It cannot be observed** through the public entry points and the test
  \`Env\` surface above, even with the storage traits.
- **It is a scenario, not an invariant.** "Deposit 100, then withdraw 50, then
  check" is a test case; the fuzzer needs a predicate over reachable states or
  over a transition.

**Do not reject for restating the code.** "\`set_admin\` requires the admin's
authorization" reads like a restatement — and it is exactly the property that
catches a missing \`require_auth\`, because the fuzzer runs it with no
authorization available. A property about access control or about a guard is
worth keeping even when it mirrors a line: the line can be missing.

**Do not reject for saying "must abort" — rewrite it** to name the error, as a
\`rewrite\` verdict. The fuzzer can check which error came back.

## Rewrite when

- A clause is **loud** (the contract aborts) and another is **silent** (the
  state is wrong but the call succeeds). Keep the silent clause — the loud one
  adds nothing over liveness checking, which the fuzzer already does.
- The statement is right but too vague to implement. Make it formal enough to
  code, using the contract's own identifiers.

## Keep when

It relates two or more observable quantities, or before and after an
operation; it can fail silently; and it is about this contract's actual
behaviour, not about what you imagine similar contracts do.

## Output

Return **only** a JSON array, one element per proposal, same order:

\`\`\`json
[
  { "id": "I1", "verdict": "keep",    "reason": "one clause" },
  { "id": "I2", "verdict": "reject",  "reason": "cannot fail: ..." },
  { "id": "I3", "verdict": "rewrite", "statement": "the corrected statement", "reason": "..." }
]
\`\`\`

The reason is not decoration: it goes into the report, and a rejection whose
reason names a real fact about the contract is itself a finding. Never reject
for being hard to implement — that is the generator's problem, not yours.`;
}

/**
 * O rig: fixture, operações, e como sortear uma sequência delas.
 *
 * Existe porque a decomposição anterior — um teste independente por invariante,
 * cada um montando o próprio cenário à mão — media quase nada. Quatro rodadas
 * de medição contra sete bugs conhecidos deram 2/7, depois 1/7, depois 0/7,
 * *piorando* conforme o prompt melhorava. A causa não era o prompt: um cenário
 * único escolhido pelo modelo só encontra um bug se acertar o gatilho de
 * primeira, e os valores que alguém escolhe à mão são os confortáveis.
 *
 * O braço de referência deste projeto chegou a 7/7 fazendo o oposto: uma
 * sequência de operações sorteada, com todas as invariantes verificadas depois
 * de **cada** operação. Cada propriedade passa então a ver todo estado que o
 * fuzzer alcança, em vez de um só.
 *
 * Separar o rig da asserção também encolhe o que se pede por invariante: em vez
 * de um teste inteiro com fixture, uma função sobre um estado que já existe.
 * Menos superfície para errar é mais teste compilando.
 */
export function generateRig(info: ContractInfo, source: string): string {
  const crate = info.crateName.replace(/-/g, '_');
  const eps = info.entryPoints
    .map((e) => `- \`${e.signature}\`${e.requiresAuth ? '  (calls require_auth)' : ''}`)
    .join('\n');

  return `${contractContext(info, source)}

${API_TESTE}

# Task

Write the **rig**: the shared fixture and the operation alphabet that a
property-based test will drive this contract with. Not the properties — those
come separately, and they will be written against what you define here.

## Entry points

${eps || '(none detected — say so and return a minimal rig)'}

${RIG_EXEMPLO}

## What to produce, exactly these four items

\`\`\`rust
pub struct Rig { /* env, client, token client, the principals, whatever a property needs to read */ }

/// Builds a contract in a usable initial state: registers it, sets ledger
/// floors, creates the principals, funds them, and runs whatever
/// initialization the contract requires before other calls are legal.
pub fn setup() -> Rig { ... }

/// One call to the contract. Cover every state-mutating entry point above,
/// plus advancing the ledger, because ledger position is an input.
#[derive(Debug, Clone)]
pub enum Op { ... }

/// Executes one operation. **Must not panic on a legitimate rejection** — use
/// \`try_*\` and swallow contract errors, because the fuzzer will generate
/// arguments the contract is right to refuse, and a panic there would end the
/// sequence before it got interesting.
pub fn apply(r: &Rig, op: &Op) { ... }

/// Where the interesting values are.
pub fn op_strategy() -> impl Strategy<Value = Op> { ... }

/// Everything a property might want to compare **before and after** an
/// operation. Plain owned values — no borrows of the Env. At minimum:
///   - every total the contract keeps, and each principal's balances
///     (in the contract *and* in the token, for every address in \`users\`)
///   - the admin, every flag, every configured address — the token address
///     **must** be in the snapshot. When the contract has no getter for a
///     value, read it from storage inside the contract's context:
///     \`r.env.as_contract(&r.id, || r.env.storage().instance().get::<_, Address>(&DataKey::Token))\`
///     — the DataKey enum is public in the crate. Three properties were refused
///     in one run for "no getter for the token" when the storage read was there.
///   - whether each configured key **exists** (\`.has(&key)\`), so a property can
///     say "the Admin key was present before this call" without guessing
///   - **TTLs**: the instance TTL, and the persistent/temporary TTL of each
///     per-principal entry that exists (read via \`as_contract\` + \`get_ttl\`;
///     \`None\` when the entry does not exist)
/// A property that cannot read something from the snapshot cannot be written.
/// Half of a catalogue died as "impossible" because the snapshot had no TTLs
/// and no token address — put in everything cheap to read.
#[derive(Debug, Clone)]
pub struct Snapshot { ... }

/// Reads the state into a Snapshot. Observes only; never mutates.
pub fn snapshot(r: &Rig) -> Snapshot { ... }
\`\`\`

**Return values are part of the state — for every operation.** \`apply\` must
record what the last operation returned in a field on \`Rig\` such as
\`pub last: RefCell<Option<Result<i128, soroban_sdk::Error>>>\` — the shares a
deposit minted, the amount a withdraw paid, \`Ok(0)\` for a call that returns
nothing, or the error it failed with. **Every arm of \`apply\` writes \`last\`**,
including transfers, admin calls, pauses and the unauthorized attempt; a rig that
records it only for two operations left half a catalogue unwritable — "did this
call fail with Overflow?", "was the unauthorized call refused?" all need it.
The ledger op writes \`last = Some(Ok(0))\` too, so a property can always tell
"the previous op succeeded" from "it was refused".

**The snapshot carries the ledger.** Include \`sequence_number\` (and
\`timestamp\`) read from \`env.ledger()\` — TTL properties compare "how many
ledgers passed" against "how much the TTL moved", and cannot without it.

**Why the snapshot matters more than it looks.** The most valuable properties are
about a *transition*, not a state: "an unauthorized call changed nothing", "the
total went up by exactly what came in", "a write extended the entry's TTL". None
of them can be checked by looking at one state, and a harness without a snapshot
is structurally blind to that entire class — it can only assert things that are
true of every state, which are the weak ones. Put in it everything cheap to
read.

## Rules that decide whether this finds anything

**Principals are indices into a fixed pool**, never generated inside the
strategy: a freshly generated \`Address\` cannot be authorized, so fuzzing
address bytes collapses every access-control property into "an unknown caller
is rejected". Put at least three principals in \`Rig\`, and include the
**contract's own address** as a reachable choice — a contract's "principals are
not contracts" assumption is exactly the kind that goes untested.

**Fund the principals so arithmetic can actually overflow.** Mint something
like \`i128::MAX / 8\` to each principal, not a round million. A contract that
multiplies \`amount × total\` only wraps when the product passes ~1.7×10³⁸, and
with balances of 10⁹ a deposit of \`i128::MAX\` is refused by the token transfer
before the multiplication ever runs — the arithmetic property becomes
unreachable and a wrapping bug survives every run. Big balances are cheap;
an unreachable property is not.

**Amounts must reach the edges.** Do not restrict the strategy to a comfortable
range. Weight it: mostly small values so sequences get deep, but with real
probability of \`0\`, \`1\`, \`i128::MAX\`, \`i128::MAX / 2\`, and of a value derived
from live state (a holder's exact balance, and that balance plus one) — the
interesting boundary usually cannot be written as a literal.

**Ledger movement is an operation.** Include an \`Op\` that advances
\`sequence_number\`, with jumps that land on and just past TTL boundaries, not a
uniform small step.

**Authorization must vary, or access control is untestable.** \`setup\` calls
\`env.mock_all_auths()\`, under which every \`require_auth\` succeeds — so a
contract missing an authorization check behaves *identically* to one that has
it, and no sequence of operations can tell them apart. Include an \`Op\` that
performs a state-mutating call with **no authorization available**:

\`\`\`rust
Op::Unauthorized { which: usize, who: usize } => {
    r.env.set_auths(&[]);
    // ... a try_* call that should be refused ...
    r.env.mock_all_auths();     // restore, or every later op fails too
}
\`\`\`

Without this the access-control properties are vacuously true and prove nothing.

**Include the operations that are only interesting the second time.** If the
contract has an initializer, put it in the alphabet and call it
**unconditionally** through \`try_*\` — do not guard it with "only if not already
initialized". A second initialization is exactly the kind of thing a property
about immutable admin exists to catch, and guarding it away means nothing ever
observes it.

**\`setup()\` must leave the contract usable.** If it requires initialization
before anything else is legal, do it in \`setup\`. A rig whose every operation
bounces off "not initialized" produces a green test that exercised nothing.

## Output

One \`\`\`rust block: your \`use\` statements, then the four items. The block is
placed in a module named \`rig\`, so do **not** write a \`mod\` yourself. No prose.

Import what you need, including \`use proptest::prelude::*;\` and
\`use ${crate}::*;\`.`;
}

/**
 * Os campos e métodos que o rig realmente expõe.
 *
 * Mandar o código do rig inteiro deveria bastar e não basta: numa medição, 9
 * dos 12 trechos gerados falharam com `no field vault_id on type &Rig` — o
 * campo se chama `id`, e o modelo escreveu o nome que lhe parecia natural
 * mesmo tendo a definição à vista. Uma lista curta e explícita é mais difícil
 * de ignorar que uma struct no meio de 150 linhas.
 */
function superficieDoRig(rig: string): string {
  const campos: string[] = [];
  const structo = /pub\s+struct\s+Rig\s*\{([\s\S]*?)\n\}/.exec(rig);
  if (structo) {
    for (const m of structo[1].matchAll(/pub\s+([a-z_][a-z0-9_]*)\s*:\s*([^,\n]+)/gi)) {
      campos.push(`- \`r.${m[1]}\` — \`${m[2].trim().replace(/,$/, '')}\``);
    }
  }

  const metodos: string[] = [];
  for (const bloco of rig.matchAll(/impl\s+Rig\s*\{([\s\S]*?)\n\}/g)) {
    for (const m of bloco[1].matchAll(/pub\s+fn\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)\s*(->\s*[^{]+)?/gi)) {
      metodos.push(`- \`r.${m[1]}(${m[2].replace(/&self,?\s*/, '').trim()})\`` +
        (m[3] ? ` ${m[3].trim()}` : ''));
    }
  }

  const partes = [
    campos.length ? `**Fields**\n\n${campos.join('\n')}` : '',
    metodos.length ? `**Methods**\n\n${metodos.join('\n')}` : '',
  ].filter(Boolean);

  return partes.length ? partes.join('\n\n') : '(the rig exposes no public surface — say so)';
}

/**
 * Uma invariante vira uma asserção sobre um estado que já existe.
 *
 * O contraste com o que havia antes é todo o ponto: pedia-se um teste completo,
 * com fixture, cenário e asserção, e o modelo errava a fixture. Aqui a fixture
 * é dada, o estado é dado, e o que resta é a única parte que exige entender a
 * propriedade.
 */
export function generateCheck(
  info: ContractInfo,
  source: string,
  inv: CuratedInvariant,
  rig: string,
): string {
  const slug = inv.id.toLowerCase().replace(/[^a-z0-9]/g, '');

  return `${contractContext(info, source)}

# The rig this property runs against

This already exists and compiles. \`check\` is called after **every** operation of
a randomly generated sequence, so it sees many states, not one.

\`\`\`rust
${rig}
\`\`\`

## What \`r\` gives you — these exact names, nothing else

${superficieDoRig(rig)}

Using any other field or method is a compile error, and a discarded property.
Do not guess a name that "should" be there: if the invariant needs something
absent from this list, say so instead of inventing it.

# Invariant to assert

**${inv.id}** — ${inv.class}

${inv.statement}

*How to observe:* ${inv.observation}

${tecnicaPorClasse(inv.class)}

# Task

Write **one** function, exactly this signature:

\`\`\`rust
pub fn check(r: &rig::Rig, antes: &rig::Snapshot, op: &rig::Op) { ... }
\`\`\`

- \`r\` is the live rig: read the current state through it.
- \`antes\` is the snapshot taken **immediately before** \`op\` ran.
- \`op\` is the operation that just ran.

Use \`antes\` and \`op\` whenever the property is about a *transition* — "this
call must not have changed anything", "the total rose by exactly the amount that
came in", "a write must have extended the TTL". Those are the properties worth
having, and they are unreachable from the current state alone. Ignore both
parameters when the property really is about a single state.

plus any helper it needs. Nothing else — no \`#[test]\`, no \`proptest!\`, no
fixture. The pipeline wraps it.

\`check\` is a **free function**, not a method. There is no \`self\` and no
\`Self\` — writing either is a compile error and costs the property.

## Rules

- **It must hold after every operation**, including the ones that were rejected.
  \`op\` tells you which ran, so a property that only concerns some operations
  should match on it and return early for the rest — that is a precondition, not
  a weakening.
  If the property only holds in some states, guard it: read the state, return
  early when the precondition does not apply, and assert when it does. A
  \`check\` that asserts unconditionally something only true sometimes fails
  against the correct contract and gets thrown away.
- **Compare against a value you computed yourself**, not against another read of
  the same thing. "The contract agrees with itself" holds in every buggy
  contract too.
- **Do not call state-mutating entry points.** \`check\` observes; the rig acts.
  A check that deposits changes the state the next check will see.
- Failure message must name the invariant and print the values that broke the
  relation — a failure nobody can read is a failure nobody will fix.
- \`Rig\` fields are what you have. If the property needs something the rig does
  not expose, say so rather than inventing a field.

## Output

One \`\`\`rust block: \`use\` statements, then \`pub fn check\`. It is placed in
\`mod ${slug}\`, which already has \`use super::rig;\` in scope — but import
everything else you use, including \`use ${info.crateName.replace(/-/g, '_')}::*;\`.

If this invariant cannot be observed through the rig and the public API, return
exactly:

\`\`\`rust
// IMPOSSIVEL: <reason>
\`\`\``;
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
${API_TESTE}

# Task

Return the **complete corrected snippet** in one \`\`\`rust block — \`use\` statements
plus the test, ready to drop into its own \`mod\`. No prose, no diff.

- Keep the same signature the snippet already has — the pipeline calls it by
  name, and renaming it detaches the property from its invariant.
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

/**
 * O teste compila, roda e falha **contra o contrato correto**.
 *
 * Isso é ambíguo, e tratar os dois casos como um só é o que estava acontecendo:
 * ou a invariante não vale, ou o harness a implementou errado. Descartar em
 * silêncio joga fora as duas — e as propriedades difíceis, que são as que valem,
 * são justamente as mais fáceis de implementar errado na primeira tentativa.
 *
 * Perguntar é barato. O que importa é que a saída distinga os casos: "consertei
 * o harness" e "a invariante é falsa" levam a lugares opostos no relatório.
 */
export function fixFailingTest(
  info: ContractInfo,
  inv: CuratedInvariant,
  code: string,
  failure: string,
): string {
  return `This test compiles and runs, but **fails against the contract as it is** —
the version with no known defect.

Invariant **${inv.id}**: ${inv.statement}

# The test

\`\`\`rust
${code}
\`\`\`

# The failure

\`\`\`
${failure}
\`\`\`

${API_TESTE}

# Task

There are exactly two possibilities, and they lead to opposite places:

1. **The harness is wrong** — a fixture set up differently than the property
   assumes, an expectation computed with the wrong formula, an off-by-one in a
   ledger advance. Then fix it and return the corrected snippet.

   **Read the error code, not just the name.** \`Error(Contract, #5)\` is the
   contract's own error with code 5 — look it up in the declared error codes
   at the top of this prompt. A check that expected \`ZeroShares\` and got
   \`#5 = InvalidAmount\` is not a contract defect: the contract has an earlier
   guard the property did not account for. Match on the code the contract
   actually returns, or accept either when both are legitimate refusals.

   **Read the panic location first.** A panic inside the SDK at
   \`soroban-sdk-*/src/unwrap.rs\` is almost always the *check* unwrapping a
   storage entry that legitimately does not exist in that state — a balance
   before any deposit, a record after it was consumed. That is not a contract
   defect; it is a missing precondition in \`check\`. Read with \`.get()\`, match on
   \`None\`, and return early when the property does not apply. Four "findings"
   with the same \`unwrap.rs\` line are one harness bug, not four contract bugs.
2. **The invariant does not actually hold** for this contract. Then the property
   is wrong, not the code, and saying so is the useful answer.

Decide which, from the failure output and the contract source.

- If (1): return the corrected snippet in one \`\`\`rust block, \`use\` statements
  included, keeping the \`pub fn check(r: &rig::Rig)\` signature.
  **Do not weaken the assertion to make it pass** — that turns a failing test
  into a test that measures nothing, which is worse than deleting it.
- If (2): return exactly \`// FALSA: <why the property does not hold>\` and nothing
  else.

Crate: \`${info.crateName.replace(/-/g, '_')}\`.`;
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

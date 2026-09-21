import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Response } from 'express';

import { inspectContract, cleanView, contractSource, type ContractInfo } from './inspect.js';
import { copiarCrate, descartarCopia, diffDaCopia, type Copia, type ArquivoDiff } from './copia.js';
import { complete, extractCode, isConfigured, currentModel } from './openrouter.js';
import {
  systemPrompt, proposeInvariants, generateRig, generateCheck, fixOneTest, fixFailingTest,
  harnessHeader,
  type CuratedInvariant,
} from './prompts.js';

/**
 * A validação roda com mais casos que quem for usar o harness depois.
 *
 * O proptest sorteia sementes novas a cada execução, então uma propriedade que
 * sobrevive a 64 sequências aqui pode falhar em outras 64 logo em seguida — e
 * foi o que aconteceu: uma execução aprovou cinco invariantes e o controle
 * limpo seguinte, no mesmo contrato, reprovou o arquivo. A porta de validação
 * era tão forte quanto a medição que ela deveria proteger.
 *
 * Quatro vezes mais casos não torna a validação exata: nada torna. Torna o
 * falso "sobreviveu" bem mais raro, que é o que importa, porque ele é o erro
 * caro — uma propriedade instável entregue ao usuário como verificada.
 */
const VALIDACAO_CASOS = 256;

/**
 * Ambiente do proptest para uma execução **independente** da anterior.
 *
 * `PROPTEST_FAILURE_PERSISTENCE=off` é o que importa. Por padrão o proptest
 * grava as entradas que falharam num `.proptest-regressions` ao lado do teste e
 * as reexecuta antes de qualquer caso novo. Isso é excelente numa suíte de
 * verdade e é veneno aqui: o arquivo acumulou sementes de ondas diferentes —
 * com formas de `Op` de rigs que nem existem mais — e passou a reprovar
 * harnesses que a etapa de validação tinha acabado de aprovar, dois minutos
 * antes, no mesmo contrato.
 *
 * O sintoma era uma validação aprovar seis invariantes e o controle limpo
 * seguinte reprovar tudo. Não era variância: era a execução anterior vazando
 * para dentro da seguinte.
 */
function AMBIENTE_PROPTEST(casos: number): Record<string, string> {
  return { PROPTEST_CASES: String(casos), PROPTEST_FAILURE_PERSISTENCE: 'off' };
}

/**
 * Deixa o crate em condição de receber um teste de integração.
 *
 * Duas coisas faltam em praticamente todo contrato Soroban real, e nenhuma
 * delas é culpa de quem o escreveu — são consequências de a ferramenta querer
 * escrever testes num crate que não é dela:
 *
 * 1. `crate-type = ["cdylib"]` e nada mais, que é o que o template da Stellar
 *    gera. Um teste em `tests/` não linka um crate cdylib-only.
 * 2. `proptest` não está nas dev-dependencies. O prompt exige `proptest!` para
 *    qualquer propriedade sobre uma faixa de valores, então sem isso a metade
 *    mais valiosa dos testes não compila em lugar nenhum fora deste repositório.
 *
 * As duas edições acontecem na **cópia**, nunca no crate original, e aparecem
 * no diff que a auditoria entrega junto com o relatório. Devolve a lista do que
 * mudou, para o log dizer em voz alta.
 */
async function prepararCrate(p: Pipeline, info: ContractInfo): Promise<string[]> {
  const caminho = join(info.path, 'Cargo.toml');
  const original = await readFile(caminho, 'utf8');
  let texto = original;
  const feito: string[] = [];

  const ct = /crate-type\s*=\s*\[([^\]]*)\]/.exec(texto);
  if (ct && !/"lib"|"rlib"/.test(ct[1])) {
    texto = texto.replace(ct[0], `crate-type = ["lib",${ct[1]}]`);
    feito.push('acrescentei "lib" a crate-type — um teste de integração não linka um crate cdylib-only');
  }

  if (!/^\s*proptest\s*=/m.test(texto)) {
    texto = /^\[dev-dependencies\]/m.test(texto)
      ? texto.replace(/^\[dev-dependencies\]/m, '[dev-dependencies]\nproptest = "1"')
      : texto.trimEnd() + '\n\n[dev-dependencies]\nproptest = "1"\n';
    feito.push('acrescentei proptest às dev-dependencies — as propriedades sobre faixas de valores precisam dele');
  }

  if (feito.length) await writeFile(caminho, texto, 'utf8');
  return feito;
}

/**
 * Lê o catálogo de invariantes tolerando um objeto malformado.
 *
 * Motivo concreto: uma rodada inteira foi perdida porque o modelo escreveu
 * `"rationale": "..."` seguido de `;` em vez de nada, num objeto de quinze. O
 * `JSON.parse` do array inteiro rejeita tudo, e quinze propriedades viraram
 * zero por causa de um caractere.
 *
 * A recuperação é deliberadamente burra: separa os objetos de primeiro nível
 * por contagem de chaves, tenta cada um, e **descarta** o que não parseia depois
 * de uma limpeza mínima. Não tenta adivinhar o que o modelo queria dizer — um
 * objeto inventado aqui viraria uma invariante que ninguém escreveu.
 *
 * Devolve também o que caiu, porque um descarte silencioso faria "13 propostas"
 * parecer o catálogo completo.
 */
export function parseInvariants(text: string): { invs: any[]; perdidos: number } {
  const body = extractCode(text, 'json').trim();
  try {
    const direto = JSON.parse(body);
    if (Array.isArray(direto)) return { invs: direto, perdidos: 0 };
  } catch { /* cai na recuperação */ }

  const objetos: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && --depth === 0 && start >= 0) objetos.push(body.slice(start, i + 1));
  }

  const invs: any[] = [];
  let perdidos = 0;
  for (const o of objetos) {
    // Pontuação perdida entre o fim de um valor e o fecho: `"x";` e `"x",}`.
    const limpo = o.replace(/"\s*;\s*(\n\s*[}\]])/g, '"$1').replace(/,(\s*[}\]])/g, '$1');
    try {
      const v = JSON.parse(limpo);
      if (v && typeof v.id === 'string' && typeof v.statement === 'string') invs.push(v);
      else perdidos++;
    } catch { perdidos++; }
  }
  return { invs, perdidos };
}

/**
 * Só o diagnóstico, sem o progresso de build.
 *
 * A saída do cargo é dominada por `Compiling`/`Downloaded`, e mandar isso de
 * volta ao modelo gasta contexto com ruído e enterra a única linha que importa.
 */
function soErros(output: string): string {
  const linhas = output.split('\n');
  const uteis: string[] = [];
  let dentro = false;
  for (const l of linhas) {
    if (/^(error|warning)(\[E\d+\])?:/.test(l)) dentro = /^error/.test(l);
    else if (/^\s*(Compiling|Downloaded|Finished|Checking|Updating|Blocking)\b/.test(l)) dentro = false;
    if (dentro) uteis.push(l);
  }
  return (uteis.length ? uteis : linhas.filter((l) => /error/i.test(l))).join('\n').slice(0, 8000);
}

/**
 * Conserta o que a referência de API não alcança: os imports.
 *
 * Um crate cujo único teste é um `#[cfg(test)] mod` inline usa `use super::*;`,
 * e o modelo copia isso fielmente — foi o que aconteceu no timelock, onde 10 de
 * 15 trechos morreram com "cannot find type `Address`". Num teste de integração
 * em `tests/`, `super` é o módulo irmão, não o crate. O exemplo que a ferramenta
 * dava ao modelo não se aplicava ao arquivo que ela pedia que ele escrevesse.
 *
 * As transformações são determinísticas e anunciadas. Não inventam API: só
 * reescrevem um caminho de import comprovadamente errado, e acrescentam o
 * mínimo quando não há nenhum.
 */
function consertarImports(p: Pipeline, crate: string, code: string, id: string): string {
  let out = code;
  if (/^\s*use\s+super::\*\s*;/m.test(out)) {
    out = out.replace(/^\s*use\s+super::\*\s*;/gm, `use ${crate}::*;`);
    log(p, `${id}: troquei \`use super::*\` por \`use ${crate}::*\` — o código vive em tests/, não dentro do crate`);
  }
  // O glob especificamente, não "alguma coisa do crate": um
  // `use soroban_vault::{Vault};` seletivo satisfaz a busca por caminho e ainda
  // assim deixa `VaultClient` e `DataKey` fora de escopo.
  if (!new RegExp(`use\\s+${crate}::\\*`).test(out)) {
    out = `use ${crate}::*;\n` + out;
    log(p, `${id}: acrescentei \`use ${crate}::*\` — faltava o import geral do crate`);
  }
  if (!/use\s+soroban_sdk::/.test(out)) {
    out = 'use soroban_sdk::testutils::{Address as _, Ledger as _};\n'
        + 'use soroban_sdk::{Address, Env};\n' + out;
    log(p, `${id}: acrescentei os imports básicos do soroban_sdk`);
  }
  // Uma rodada de reparo largou o prelude do proptest e as duas seguintes
  // gastaram-se em `cannot find macro proptest` — um erro que a correção
  // anterior criou, não o que ela devia consertar.
  if (/prop_oneof!|proptest!|Just\(|impl Strategy/.test(out) && !/use\s+proptest::/.test(out)) {
    out = 'use proptest::prelude::*;\n' + out;
    log(p, `${id}: acrescentei \`use proptest::prelude::*\` — o trecho usa proptest sem importá-lo`);
  }
  return out;
}

/**
 * Reescreve acessos a campos do rig que não existem, quando há um único
 * candidato óbvio.
 *
 * `no field vault_id on type &Rig` foi o erro mais teimoso das medições — oito
 * ocorrências numa onda, com a lista de campos do rig explícita no prompt logo
 * acima. O campo se chama `id`; o modelo escreve o nome que lhe parece natural
 * para aquele contrato.
 *
 * A reescrita só acontece quando o nome **não existe** — ou seja, o código já
 * seria erro de compilação — e quando exatamente um campo real é sufixo ou
 * prefixo do nome inventado. Ambiguidade não se resolve por palpite: se dois
 * campos casam, deixa o compilador reclamar, porque um palpite errado aqui não
 * gera erro, gera um teste que lê a coisa errada e passa.
 */
function alinharCamposDoRig(p: Pipeline, code: string, rig: string, id: string): string {
  const campos = new Set<string>();
  const structo = /pub\s+struct\s+Rig\s*\{([\s\S]*?)\n\}/.exec(rig);
  if (structo) {
    for (const m of structo[1].matchAll(/pub\s+([a-z_][a-z0-9_]*)\s*:/gi)) campos.add(m[1]);
  }
  for (const bloco of rig.matchAll(/impl\s+Rig\s*\{([\s\S]*?)\n\}/g)) {
    for (const m of bloco[1].matchAll(/pub\s+fn\s+([a-z_][a-z0-9_]*)\s*\(/gi)) campos.add(m[1]);
  }
  if (campos.size === 0) return code;

  let out = code;
  const inventados = new Set(
    [...code.matchAll(/\br\s*\.\s*([a-z_][a-z0-9_]*)/gi)]
      .map((m) => m[1])
      .filter((n) => !campos.has(n)),
  );

  for (const nome of inventados) {
    const candidatos = [...campos].filter((c) => nome.endsWith(c) || nome.startsWith(c));
    if (candidatos.length !== 1) continue;
    out = out.replace(new RegExp(`\\br\\s*\\.\\s*${nome}\\b`, 'g'), `r.${candidatos[0]}`);
    log(p, `${id}: \`r.${nome}\` não existe no rig; era \`r.${candidatos[0]}\``);
  }
  return out;
}

/**
 * Garante que o trecho define `check`, que é o que o driver chama.
 *
 * O erro mais comum das últimas medições não era sobre o contrato nem sobre o
 * SDK: o modelo devolvia o **corpo** da asserção em vez da função, e o
 * compilador dizia `cannot find function check` ou `expected item, found
 * keyword if`. Dez de vinte trechos numa única onda.
 *
 * As três formas observadas têm conserto mecânico, então pedir ao modelo que
 * acerte é gastar uma rodada de reparo com algo que dá para reescrever:
 *
 *  1. já tem `fn check` — passa direto;
 *  2. tem uma função com a assinatura certa e outro nome — renomeia;
 *  3. são só statements soltos — embrulha, deixando os `use` do lado de fora
 *     porque eles precisam estar no topo do módulo.
 *
 * Não inventa asserção nenhuma: o corpo é exatamente o que o modelo escreveu.
 */
function normalizarCheck(p: Pipeline, code: string, id: string): string {
  // Crases soltas sobram de fence aninhado e viram `unknown start of token`.
  let out = code.split('\n').filter((l) => l.trim() !== '```' && l.trim() !== '`').join('\n');

  // `fn check()` sem parâmetro compila sozinho e quebra no driver, que chama
  // `check(&r)`. Reescrever a assinatura é mais barato que uma rodada de
  // reparo, e o corpo não muda.
  const semArg = /\b((?:pub\s+)?fn\s+check\s*)\(\s*\)/.exec(out);
  if (semArg) {
    log(p, `${id}: \`fn check()\` não recebia nada; completei a assinatura`);
    out = out.replace(semArg[0], `${semArg[1]}(r: &rig::Rig, antes: &rig::Snapshot, op: &rig::Op)`);
  }

  if (/\bfn\s+check\s*\(/.test(out)) return out;

  const outraFn = /\b(?:pub\s+)?fn\s+([a-z_][a-z0-9_]*)\s*\(\s*[a-z_]+\s*:\s*&\s*(?:rig::)?Rig\b/i.exec(out);
  if (outraFn) {
    log(p, `${id}: a função se chamava \`${outraFn[1]}\`; renomeei para \`check\`, que é o que o driver chama`);
    return out.replace(outraFn[0], outraFn[0].replace(`fn ${outraFn[1]}`, 'fn check'));
  }

  const linhas = out.split('\n');
  const corte = linhas.findIndex((l) => l.trim() && !/^\s*(use\s|#!?\[|\/\/)/.test(l));
  if (corte === -1) return out;

  const imports = linhas.slice(0, corte).join('\n');
  const corpo = linhas.slice(corte).join('\n');

  // Embrulhar um corpo com chaves desbalanceadas move o desequilíbrio para o
  // módulo e engole o `proptest!` que vem depois — o erro aparece a dezenas de
  // linhas dali, dentro de uma macro, e não se parece nada com a causa.
  // Melhor devolver como veio e deixar o compilador apontar o lugar certo.
  const abre = (corpo.match(/\{/g) ?? []).length;
  const fecha = (corpo.match(/\}/g) ?? []).length;
  if (abre !== fecha) {
    log(p, `${id}: o trecho tem chaves desbalanceadas; não embrulhei, para o erro apontar o lugar certo`);
    return out;
  }

  log(p, `${id}: o trecho era o corpo da asserção, não a função; embrulhei em \`fn check\``);
  return `${imports}\n\npub fn check(r: &rig::Rig, antes: &rig::Snapshot, op: &rig::Op) {\n${corpo}\n}\n`;
}

/**
 * Gera o rig e não devolve nada que não compile.
 *
 * O rig é a única peça que não pode ser descartada: toda asserção é escrita
 * contra ele. Por isso ganha mais tentativas de reparo que um teste comum, e
 * por isso é compilado antes de qualquer invariante ser gerada — descobrir que
 * ele está quebrado depois de quinze chamadas ao modelo custaria as quinze.
 *
 * O `#[test]` mínimo existe só para o cargo não podar `setup`/`apply` como
 * código morto e deixar de reportar os erros dentro deles.
 */
async function construirRig(
  p: Pipeline,
  info: ContractInfo,
  src: string,
): Promise<string | null> {
  const testsDir = join(info.path, 'tests');
  await mkdir(testsDir, { recursive: true });
  const caminho = join(testsDir, 'audit_generated.rs');

  const escreverSo = async (code: string) => {
    await writeFile(
      caminho,
      harnessHeader(info) + '\nmod rig {\n' + code + '\n}\n\n' +
      // O teste do rig usa exatamente o driver que as asserções vão usar.
      // Verificar só `setup()` deixava passar um `op_strategy(r: Rig)` que o
      // driver chama sem argumento: o rig compilava sozinho, as quinze
      // asserções eram geradas, e só então tudo caía junto.
      'mod contrato_com_o_driver {\n' +
      'use super::rig;\n' +
      'use proptest::prelude::*;\n' +
      'proptest! {\n' +
      '    #![proptest_config(ProptestConfig::with_cases(1))]\n' +
      '    #[test]\n' +
      '    fn rig_dirige(ops in prop::collection::vec(rig::op_strategy(), 1..3)) {\n' +
      '        let r = rig::setup();\n' +
      '        for op in &ops { let _a = rig::snapshot(&r); rig::apply(&r, op); }\n' +
      '    }\n' +
      '}\n}\n',
      'utf8',
    );
  };
  const compila = () => exec(p, info.path, 'cargo',
    ['test', '-p', info.crateName, '--test', 'audit_generated', '--no-run']);

  const crate = info.crateName.replace(/-/g, '_');

  // O rig tem que definir estas quatro coisas: é o que o driver chama e o que
  // as asserções leem. Uma rodada de reparo devolveu um rig sem `setup`, e as
  // duas seguintes gastaram-se em `cannot find function setup` — consertando o
  // erro que a correção anterior criou, nunca o original.
  const completo = (c: string) =>
    /pub\s+struct\s+Rig\b/.test(c) && /pub\s+fn\s+setup\s*\(/.test(c) &&
    /pub\s+fn\s+apply\s*\(/.test(c) && /pub\s+fn\s+op_strategy\s*\(/.test(c) &&
    /pub\s+fn\s+snapshot\s*\(/.test(c) && /pub\s+struct\s+Snapshot\b/.test(c);

  let code = '';
  let r: { code: number | null; output: string } = { code: 1, output: '' };

  // Várias amostras, não uma. O rig compilava de primeira em algumas execuções
  // e falhava em outras com o mesmo prompt e o mesmo modelo — é variância, e
  // tratá-la como determinismo transformava metade das rodadas em zero. Uma
  // geração nova custa uma chamada e escapa de um caminho ruim que nenhuma
  // quantidade de reparo desfaz.
  const AMOSTRAS = 3;
  const REPAROS = 3;

  for (let amostra = 1; amostra <= AMOSTRAS && r.code !== 0; amostra++) {
    const inicial = await complete({
      system: systemPrompt(),
      user: generateRig(info, src),
      model: p.model,
      maxTokens: 6000,
    }).catch((e) => { log(p, `!! rig: ${e.message}`); return null; });
    if (!inicial) continue;
    p.usage.entrada += inicial.usage?.entrada ?? 0;
    p.usage.saida += inicial.usage?.saida ?? 0;

    code = consertarImports(p, crate, extractCode(inicial.text, 'rust').trim(), 'rig');
    log(p, `rig: amostra ${amostra}, ${code.split('\n').length} linhas`);

    await escreverSo(code);
    r = await compila();

    for (let tentativa = 1; tentativa <= REPAROS && r.code !== 0; tentativa++) {
      if (p.cancelled) return null;
      const erros = soErros(r.output);
      log(p, `rig: reparo ${tentativa} — ${erros.split('\n')[0].slice(0, 110)}`);
      const fix = await complete({
        system: systemPrompt(),
        user: fixOneTest(
          info,
          { id: 'RIG', statement: 'the shared fixture and operation alphabet', class: 'rig', observation: '' },
          code,
          erros,
        ),
        model: p.model,
        maxTokens: 6000,
      }).catch((e) => { log(p, `!! rig: ${e.message}`); return null; });
      if (!fix) break;
      p.usage.entrada += fix.usage?.entrada ?? 0;
      p.usage.saida += fix.usage?.saida ?? 0;

      const candidato = consertarImports(p, crate, extractCode(fix.text, 'rust').trim(), 'rig');
      if (!completo(candidato)) {
        log(p, 'rig: a correção perdeu Rig/setup/apply/op_strategy; descartada');
        break;
      }
      code = candidato;
      await escreverSo(code);
      r = await compila();
    }

    if (r.code !== 0 && amostra < AMOSTRAS) {
      log(p, `rig: amostra ${amostra} não converge; gerando outra do zero`);
    }
  }

  if (r.code !== 0) {
    log(p, `!! o rig não compila em ${AMOSTRAS} amostras — nada pode ser asserido contra ele`);
    return null;
  }
  log(p, 'rig: compila');

  // Compilar não basta: um `apply` que chama o cliente sem `try_` dá panic na
  // primeira rejeição legítima, e o fuzzer produz argumentos que o contrato
  // está certo em recusar. A sequência morre no primeiro passo inválido, o
  // teste fica vermelho contra o contrato *correto*, e toda invariante é
  // descartada — um rig que compila e invalida tudo.
  //
  // É verificável sem rodar nada, então não depende de o modelo lembrar: numa
  // medição ele aplicou a regra em dois entry points e esqueceu em três.
  const queixas: string[] = [];

  const crus = [...new Set(
    [...code.matchAll(/\b(?:c|client)\s*\.\s*([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => m[1])
      .filter((n) => !n.startsWith('try_') && info.entryPoints.some((e) => e.name === n)),
  )];
  if (crus.length) {
    queixas.push(
      `In \`apply\`, these entry points are called **without** \`try_\`: ` +
      `${crus.map((n) => `\`${n}\``).join(', ')}. The fuzzer generates arguments the contract ` +
      'is right to refuse; a direct call panics on refusal, ends the sequence at its first ' +
      'invalid step, and makes the test fail against the *correct* contract. Route every ' +
      'entry-point call through `try_*` and discard the result with `let _ =`.',
    );
  }

  // `env.storage()` fora de `as_contract` dispara um debug assert do SDK cuja
  // mensagem aponta para `storage.rs`, não para o rig — lê-se como bug do SDK.
  // Um `.has()` desembrulhado deixou todas as dezenove propriedades vermelhas
  // contra o contrato correto e custou uma rodada inteira de medição.
  const soltos = [...code.matchAll(/\.storage\s*\(\s*\)/g)]
    .filter((m) => !/as_contract/.test(code.slice(Math.max(0, m.index - 300), m.index)));
  if (soltos.length) {
    queixas.push(
      `There ${soltos.length === 1 ? 'is' : 'are'} ${soltos.length} \`env.storage()\` ` +
      `access${soltos.length === 1 ? '' : 'es'} that ${soltos.length === 1 ? 'does' : 'do'} not ` +
      'appear to be inside `env.as_contract(&id, || ...)`. Storage is scoped to the contract: ' +
      'outside that closure the SDK panics on a debug assertion pointing at `storage.rs`, which ' +
      'looks like an SDK bug rather than a missing wrapper. Wrap every one of them.',
    );
  }

  if (queixas.length) {
    log(p, `rig: ${queixas.length} problema(s) que compilam mas invalidam a medição; pedindo correção`);
    const fix = await complete({
      system: systemPrompt(),
      user: `This rig compiles, but has problems that would make every property fail against ` +
        `the correct contract.\n\n\`\`\`rust\n${code}\n\`\`\`\n\n` +
        queixas.map((q, i) => `${i + 1}. ${q}`).join('\n\n') +
        '\n\nReturn the complete rig in one ```rust block with these fixed. Change nothing else.',
      model: p.model,
      maxTokens: 6000,
    }).catch(() => null);

    if (fix) {
      p.usage.entrada += fix.usage?.entrada ?? 0;
      p.usage.saida += fix.usage?.saida ?? 0;
      const candidato = consertarImports(p, crate, extractCode(fix.text, 'rust').trim(), 'rig');
      await escreverSo(candidato);
      // Só aceita se ainda compilar: uma correção que quebra o rig é pior que
      // o problema que ela conserta.
      if ((await compila()).code === 0) {
        log(p, 'rig: problemas corrigidos, e ainda compila');
        return candidato;
      }
      log(p, '!! a correção quebrou o rig; fico com a versão que compila, com os problemas');
      await escreverSo(code);
    }
  }

  return code;
}

/**
 * O bloco de saída de um teste que falhou, e só ele.
 *
 * O cargo imprime o stdout de cada teste sob um cabeçalho `---- nome stdout ----`.
 * Mandar a saída inteira ao modelo enterra o pânico que importa no meio dos
 * outros, e faz ele consertar o teste errado.
 */
function trechoDaFalha(output: string, nome: string): string {
  const marca = `---- ${nome} stdout ----`;
  const i = output.indexOf(marca);
  if (i === -1) return output.slice(-3000);
  const j = output.indexOf('\n----', i + marca.length);
  return output.slice(i, j === -1 ? i + 3000 : j).slice(0, 3000);
}

export type StageId =
  | 'inspecionar' | 'propor' | 'curadoria' | 'gerar' | 'compilar' | 'validar' | 'suite'
  | 'relatorio';

export type StageStatus =
  | 'pendente' | 'rodando' | 'ok' | 'falhou' | 'pulado' | 'aguardando';

export interface Stage {
  id: StageId;
  label: string;
  status: StageStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Payload específico da etapa, renderizado pela UI. */
  data?: unknown;
}

export interface Invariant extends CuratedInvariant {
  silent?: boolean;
  assumption?: string;
  confidence?: string;
  rationale?: string;
  /** Preenchido pela etapa de validação. */
  /**
   * `achado` é a razão de a ferramenta existir.
   *
   * Uma propriedade que continua falhando depois de uma rodada de correção é
   * ou um defeito no contrato, ou uma invariante que não vale para ele. A
   * ferramenta não sabe qual — quem audita sabe, e para decidir precisa do
   * contra-exemplo. Tratar isso como descarte, que era o que acontecia,
   * significa jogar fora justamente o que se foi procurar.
   */
  verdict?: 'mantida' | 'achado' | 'descartada' | 'nao-testada';
  verdictReason?: string;
  /** Diagnóstico do cargo, quando a invariante caiu por não compilar. */
  compileError?: string;
  /** A sequência mínima que quebra a propriedade, já encolhida pelo proptest. */
  contraExemplo?: string;
}

export interface Pipeline {
  id: string;
  path: string;
  hiddenFeatures: string[];
  /** Override do OPENROUTER_MODEL, para comparar modelos no mesmo contrato. */
  model?: string;
  /** Tokens gastos, para estimar custo por auditoria. */
  usage: { entrada: number; saida: number };
  status: 'rodando' | 'aguardando-curadoria' | 'concluido' | 'falhou' | 'cancelado';
  /**
   * Curado: o pipeline para depois de propor e espera o veredito humano.
   *
   * É o fluxo que produziu 7/7 no benchmark deste projeto, com 13 de 16
   * invariantes aceitas. O modo automático chega a 1-2 de 7 — a diferença entre
   * os dois *é* o valor da curadoria, e é por isso que os dois modos continuam
   * existindo: um é o produto, o outro é a medição.
   */
  modo: 'curado' | 'automatico';
  /** Resolve quando a curadoria chega pela API. */
  aguardando?: (ids: string[]) => void;
  stages: Stage[];
  log: string[];
  info?: ContractInfo;
  invariants: Invariant[];
  harnessCode?: string;
  harnessPath?: string;
  /** O rig gerado: fixture, operações e estratégia. */
  rigCode?: string;
  /** Diretório de build exclusivo, para auditorias simultâneas não se bloquearem. */
  targetDir?: string;
  /** A cópia autônoma onde a auditoria trabalha. O original nunca é tocado. */
  copia?: Copia;
  /** Invariantes que citam uma feature do crate pelo nome — sinal de gabarito lido. */
  vazamento?: { invariantes: string[]; features: string[] };
  rawProposal?: string;
  listeners: Set<Response>;
  cancelled: boolean;
  cancel: () => void;
}

const pipelines = new Map<string, Pipeline>();
// A saída do cargo domina o log e evictava as linhas de diagnóstico do rig,
// que são as que explicam por que uma execução deu no que deu.
const MAX_LOG = 20000;

export const getPipeline = (id: string) => pipelines.get(id);
export const listPipelines = () =>
  [...pipelines.values()]
    .map(({ listeners: _l, cancel: _c, ...rest }) => rest)
    .sort((a, b) => (b.stages[0]?.startedAt ?? 0) - (a.stages[0]?.startedAt ?? 0));

function emit(p: Pipeline, event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of p.listeners) res.write(payload);
}

function log(p: Pipeline, line: string) {
  p.log.push(line);
  if (p.log.length > MAX_LOG) p.log.splice(0, p.log.length - MAX_LOG);
  emit(p, 'log', line);
}

function setStage(p: Pipeline, id: StageId, patch: Partial<Stage>) {
  const s = p.stages.find((x) => x.id === id)!;
  Object.assign(s, patch);
  emit(p, 'stage', s);
}

/** Roda um comando, ecoando no log do pipeline. Resolve com o código de saída. */
function exec(p: Pipeline, cwd: string, cmd: string, args: string[], env?: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    // Um diretório de build por crate. Sem isso, duas auditorias simultâneas
    // disputam o lock do cargo no target compartilhado do workspace e
    // serializam — o que tornava comparar modelos uma tarefa de horas em vez
    // de minutos, por um motivo que não tem nada a ver com os modelos.
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(p.targetDir ? { CARGO_TARGET_DIR: p.targetDir } : {}), ...env },
    });
    let output = '';
    let buf = '';

    const onData = (c: Buffer) => {
      const text = c.toString();
      output += text;
      buf += text;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) log(p, l);
    };
    // cargo escreve diagnóstico e progresso em stderr; separar mostraria log
    // vazio num build que falhou.
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const onCancel = () => child.kill('SIGTERM');
    const timer = setInterval(() => p.cancelled && onCancel(), 500);

    child.on('error', (e) => {
      clearInterval(timer);
      log(p, `!! ${e.message}`);
      resolve({ code: -1, output });
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (buf) log(p, buf);
      resolve({ code, output });
    });
  });
}

/**
 * Quais testes falharam, por nome.
 *
 * O formato do cargo é `test <nome> ... FAILED`. Isto é o que permite atribuir
 * uma falha a uma invariante — sem isso, "a suíte ficou vermelha" não diz qual
 * propriedade quebrou, e uma detecção não atribuível não é uma detecção.
 */
function failedTests(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/^test\s+(\S+)\s+\.\.\.\s+FAILED/gm)) out.add(m[1]);
  for (const m of output.matchAll(/^\s{4}(\S+)$/gm)) {
    // bloco "failures:" no fim da saída
    if (/^[a-z_][a-z0-9_:]*$/i.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

/**
 * Casa um nome de teste com o ID da invariante que ele cita.
 *
 * Cada teste vive num `mod` cujo nome é o ID, então o caminho é `i12::i12_foo`
 * e o primeiro segmento resolve sozinho. O fallback por prefixo ordena por ID
 * mais longo primeiro — sem isso `i12_state_after` casa com `I1`, e uma falha
 * atribuída à invariante errada é pior que uma falha sem atribuição.
 */
function invariantForTest(test: string, invs: Invariant[]): Invariant | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const [head, ...rest] = test.split('::');
  const exato = invs.find((i) => norm(i.id) === norm(head));
  if (exato) return exato;

  const leaf = (rest.pop() ?? head).toLowerCase();
  return [...invs]
    .sort((a, b) => b.id.length - a.id.length)
    .find((i) => leaf.startsWith(norm(i.id)));
}

export function startPipeline(opts: {
  path: string;
  hiddenFeatures: string[];
  runMutants: boolean;
  model?: string;
  modo?: 'curado' | 'automatico';
}): Pipeline {
  // Um default só, resolvido uma vez. Estava em dois lugares — a lista de
  // etapas testava `opts.modo === 'curado'` e o campo usava `opts.modo ??
  // 'curado'` — então uma chamada sem `modo` criava um pipeline em modo curado
  // *sem* a etapa de curadoria, e ele morria ao tentar atualizá-la.
  const modo = opts.modo ?? 'curado';

  const p: Pipeline = {
    id: randomUUID(),
    path: opts.path,
    hiddenFeatures: opts.hiddenFeatures,
    model: opts.model,
    modo,
    usage: { entrada: 0, saida: 0 },
    status: 'rodando',
    stages: [
      { id: 'inspecionar', label: 'Inspecionar o contrato', status: 'pendente' },
      { id: 'suite', label: 'Suíte existente, antes de tocar no crate', status: 'pendente' },
      { id: 'propor', label: 'IA: propõe as invariantes', status: 'pendente' },
      ...(modo === 'curado'
        ? [{ id: 'curadoria' as StageId, label: 'Curadoria: o que vale testar', status: 'pendente' as StageStatus }]
        : []),
      { id: 'gerar', label: 'Fuzzer: rig de operações + uma asserção por invariante', status: 'pendente' },
      { id: 'compilar', label: 'Compilar, com reparo pelo erro do compilador', status: 'pendente' },
      { id: 'validar', label: 'Fuzzer: sequências sorteadas contra o contrato como ele é', status: 'pendente' },
      { id: 'relatorio', label: 'Relatório: achados, verificadas, não verificadas', status: 'pendente' },
    ],
    log: [],
    invariants: [],
    listeners: new Set(),
    cancelled: false,
    cancel: () => {
      p.cancelled = true;
      p.status = 'cancelado';
    },
  };
  pipelines.set(p.id, p);
  void run(p, opts.runMutants);
  return p;
}

async function run(p: Pipeline, runMutants: boolean) {
  const guard = () => {
    if (p.cancelled) throw Object.assign(new Error('cancelado'), { cancelled: true });
  };

  try {
    // ── 1. Inspecionar ──────────────────────────────────────────────────────
    setStage(p, 'inspecionar', { status: 'rodando', startedAt: Date.now() });
    const original = await inspectContract(p.path);

    // A auditoria trabalha numa cópia autônoma, fora do repositório. Ela precisa
    // escrever para funcionar — crate-type, dev-dependencies, o harness — e
    // fazer isso no código de quem contratou a auditoria não é aceitável, mesmo
    // sendo aditivo e reversível: basta o processo morrer no meio para o
    // Cargo.toml de outra pessoa ficar alterado.
    const copia = await copiarCrate(original.path, p.id);
    p.copia = copia;
    for (const a of copia.ajustes) log(p, `cópia: ${a}`);
    log(p, `a auditoria roda em ${copia.dir} — o crate original não é tocado`);

    // Reinspeciona a cópia: é sobre ela que tudo daqui para a frente fala.
    const info = await inspectContract(copia.dir);
    p.info = info;
    p.targetDir = join(info.path, '.audit-target');
    setStage(p, 'inspecionar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${info.crateName} · ${info.entryPoints.length} entry points`,
      data: info,
    });
    for (const w of info.warnings) log(p, `aviso: ${w}`);

    // Um contrato Soroban de verdade é quase sempre `crate-type = ["cdylib"]`
    // e nada mais — é o que o template da Stellar gera e o que está em todos os
    // soroban-examples. Um teste de integração em `tests/` não linka um crate
    // cdylib-only, então a ferramenta simplesmente não rodava neles: funcionava
    // no contrato deste repositório porque eu mesmo o declarei como `lib`.
    //
    // A correção é aditiva e reversível: acrescenta `"lib"`, guarda o manifesto
    // original e o devolve na limpeza. Fica registrado no log porque é uma
    // escrita no crate de outra pessoa.
    const editado = await prepararCrate(p, info);
    for (const e of editado) log(p, `Cargo.toml: ${e}`);
    if (editado.length) log(p, 'Tudo isso na cópia — o Cargo.toml original fica intacto.');
    guard();

    // ── 2. Suíte existente, como baseline ───────────────────────────────────
    //
    // Antes de escrever qualquer coisa no crate. O arquivo gerado vai para
    // tests/, então medir a suíte depois mediria o estrago da própria
    // ferramenta — e foi o que aconteceu na primeira versão: o harness não
    // compilava e a suíte do usuário aparecia vermelha por causa dele.
    setStage(p, 'suite', { status: 'rodando', startedAt: Date.now() });
    const baseline = await exec(p, info.path, 'cargo', ['test', '-p', info.crateName],
      AMBIENTE_PROPTEST(32));
    const baselineOk = baseline.code === 0;
    setStage(p, 'suite', {
      status: baselineOk ? 'ok' : 'falhou',
      finishedAt: Date.now(),
      detail: baselineOk
        ? 'verde — o que vier depois é atribuível'
        : 'já falha antes da ferramenta tocar em nada; nada depois é atribuível',
      data: { failed: failedTests(baseline.output) },
    });
    guard();

    if (!isConfigured()) {
      setStage(p, 'propor', {
        status: 'falhou',
        detail: 'OPENROUTER_API_KEY não definida em api/.env',
      });
      p.status = 'falhou';
      emit(p, 'done', { status: p.status });
      return;
    }

    // ── 2. Propor ───────────────────────────────────────────────────────────
    setStage(p, 'propor', { status: 'rodando', startedAt: Date.now() });
    const src = cleanView(await contractSource(info), p.hiddenFeatures);

    // O teste de referência passa pelo mesmo filtro. Os testes de um crate
    // costumam citar nos comentários exatamente o que a etapa de esconder
    // features existe para não mostrar — mandar um deles cru anularia o
    // cuidado tomado com o fonte.
    if (info.exampleTest && p.hiddenFeatures.length) {
      const limpo = cleanView(info.exampleTest.source, p.hiddenFeatures);
      const alt = p.hiddenFeatures.join('|');
      if (new RegExp(alt).test(limpo)) {
        log(p, `teste de referência descartado: ainda cita ${p.hiddenFeatures.join(', ')}`);
        info.exampleTest = undefined;
      } else {
        info.exampleTest = { ...info.exampleTest, source: limpo };
      }
    }

    log(p, `fonte enviada ao modelo: ${src.split('\n').length} linhas` +
      (p.hiddenFeatures.length ? ` (features escondidas: ${p.hiddenFeatures.join(', ')})` : '') +
      (info.exampleTest ? ` · referência de API: ${info.exampleTest.file.split('/').pop()}` : ' · sem teste de referência'));

    const proposta = await complete({
      system: systemPrompt(),
      user: proposeInvariants(info, src),
      model: p.model,
      // Folgado de propósito: a 8000 o JSON de um modelo verboso vinha
      // truncado, e "0 propostas" parecia falha do modelo quando era corte meu.
      maxTokens: 16000,
    });
    p.usage.entrada += proposta.usage?.entrada ?? 0;
    p.usage.saida += proposta.usage?.saida ?? 0;
    p.rawProposal = proposta.text;

    const { invs, perdidos } = parseInvariants(proposta.text);
    if (perdidos) log(p, `aviso: ${perdidos} objeto(s) do catálogo vieram malformados e foram descartados`);

    if (invs.length === 0) {
      setStage(p, 'propor', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: 'O modelo não devolveu nenhuma invariante legível.',
        data: { raw: proposta.text },
      });
      p.status = 'falhou';
      emit(p, 'done', { status: p.status });
      return;
    }

    p.invariants = invs.map((i) => ({ ...i, verdict: 'nao-testada' as const }));

    // Uma invariante que cita pelo nome uma feature escondida não foi
    // deduzida do contrato — foi lida do gabarito. Acontece quando ninguém
    // marcou as features na tela, e o resultado *parece* excelente: o modelo
    // descreve com precisão bugs que ele está enxergando.
    //
    // Sem este aviso a execução passa por uma detecção brilhante. É o modo de
    // falha mais perigoso desta ferramenta, porque erra para o lado bonito.
    const todas = info.features;
    if (todas.length) {
      const alt = todas.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      const re = new RegExp(`\\b(${alt})\\b`);
      const vazando = p.invariants.filter(
        (i) => re.test(`${i.statement} ${i.observation ?? ''} ${i.assumption ?? ''}`));

      if (vazando.length) {
        const citadas = [...new Set(vazando.flatMap(
          (i) => (`${i.statement} ${i.observation ?? ''} ${i.assumption ?? ''}`.match(new RegExp(alt, 'g')) ?? [])))];
        p.vazamento = { invariantes: vazando.map((i) => i.id), features: citadas };
        log(p, `!! ATENÇÃO: ${vazando.length} invariante(s) citam ${citadas.join(', ')} pelo nome — ` +
          'o modelo está lendo os bugs no fonte, não deduzindo do contrato. ' +
          'Marque essas features para esconder e rode de novo; esta execução não mede detecção.');
      }
    }
    setStage(p, 'propor', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${p.invariants.length} propostas · ${proposta.model}` +
        (perdidos ? ` · ${perdidos} descartada(s) por JSON inválido` : ''),
      data: { invariants: p.invariants, raw: proposta.text, perdidos, vazamento: p.vazamento },
    });
    guard();

    // ── 2b. Curadoria ───────────────────────────────────────────────────────
    //
    // O pipeline para aqui e espera. É a única etapa em que uma pessoa entra, e
    // é a que o benchmark deste projeto mostra valer mais: com curadoria, 7 dos
    // 7 bugs plantados; sem ela, 1 ou 2. A diferença não está em a IA propor
    // invariantes melhores — está em alguém gastar trinta segundos separando as
    // que valem das que só parecem valer.
    if (p.modo === 'curado') {
      setStage(p, 'curadoria', {
        status: 'aguardando',
        startedAt: Date.now(),
        detail: `${p.invariants.length} propostas — aceite as que valem testar`,
        data: { invariants: p.invariants },
      });
      p.status = 'aguardando-curadoria';
      emit(p, 'curadoria', { invariants: p.invariants, vazamento: p.vazamento ?? null });

      const aceitas = await new Promise<string[]>((resolve) => { p.aguardando = resolve; });
      p.aguardando = undefined;
      guard();

      const conjunto = new Set(aceitas);
      const propostas = p.invariants.length;
      for (const inv of p.invariants) {
        if (!conjunto.has(inv.id)) {
          inv.verdict = 'descartada';
          inv.verdictReason = 'Rejeitada na curadoria.';
        }
      }
      p.invariants = p.invariants.filter((i) => conjunto.has(i.id));
      p.status = 'rodando';

      setStage(p, 'curadoria', {
        status: 'ok',
        finishedAt: Date.now(),
        detail: `${p.invariants.length} aceitas de ${propostas}` +
          (propostas > p.invariants.length ? `, ${propostas - p.invariants.length} rejeitada(s)` : ''),
        data: { aceitas: p.invariants },
      });

      if (p.invariants.length === 0) {
        setStage(p, 'gerar', { status: 'pulado', detail: 'nenhuma invariante aceita' });
        setStage(p, 'compilar', { status: 'pulado' });
        setStage(p, 'validar', { status: 'pulado' });
        await relatorio(p, { compilou: false, baselineOk });
        return;
      }
    }

    // ── 3. Rig, depois uma asserção por invariante ──────────────────────────
    //
    // A decomposição anterior — um teste completo e independente por
    // invariante — media quase nada: 2/7, depois 1/7, depois 0/7 contra sete
    // bugs conhecidos, *piorando* conforme o prompt melhorava. Cada teste
    // montava um cenário único escolhido pelo modelo, e um cenário único só
    // encontra um bug se acertar o gatilho de primeira.
    //
    // Agora há um rig: fixture, alfabeto de operações, e uma estratégia que
    // sorteia sequências. Cada invariante vira uma `check(&Rig)` chamada depois
    // de **cada** operação, então toda propriedade vê todo estado que o fuzzer
    // alcança. É o que o braço de referência deste projeto fez para chegar a
    // 7/7, e é a metade "fuzzing" de um projeto sobre fuzzing com IA, que a
    // decomposição tinha silenciosamente removido.
    setStage(p, 'gerar', { status: 'rodando', startedAt: Date.now() });

    const testes: { inv: Invariant; code: string }[] = [];
    let impossiveis = 0;

    // As chamadas são independentes — uma invariante não sabe da outra — então
    // serializá-las só multiplicava a latência por N. A ordem do arquivo final
    // continua sendo a do catálogo: os resultados voltam indexados, não na
    // ordem em que chegaram.
    const gerados: (string | null)[] = new Array(p.invariants.length).fill(null);
    const CONC = 4;
    let proximo = 0;

    // O rig vem antes de tudo e é compilado sozinho: se ele não compilar,
    // nenhuma asserção escrita contra ele compila, e gerar quinze delas antes
    // de descobrir isso gastaria quinze chamadas para nada.
    const rigCode = await construirRig(p, info, src);
    if (!rigCode) {
      setStage(p, 'gerar', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: 'o rig não compila — sem fixture não há o que asserir',
      });
      setStage(p, 'compilar', { status: 'pulado' });
      setStage(p, 'validar', { status: 'pulado' });
      await relatorio(p, { compilou: false, baselineOk });
      return;
    }
    p.rigCode = rigCode;

    await Promise.all(Array.from({ length: Math.min(CONC, p.invariants.length) }, async () => {
      for (;;) {
        const i = proximo++;
        if (i >= p.invariants.length) return;
        guard();
        const inv = p.invariants[i];
        const r = await complete({
          system: systemPrompt(),
          user: generateCheck(info, src, inv, rigCode),
          model: p.model,
          maxTokens: 3000,
        }).catch((e) => { log(p, `${inv.id}: !! ${e.message}`); return null; });
        if (!r) continue;
        p.usage.entrada += r.usage?.entrada ?? 0;
        p.usage.saida += r.usage?.saida ?? 0;
        const bruto = extractCode(r.text, 'rust').trim();
        gerados[i] = /^\/\/\s*IMPOSSIVEL/i.test(bruto)
          ? bruto
          : alinharCamposDoRig(p, normalizarCheck(p, consertarImports(
              p, info.crateName.replace(/-/g, '_'), bruto, inv.id), inv.id), rigCode, inv.id);
        log(p, `${inv.id}: ${gerados[i]!.split('\n').length} linhas`);
      }
    }));

    for (let i = 0; i < p.invariants.length; i++) {
      const inv = p.invariants[i];
      const code = gerados[i];
      if (code === null) {
        inv.verdict = 'descartada';
        inv.verdictReason = 'A chamada ao modelo falhou para esta invariante.';
        continue;
      }
      if (/^\/\/\s*IMPOSSIVEL/i.test(code)) {
        inv.verdict = 'descartada';
        inv.verdictReason = code.replace(/^\/\/\s*IMPOSSIVEL:?\s*/i, '').trim() ||
          'o modelo declarou a invariante inexprimível pela API pública';
        impossiveis++;
        log(p, `${inv.id}: inexprimível — ${inv.verdictReason.slice(0, 90)}`);
        continue;
      }
      testes.push({ inv, code });
    }

    // O driver é escrito aqui, não pelo modelo.
    //
    // Ele é a parte que decide se a coisa encontra algo — sequência sorteada,
    // check depois de cada operação, inclusive no estado inicial — e é idêntico
    // para toda invariante. Deixar o modelo reescrevê-lo quinze vezes seria
    // quinze oportunidades de escrever uma versão que só confere no fim.
    //
    // Um teste por invariante, e não um teste que confere todas, porque uma
    // falha tem que ser atribuível: `i7::i7_sequencia` diz qual propriedade
    // quebrou, `sequencia` não diz nada.
    const escrever = async (items: { inv: Invariant; code: string }[]) => {
      const corpo = items.map((t) => {
        const slug = t.inv.id.toLowerCase().replace(/[^a-z0-9_]/g, '');
        // `use super::rig;` é adicionado aqui; se o modelo também o escreveu,
        // o import duplicado é erro de compilação.
        const limpo = t.code.replace(/^\s*use\s+super::rig\s*;\s*$/gm, '');
        return `mod ${slug} {
use super::rig;
use proptest::prelude::*;

${limpo}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn ${slug}_sequencia(ops in prop::collection::vec(rig::op_strategy(), 1..12)) {
        let r = rig::setup();
        for op in &ops {
            // O estado de antes é capturado aqui, não dentro do check: uma
            // propriedade sobre transição — "esta chamada não mudou nada", "o
            // total subiu exatamente o que entrou" — é inexpressável a partir
            // do estado atual sozinho, e é justamente a classe que vale.
            let antes = rig::snapshot(&r);
            rig::apply(&r, op);
            check(&r, &antes, op);
        }
    }
}
}`;
      }).join('\n\n');

      await writeFile(
        p.harnessPath!,
        harnessHeader(info) + '\nmod rig {\n' + rigCode + '\n}\n\n' + corpo + '\n',
        'utf8',
      );
    };

    const testsDir = join(info.path, 'tests');
    await mkdir(testsDir, { recursive: true });
    p.harnessPath = join(testsDir, 'audit_generated.rs');
    await escrever(testes);
    p.harnessCode = await readFile(p.harnessPath, 'utf8');

    setStage(p, 'gerar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${testes.length} testes` + (impossiveis ? `, ${impossiveis} inexprimível(eis)` : ''),
      data: { code: p.harnessCode, path: p.harnessPath, impossiveis },
    });
    guard();

    // ── 4. Compilar, descartando o que não compila ──────────────────────────
    //
    // Um teste que não compila não vira achado nem vira evidência — ele sai, e
    // os outros seguem. Bissecção: compila tudo; se falhar, tenta cada um
    // sozinho para saber quais são os culpados. Custa N compilações no pior
    // caso, e o pior caso é raro.
    setStage(p, 'compilar', { status: 'rodando', startedAt: Date.now() });
    const compila = () => exec(p, info.path, 'cargo',
      ['test', '-p', info.crateName, '--test', 'audit_generated', '--no-run']);

    let build = await compila();
    let descartadosCompilacao = 0;
    let reparados = 0;

    if (build.code !== 0 && testes.length >= 1) {
      log(p, '--- o conjunto não compila; isolando os testes culpados ---');
      const bons: typeof testes = [];

      for (const t of testes) {
        guard();
        await escrever([t]);
        let r = await compila();

        // Reparo com o erro do compilador na mão. Duas tentativas: no corpus
        // deste projeto o erro típico é uma assinatura só, e o que não cede em
        // duas rodadas não cede em cinco — insistir só queima token.
        for (let tentativa = 1; tentativa <= 3 && r.code !== 0; tentativa++) {
          guard();
          const erros = soErros(r.output);
          log(p, `${t.inv.id}: tentativa de reparo ${tentativa} — ${erros.split('\n')[0].slice(0, 100)}`);
          const fix = await complete({
            system: systemPrompt(),
            user: fixOneTest(info, t.inv, t.code, erros),
            model: p.model,
            maxTokens: 3000,
          }).catch((e) => { log(p, `!! reparo falhou: ${e.message}`); return null; });
          if (!fix) break;
          p.usage.entrada += fix.usage?.entrada ?? 0;
          p.usage.saida += fix.usage?.saida ?? 0;

          const novo = extractCode(fix.text, 'rust').trim();
          if (/^\/\/\s*IMPOSSIVEL/i.test(novo)) {
            log(p, `${t.inv.id}: o modelo desistiu — inexprimível contra a API real`);
            break;
          }
          // O driver chama `check(&r)`. Uma correção que renomeia ou perde a
          // função troca o erro original por `cannot find function check`, e as
          // tentativas seguintes passam a consertar o erro que a correção
          // anterior criou — foi o que consumiu três rodadas em quatro
          // invariantes de uma medição, sem nunca voltar ao problema real.
          const normalizado = alinharCamposDoRig(
            p, normalizarCheck(p, novo, t.inv.id), rigCode, t.inv.id);
          if (!/\bfn\s+check\s*\(/.test(normalizado)) {
            log(p, `${t.inv.id}: a correção perdeu \`fn check\` e não dava para reconstruir`);
            break;
          }
          t.code = normalizado;
          await escrever([t]);
          r = await compila();
          if (r.code === 0) {
            reparados++;
            log(p, `${t.inv.id}: compila após ${tentativa} reparo(s)`);
          }
        }

        if (r.code === 0) {
          bons.push(t);
        } else {
          t.inv.verdict = 'descartada';
          t.inv.verdictReason =
            'O teste gerado para esta invariante não compila, nem depois de três ' +
            'rodadas de correção com o erro do compilador. Sem um teste que rode, ' +
            'a propriedade não foi verificada nem refutada — ela sai do relatório em ' +
            'vez de entrar como achado sem evidência.';
          t.inv.compileError = soErros(r.output).slice(0, 4000);
          descartadosCompilacao++;
          log(p, `${t.inv.id}: descartado, não compila`);
        }
      }

      testes.length = 0;
      testes.push(...bons);
      await escrever(testes);
      p.harnessCode = await readFile(p.harnessPath, 'utf8');
      build = await compila();

      // Cada um compila sozinho mas o conjunto não: colisão entre testes. Com
      // um `mod` por teste isso não deveria acontecer, e se acontecer eu quero
      // ver o erro no log em vez de perder tudo em silêncio.
      if (build.code !== 0 && bons.length > 0) {
        log(p, '!! cada teste compila sozinho mas o conjunto não — colisão entre módulos');
      }
    }

    if (build.code !== 0) {
      setStage(p, 'compilar', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: 'nenhum teste gerado compila',
      });
      setStage(p, 'validar', { status: 'pulado', detail: 'nada para rodar' });
      await relatorio(p, { compilou: false, baselineOk });
      return;
    }

    // Zero testes restantes não é "compilou": o arquivo passa a conter só o
    // rig, o cargo fica verde, e a validação seguinte reportava "todas as 15
    // sobrevivem ao contrato correto" sobre um arquivo sem nenhuma asserção.
    if (testes.length === 0) {
      setStage(p, 'compilar', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: `nenhuma das ${p.invariants.length} asserções compila`,
        data: { descartadosCompilacao, reparados },
      });
      setStage(p, 'validar', { status: 'pulado', detail: 'nada para rodar' });
      await relatorio(p, { compilou: false, baselineOk });
      return;
    }

    setStage(p, 'compilar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${testes.length} compilam` +
        (reparados ? `, ${reparados} após reparo` : '') +
        (descartadosCompilacao ? `, ${descartadosCompilacao} descartado(s)` : ''),
      data: { descartadosCompilacao, reparados },
    });
    guard();

    // ── 5. Validar contra o contrato como ele é ─────────────────────────────
    //
    // A curadoria, feita pela execução em vez de por um humano clicando. Uma
    // invariante que falha contra o contrato *correto* é um falso positivo, e
    // reportá-la seria acusar bug onde não há. É o mesmo controle de contrato
    // limpo que o benchmark deste projeto usa, virado em etapa.
    setStage(p, 'validar', { status: 'rodando', startedAt: Date.now() });
    const val = await exec(p, info.path, 'cargo',
      ['test', '-p', info.crateName, '--test', 'audit_generated'],
      AMBIENTE_PROPTEST(VALIDACAO_CASOS));
    guard();

    let falhos = failedTests(val.output);

    // Uma rodada de reparo para quem falhou contra o contrato correto.
    //
    // "Falha no limpo" é ambíguo: ou a invariante não vale, ou o harness a
    // implementou errado. Descartar os dois casos juntos e em silêncio
    // enviesava o pipeline inteiro — as propriedades difíceis são as que mais
    // valem e também as mais fáceis de implementar errado na primeira
    // tentativa, então o filtro vinha selecionando as triviais. Numa medição,
    // as cinco que morreram aqui incluíam a lei de conservação e a de TTL,
    // enquanto sobreviveram "o saldo não é negativo" e "a flag é permanente".
    if (falhos.length) {
      log(p, `--- ${falhos.length} teste(s) falham no contrato correto; perguntando se é o harness ou a invariante ---`);
      const saida = val.output;

      for (const nome of falhos) {
        guard();
        const t = testes.find((x) => invariantForTest(nome, [x.inv]));
        if (!t) continue;

        const trecho = trechoDaFalha(saida, nome);
        const fix = await complete({
          system: systemPrompt(),
          user: fixFailingTest(info, t.inv, t.code, trecho),
          model: p.model,
          maxTokens: 3000,
        }).catch((e) => { log(p, `!! ${t.inv.id}: ${e.message}`); return null; });
        if (!fix) continue;
        p.usage.entrada += fix.usage?.entrada ?? 0;
        p.usage.saida += fix.usage?.saida ?? 0;

        const novo = extractCode(fix.text, 'rust').trim();
        if (/^\/\/\s*FALSA/i.test(novo)) {
          t.inv.verdict = 'descartada';
          t.inv.verdictReason = 'A invariante não vale para este contrato. ' +
            novo.replace(/^\/\/\s*FALSA:?\s*/i, '').trim();
          log(p, `${t.inv.id}: o modelo conclui que a própria invariante é falsa`);
          continue;
        }
        t.code = novo;
        log(p, `${t.inv.id}: harness corrigido, revalidando`);
      }

      // Revalida o conjunto inteiro de uma vez: os corrigidos podem ter passado,
      // e os que o modelo declarou falsos já saíram.
      const restantes = testes.filter((x) => x.inv.verdict !== 'descartada');
      if (restantes.length) {
        await escrever(restantes);
        const rebuild = await compila();
        if (rebuild.code === 0) {
          const val2 = await exec(p, info.path, 'cargo',
            ['test', '-p', info.crateName, '--test', 'audit_generated'],
            AMBIENTE_PROPTEST(VALIDACAO_CASOS));
          falhos = failedTests(val2.output);
        } else {
          log(p, '!! uma correção quebrou a compilação; mantenho o veredito anterior');
          // Volta o arquivo para o estado que compilava.
          await escrever(testes.filter((x) => x.inv.verdict !== 'descartada'));
        }
      }
    }

    let descartadas = p.invariants.filter((i) => i.verdict === 'descartada' &&
      /não vale para este contrato/.test(i.verdictReason ?? '')).length;

    for (const t of falhos) {
      const inv = invariantForTest(t, p.invariants);
      if (inv && inv.verdict !== 'descartada') {
        inv.verdict = 'achado';
        inv.verdictReason =
          'A propriedade falha contra o contrato, e continuou falhando depois de uma ' +
          'rodada de correção do harness. Ou o contrato tem um defeito aqui, ou a ' +
          'invariante não vale para ele — o contra-exemplo é o que decide, e quem ' +
          'decide é quem audita.';
        inv.contraExemplo = trechoDaFalha(val.output, t);
      }
    }
    for (const i of p.invariants) {
      if (i.verdict === 'nao-testada') {
        i.verdict = falhos.length === 0 ? 'mantida' : 'mantida';
      }
    }
    // Falhas que não casam com nenhuma invariante: o harness quebrou por conta
    // própria, e isso é sobre o harness, não sobre o contrato.
    const orfas = falhos.filter((t) => !invariantForTest(t, p.invariants));

    // O harness que fica no crate contém **só** o que passa no contrato como
    // ele é. Um teste que já falha aqui falha contra qualquer versão do
    // contrato, então deixá-lo no arquivo transforma toda execução futura em
    // detecção falsa — foi o que quase aconteceu com a primeira medição de
    // detecção, cujos números incluíam cinco testes vermelhos de nascença.
    let sobreviventes = testes.filter((t) => t.inv.verdict === 'nao-testada' || t.inv.verdict === 'mantida');
    if (sobreviventes.length !== testes.length) {
      await escrever(sobreviventes);
      p.harnessCode = await readFile(p.harnessPath, 'utf8');
    }

    // ── A prova de repetição ────────────────────────────────────────────────
    //
    // O proptest sorteia sementes novas a cada execução, então "passou" é uma
    // afirmação sobre as sequências desta rodada, não sobre a propriedade. Uma
    // execução aprovou doze invariantes com 256 casos e o harness ficou
    // vermelho na rodada seguinte, no mesmo contrato — e um harness que fica
    // vermelho amanhã é pior que inútil para quem for usá-lo: ele acusa bug
    // onde não há e some com a confiança no resto do relatório.
    //
    // Rodar de novo, com sementes novas, é o teste mais direto disso. O que não
    // repete sai, e sai dizendo por quê: a propriedade pode até valer, mas o
    // que existe aqui é um teste instável, e instável não é evidência.
    for (let rodada = 1; rodada <= 2 && sobreviventes.length; rodada++) {
      guard();
      const repeticao = await exec(p, info.path, 'cargo',
        ['test', '-p', info.crateName, '--test', 'audit_generated'],
        AMBIENTE_PROPTEST(VALIDACAO_CASOS));
      if (repeticao.code === 0) {
        log(p, `harness final: ${sobreviventes.length} testes, verde em ${rodada + 1} execuções independentes`);
        break;
      }

      const instaveis = failedTests(repeticao.output);
      const corrigidas = new Set<string>();
      const antesDoConserto = new Map<string, string>();
      for (const nome of instaveis) {
        const inv = invariantForTest(nome, p.invariants);
        if (!inv || inv.verdict === 'descartada') continue;
        const t = sobreviventes.find((x) => x.inv === inv);

        // Uma tentativa de conserto antes de descartar. A instabilidade costuma
        // ser do harness e não da propriedade — uma soma de saldos que estoura
        // `i128` só nas sequências que alcançam o extremo, por exemplo. Jogar a
        // propriedade fora por causa disso é o mesmo viés de sobrevivência que
        // já tinha esvaziado o relatório antes: o que morre primeiro é sempre o
        // que tenta fazer algo difícil.
        if (t && rodada === 1) {
          const fix = await complete({
            system: systemPrompt(),
            user: fixFailingTest(info, inv, t.code, trechoDaFalha(repeticao.output, nome)),
            model: p.model,
            maxTokens: 3000,
          }).catch(() => null);
          if (fix) {
            p.usage.entrada += fix.usage?.entrada ?? 0;
            p.usage.saida += fix.usage?.saida ?? 0;
            const novoCode = extractCode(fix.text, 'rust').trim();
            if (!/^\/\/\s*FALSA/i.test(novoCode)) {
              const normalizado = alinharCamposDoRig(
                p, normalizarCheck(p, novoCode, inv.id), rigCode, inv.id);
              if (/\bfn\s+check\s*\(/.test(normalizado)) {
                antesDoConserto.set(inv.id, t.code);
                corrigidas.add(inv.id);
                t.code = normalizado;
                log(p, `${inv.id}: instável; tentando o harness corrigido`);
                continue;
              }
            }
          }
        }

        inv.verdict = 'descartada';
        inv.verdictReason =
          'O teste passou numa execução e falhou na seguinte, com sementes diferentes ' +
          'e o mesmo contrato, e não estabilizou depois de uma correção. A propriedade ' +
          'pode até valer, mas o que foi gerado é um teste instável — e um teste ' +
          'instável não é evidência, é um alarme que vai disparar sozinho depois.';
        descartadas++;
        log(p, `${inv.id}: instável entre execuções; descartado`);
      }
      sobreviventes = sobreviventes.filter((t) => t.inv.verdict !== 'descartada' && t.inv.verdict !== 'achado');
      await escrever(sobreviventes);
      // Um harness corrigido que não compila derruba o arquivo inteiro, e a
      // culpada é conhecida: só as que acabaram de ser corrigidas. Reverter
      // essas e manter o resto é a resposta proporcional — descartar tudo
      // puniria doze propriedades boas pelo erro de uma.
      if ((await compila()).code !== 0) {
        log(p, '!! uma correção de instabilidade não compila; revertendo só as corrigidas');
        for (const t of sobreviventes) {
          if (!corrigidas.has(t.inv.id)) continue;
          t.code = antesDoConserto.get(t.inv.id) ?? t.code;
          t.inv.verdict = 'descartada';
          t.inv.verdictReason =
            'O teste era instável, e a correção proposta não compila. Sem um teste que ' +
            'rode de forma repetível, a propriedade não foi verificada nem refutada.';
          descartadas++;
        }
        sobreviventes = sobreviventes.filter((t) => t.inv.verdict !== 'descartada');
        await escrever(sobreviventes);
      }
      p.harnessCode = await readFile(p.harnessPath, 'utf8');
    }

    setStage(p, 'validar', {
      status: 'ok',
      finishedAt: Date.now(),
      // Conta sobre o que foi *testado*, não sobre o catálogo: dizer "todas as 7
      // sobrevivem" quando duas nem compilaram atribui a elas uma aprovação que
      // ninguém deu.
      detail: (() => {
        const nAchados = p.invariants.filter((i) => i.verdict === 'achado').length;
        if (nAchados === 0 && descartadas === 0 && orfas.length === 0) {
          return `as ${testes.length} testadas sobrevivem ao contrato`;
        }
        // "Sobrevivem" com quatro achados ao lado era uma frase falsa: o
        // contador de descartes não via as que viraram achado.
        return [
          nAchados ? `${nAchados} falha(m) — a investigar` : '',
          descartadas ? `${descartadas} descartada(s)` : '',
          orfas.length ? `${orfas.length} falha(s) órfã(s)` : '',
        ].filter(Boolean).join(', ') + ` de ${testes.length} testadas`;
      })(),
      data: { falhos, descartadas, orfas },
    });

    if (runMutants && !p.cancelled) {
      log(p, '--- cargo mutants ---');
      await exec(p, info.path, 'cargo',
        ['mutants', '-p', info.crateName, '--timeout', '120', '--', '--test', 'audit_generated'],
        AMBIENTE_PROPTEST(32));
    }
    await relatorio(p, { compilou: true, baselineOk, descartadas, orfas });
  } catch (e: any) {
    if (e?.cancelled) {
      p.status = 'cancelado';
      emit(p, 'done', { status: p.status });
      return;
    }
    log(p, `!! ${e?.message ?? e}`);
    const atual = p.stages.find((s) => s.status === 'rodando');
    if (atual) setStage(p, atual.id, { status: 'falhou', detail: e?.message, finishedAt: Date.now() });
    p.status = 'falhou';
    emit(p, 'done', { status: p.status });
  }
}

async function relatorio(p: Pipeline, extra: Record<string, unknown>) {
  const diff: ArquivoDiff[] = p.copia ? await diffDaCopia(p.copia).catch(() => []) : [];
  const mantidas = p.invariants.filter((i) => i.verdict === 'mantida');
  const achados = p.invariants.filter((i) => i.verdict === 'achado');
  const descartadas = p.invariants.filter((i) => i.verdict === 'descartada');

  setStage(p, 'relatorio', {
    status: 'ok',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    detail: (achados.length ? `${achados.length} a investigar · ` : '') +
      `${mantidas.length} verificadas, ${descartadas.length} descartadas`,
    data: {
      ...extra,
      propostas: p.invariants.length,
      mantidas: mantidas.length,
      achados: achados.length,
      descartadas: descartadas.length,
      yield: p.invariants.length
        ? Math.round((mantidas.length / p.invariants.length) * 100)
        : 0,
      invariants: p.invariants,
      diff,
      copia: p.copia?.dir,
      // O custo entra no relatório porque é metade do argumento: uma auditoria
      // que custa centavos pode rodar a cada pull request; uma que custa dois
      // dólares roda quando alguém lembra.
      usage: p.usage,
      modelo: p.model ?? currentModel(),
    },
  });

  p.status = 'concluido';
  emit(p, 'done', { status: p.status });
}

export function attachPipeline(p: Pipeline, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Replay: quem abre a página no meio da execução vê tudo que já passou.
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    id: p.id, status: p.status, stages: p.stages, log: p.log,
  })}\n\n`);

  if (p.status !== 'rodando') {
    res.write(`event: done\ndata: ${JSON.stringify({ status: p.status })}\n\n`);
    res.end();
    return;
  }

  p.listeners.add(res);
  res.on('close', () => p.listeners.delete(res));
}

/**
 * Entrega o veredito da curadoria e destrava o pipeline.
 *
 * Devolve `false` se o pipeline não está esperando — chamar duas vezes, ou
 * chamar um pipeline em modo automático, não deve derrubar nada.
 */
export function curar(p: Pipeline, aceitas: string[]): boolean {
  if (!p.aguardando) return false;
  p.aguardando(aceitas);
  return true;
}

/**
 * Descarta a cópia inteira.
 *
 * Não há mais nada a desfazer no crate original — a auditoria nunca escreveu
 * nele. O que se apaga aqui é só espaço em disco, e é por isso que a limpeza
 * deixou de ser uma obrigação e virou uma conveniência: se ninguém chamar, o
 * pior que acontece é uma pasta esquecida em /tmp.
 */
export async function cleanupHarness(p: Pipeline) {
  if (p.copia) {
    await descartarCopia(p.copia);
    p.copia = undefined;
  }
}

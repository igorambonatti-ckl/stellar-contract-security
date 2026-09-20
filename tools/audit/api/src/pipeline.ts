import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Response } from 'express';

import { inspectContract, cleanView, contractSource, type ContractInfo } from './inspect.js';
import { complete, extractCode, isConfigured } from './openrouter.js';
import {
  systemPrompt, proposeInvariants, generateOneTest, fixOneTest, fixFailingTest, harnessHeader,
  type CuratedInvariant,
} from './prompts.js';

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
 * As duas edições são aditivas, e o manifesto original volta na limpeza.
 * Devolve a lista do que mudou, para o log dizer em voz alta — é o `Cargo.toml`
 * de outra pessoa.
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

  if (feito.length) {
    p.manifestoOriginal = { caminho, conteudo: original };
    await writeFile(caminho, texto, 'utf8');
  }
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
  | 'inspecionar' | 'propor' | 'gerar' | 'compilar' | 'validar' | 'suite' | 'relatorio';

export type StageStatus = 'pendente' | 'rodando' | 'ok' | 'falhou' | 'pulado';

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
  verdict?: 'mantida' | 'descartada' | 'nao-testada';
  verdictReason?: string;
  /** Diagnóstico do cargo, quando a invariante caiu por não compilar. */
  compileError?: string;
}

export interface Pipeline {
  id: string;
  path: string;
  hiddenFeatures: string[];
  /** Override do OPENROUTER_MODEL, para comparar modelos no mesmo contrato. */
  model?: string;
  /** Tokens gastos, para estimar custo por auditoria. */
  usage: { entrada: number; saida: number };
  status: 'rodando' | 'concluido' | 'falhou' | 'cancelado';
  stages: Stage[];
  log: string[];
  info?: ContractInfo;
  invariants: Invariant[];
  harnessCode?: string;
  harnessPath?: string;
  /** Manifesto original, quando a ferramenta precisou mexer no crate-type. */
  manifestoOriginal?: { caminho: string; conteudo: string };
  rawProposal?: string;
  listeners: Set<Response>;
  cancelled: boolean;
  cancel: () => void;
}

const pipelines = new Map<string, Pipeline>();
const MAX_LOG = 3000;

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
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
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
}): Pipeline {
  const p: Pipeline = {
    id: randomUUID(),
    path: opts.path,
    hiddenFeatures: opts.hiddenFeatures,
    model: opts.model,
    usage: { entrada: 0, saida: 0 },
    status: 'rodando',
    stages: [
      { id: 'inspecionar', label: 'Inspecionar o contrato', status: 'pendente' },
      { id: 'suite', label: 'Suíte existente, antes de tocar no crate', status: 'pendente' },
      { id: 'propor', label: 'IA propõe invariantes', status: 'pendente' },
      { id: 'gerar', label: 'IA escreve um teste por invariante', status: 'pendente' },
      { id: 'compilar', label: 'Compilar, descartando o que não compila', status: 'pendente' },
      { id: 'validar', label: 'Validar contra o contrato como ele é', status: 'pendente' },
      { id: 'relatorio', label: 'Relatório', status: 'pendente' },
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
    const info = await inspectContract(p.path);
    p.info = info;
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
    if (editado.length) log(p, 'O Cargo.toml original volta na limpeza.');
    guard();

    // ── 2. Suíte existente, como baseline ───────────────────────────────────
    //
    // Antes de escrever qualquer coisa no crate. O arquivo gerado vai para
    // tests/, então medir a suíte depois mediria o estrago da própria
    // ferramenta — e foi o que aconteceu na primeira versão: o harness não
    // compilava e a suíte do usuário aparecia vermelha por causa dele.
    setStage(p, 'suite', { status: 'rodando', startedAt: Date.now() });
    const baseline = await exec(p, info.path, 'cargo', ['test', '-p', info.crateName],
      { PROPTEST_CASES: '32' });
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
    setStage(p, 'propor', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${p.invariants.length} propostas · ${proposta.model}` +
        (perdidos ? ` · ${perdidos} descartada(s) por JSON inválido` : ''),
      data: { invariants: p.invariants, raw: proposta.text, perdidos },
    });
    guard();

    // ── 3. Um teste por invariante ──────────────────────────────────────────
    //
    // Não um arquivo com tudo. Pedir 1200 linhas de Rust numa tacada é
    // tudo-ou-nada: um erro em qualquer propriedade derruba o arquivo inteiro,
    // e foi o que aconteceu com todos os modelos medidos — 43 a 59 erros por
    // tentativa, em modelos que escrevem Rust correto quando o escopo é curto.
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

    await Promise.all(Array.from({ length: Math.min(CONC, p.invariants.length) }, async () => {
      for (;;) {
        const i = proximo++;
        if (i >= p.invariants.length) return;
        guard();
        const inv = p.invariants[i];
        const r = await complete({
          system: systemPrompt(),
          user: generateOneTest(info, src, inv),
          model: p.model,
          maxTokens: 3000,
        }).catch((e) => { log(p, `${inv.id}: !! ${e.message}`); return null; });
        if (!r) continue;
        p.usage.entrada += r.usage?.entrada ?? 0;
        p.usage.saida += r.usage?.saida ?? 0;
        gerados[i] = extractCode(r.text, 'rust').trim();
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

    // Cada teste no seu próprio módulo. É o que permite que ele traga os
    // próprios `use`: num arquivo único, dois testes que importam `Address`
    // colidem, e o cabeçalho fixo que existia antes só servia para os testes
    // que por acaso precisavam exatamente daqueles imports — os outros não
    // compilavam por falta de símbolo, não por erro de lógica.
    const escrever = async (items: { inv: Invariant; code: string }[]) => {
      const corpo = items
        .map((t) => `mod ${t.inv.id.toLowerCase().replace(/[^a-z0-9_]/g, '')} {\n${t.code}\n}`)
        .join('\n\n');
      await writeFile(p.harnessPath!, harnessHeader(info) + '\n' + corpo + '\n', 'utf8');
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
          t.code = novo;
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
      relatorio(p, { compilou: false, baselineOk });
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
      { PROPTEST_CASES: '64' });
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
            ['test', '-p', info.crateName, '--test', 'audit_generated'], { PROPTEST_CASES: '64' });
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
        inv.verdict = 'descartada';
        inv.verdictReason =
          `A propriedade falha contra o contrato como ele é (teste ${t}), e continuou ` +
          `falhando depois de uma rodada de correção. Ou a invariante não vale, ou o ` +
          `harness a implementou errado — nos dois casos reportá-la seria acusar bug ` +
          `onde não há evidência.`;
        descartadas++;
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
    const sobreviventes = testes.filter((t) => t.inv.verdict !== 'descartada');
    if (sobreviventes.length !== testes.length) {
      await escrever(sobreviventes);
      p.harnessCode = await readFile(p.harnessPath, 'utf8');
      const rebuild = await exec(p, info.path, 'cargo',
        ['test', '-p', info.crateName, '--test', 'audit_generated'], { PROPTEST_CASES: '64' });
      log(p, rebuild.code === 0
        ? `harness final: ${sobreviventes.length} testes, verde contra o contrato como ele é`
        : '!! o harness final ainda falha — não use estes números como detecção');
    }

    setStage(p, 'validar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: descartadas === 0 && orfas.length === 0
        ? `todas as ${p.invariants.length} sobrevivem ao contrato correto`
        : `${descartadas} descartada(s)` + (orfas.length ? `, ${orfas.length} falha(s) órfã(s)` : ''),
      data: { falhos, descartadas, orfas },
    });

    if (runMutants && !p.cancelled) {
      log(p, '--- cargo mutants ---');
      await exec(p, info.path, 'cargo',
        ['mutants', '-p', info.crateName, '--timeout', '120', '--', '--test', 'audit_generated'],
        { PROPTEST_CASES: '32' });
    }
    relatorio(p, { compilou: true, baselineOk, descartadas, orfas });
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

function relatorio(p: Pipeline, extra: Record<string, unknown>) {
  const mantidas = p.invariants.filter((i) => i.verdict === 'mantida');
  const descartadas = p.invariants.filter((i) => i.verdict === 'descartada');

  setStage(p, 'relatorio', {
    status: 'ok',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    detail: `${mantidas.length} mantidas, ${descartadas.length} descartadas`,
    data: {
      ...extra,
      propostas: p.invariants.length,
      mantidas: mantidas.length,
      descartadas: descartadas.length,
      yield: p.invariants.length
        ? Math.round((mantidas.length / p.invariants.length) * 100)
        : 0,
      invariants: p.invariants,
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

/** Remove o harness gerado e desfaz o que a ferramenta escreveu no crate. */
export async function cleanupHarness(p: Pipeline) {
  if (p.harnessPath) await rm(p.harnessPath, { force: true });
  if (p.manifestoOriginal) {
    await writeFile(p.manifestoOriginal.caminho, p.manifestoOriginal.conteudo, 'utf8');
    p.manifestoOriginal = undefined;
  }
}

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Response } from 'express';

import { inspectContract, cleanView, type ContractInfo } from './inspect.js';
import { complete, extractCode, isConfigured } from './openrouter.js';
import { systemPrompt, proposeInvariants, generateHarness, type CuratedInvariant } from './prompts.js';

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
}

export interface Pipeline {
  id: string;
  path: string;
  hiddenFeatures: string[];
  status: 'rodando' | 'concluido' | 'falhou' | 'cancelado';
  stages: Stage[];
  log: string[];
  info?: ContractInfo;
  invariants: Invariant[];
  harnessCode?: string;
  harnessPath?: string;
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

/** Casa um nome de teste com o ID da invariante que ele cita. */
function invariantForTest(test: string, invs: Invariant[]): Invariant | undefined {
  const lower = test.toLowerCase();
  return invs.find((i) => lower.includes(i.id.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

export function startPipeline(opts: {
  path: string;
  hiddenFeatures: string[];
  runMutants: boolean;
}): Pipeline {
  const p: Pipeline = {
    id: randomUUID(),
    path: opts.path,
    hiddenFeatures: opts.hiddenFeatures,
    status: 'rodando',
    stages: [
      { id: 'inspecionar', label: 'Inspecionar o contrato', status: 'pendente' },
      { id: 'propor', label: 'IA propõe invariantes', status: 'pendente' },
      { id: 'gerar', label: 'IA gera o harness', status: 'pendente' },
      { id: 'compilar', label: 'Compilar', status: 'pendente' },
      { id: 'validar', label: 'Validar contra o contrato como ele é', status: 'pendente' },
      { id: 'suite', label: 'Rodar a suíte existente', status: 'pendente' },
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
    const src = cleanView(await readFile(info.sourceFile, 'utf8'), p.hiddenFeatures);
    log(p, `fonte enviada ao modelo: ${src.split('\n').length} linhas` +
      (p.hiddenFeatures.length ? ` (features escondidas: ${p.hiddenFeatures.join(', ')})` : ''));

    const proposta = await complete({
      system: systemPrompt(),
      user: proposeInvariants(info, src),
      maxTokens: 8000,
    });
    p.rawProposal = proposta.text;

    try {
      p.invariants = JSON.parse(extractCode(proposta.text, 'json').trim());
    } catch (e) {
      setStage(p, 'propor', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: `O modelo não devolveu JSON válido: ${(e as Error).message}`,
        data: { raw: proposta.text },
      });
      p.status = 'falhou';
      emit(p, 'done', { status: p.status });
      return;
    }

    p.invariants = p.invariants.map((i) => ({ ...i, verdict: 'nao-testada' as const }));
    setStage(p, 'propor', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${p.invariants.length} propostas · ${proposta.model}`,
      data: { invariants: p.invariants, raw: proposta.text },
    });
    guard();

    // ── 3. Gerar harness ────────────────────────────────────────────────────
    setStage(p, 'gerar', { status: 'rodando', startedAt: Date.now() });
    const harness = await complete({
      system: systemPrompt(),
      user: generateHarness(info, src, p.invariants),
      maxTokens: 16000,
    });
    p.harnessCode = extractCode(harness.text, 'rust');
    const testsDir = join(info.path, 'tests');
    await mkdir(testsDir, { recursive: true });
    p.harnessPath = join(testsDir, 'audit_generated.rs');
    await writeFile(p.harnessPath, p.harnessCode, 'utf8');

    setStage(p, 'gerar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: `${p.harnessCode.split('\n').length} linhas → tests/audit_generated.rs`,
      data: { code: p.harnessCode, raw: harness.text, path: p.harnessPath },
    });
    guard();

    // ── 4. Compilar ─────────────────────────────────────────────────────────
    setStage(p, 'compilar', { status: 'rodando', startedAt: Date.now() });
    const build = await exec(p, info.path, 'cargo',
      ['test', '-p', info.crateName, '--test', 'audit_generated', '--no-run']);
    guard();

    if (build.code !== 0) {
      const erros = (build.output.match(/^error(\[E\d+\])?:/gm) ?? []).length;
      setStage(p, 'compilar', {
        status: 'falhou',
        finishedAt: Date.now(),
        detail: `${erros} erro(s) de compilação — o harness ficou em ${p.harnessPath}`,
        data: { errors: erros },
      });
      // Não é o fim do mundo nem do pipeline: seguimos para a suíte existente,
      // que é a única parte cujo resultado ainda significa alguma coisa.
      setStage(p, 'validar', { status: 'pulado', detail: 'o harness não compila' });
      await suiteStage(p, info, runMutants);
      relatorio(p, { compilou: false });
      return;
    }
    setStage(p, 'compilar', { status: 'ok', finishedAt: Date.now(), detail: 'harness compila' });

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

    const falhos = failedTests(val.output);
    let descartadas = 0;
    for (const t of falhos) {
      const inv = invariantForTest(t, p.invariants);
      if (inv) {
        inv.verdict = 'descartada';
        inv.verdictReason =
          `A propriedade falha contra o contrato como ele é (teste ${t}). ` +
          `Ou a invariante não vale, ou o harness a implementou errado — nos dois casos ` +
          `reportá-la seria acusar bug onde não há evidência.`;
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

    setStage(p, 'validar', {
      status: 'ok',
      finishedAt: Date.now(),
      detail: descartadas === 0 && orfas.length === 0
        ? `todas as ${p.invariants.length} sobrevivem ao contrato correto`
        : `${descartadas} descartada(s)` + (orfas.length ? `, ${orfas.length} falha(s) órfã(s)` : ''),
      data: { falhos, descartadas, orfas },
    });

    await suiteStage(p, info, runMutants);
    relatorio(p, { compilou: true, descartadas, orfas });
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

async function suiteStage(p: Pipeline, info: ContractInfo, runMutants: boolean) {
  setStage(p, 'suite', { status: 'rodando', startedAt: Date.now() });
  const r = await exec(p, info.path, 'cargo', ['test', '-p', info.crateName],
    { PROPTEST_CASES: '64' });
  const passou = r.code === 0;
  setStage(p, 'suite', {
    status: passou ? 'ok' : 'falhou',
    finishedAt: Date.now(),
    detail: passou ? 'suíte existente verde' : 'a suíte existente já falha — nada depois é atribuível',
    data: { failed: failedTests(r.output) },
  });

  if (runMutants && !p.cancelled) {
    log(p, '--- cargo mutants ---');
    await exec(p, info.path, 'cargo',
      ['mutants', '-p', info.crateName, '--timeout', '120', '--', '--test', 'audit_generated'],
      { PROPTEST_CASES: '32' });
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

/** Remove o harness gerado, para deixar o crate como estava. */
export async function cleanupHarness(p: Pipeline) {
  if (p.harnessPath) await rm(p.harnessPath, { force: true });
}

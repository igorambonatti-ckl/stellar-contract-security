import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectContract, cleanView } from './inspect.js';
import { complete, extractCode, isConfigured, currentModel } from './openrouter.js';
import { systemPrompt, proposeInvariants, generateHarness, prioritiseInputs } from './prompts.js';
import { startRun, getRun, listRuns, attach } from './runner.js';
import {
  startPipeline, getPipeline, listPipelines, attachPipeline, cleanupHarness,
} from './pipeline.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

const PORT = Number(process.env.PORT ?? 5174);

/** Everything the UI needs to know before it lets you start. */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ai: { configured: isConfigured(), model: isConfigured() ? currentModel() : null },
  });
});

app.post('/api/inspect', async (req, res, next) => {
  try {
    const { path } = req.body ?? {};
    if (typeof path !== 'string' || !path.trim()) {
      return res.status(400).json({ error: 'Informe o caminho do crate.' });
    }
    res.json(await inspectContract(path.trim()));
  } catch (e) {
    next(e);
  }
});

/** The source as a model will see it, so the UI can show it before sending. */
app.post('/api/clean-view', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [] } = req.body ?? {};
    const info = await inspectContract(path);
    const src = await readFile(info.sourceFile, 'utf8');
    const view = cleanView(src, hiddenFeatures);
    res.json({
      source: view,
      originalLines: src.split('\n').length,
      viewLines: view.split('\n').length,
      hiddenFeatures,
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/ai/invariants', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [], model } = req.body ?? {};
    const info = await inspectContract(path);
    const src = cleanView(await readFile(info.sourceFile, 'utf8'), hiddenFeatures);

    const out = await complete({
      system: systemPrompt(),
      user: proposeInvariants(info, src),
      model,
      maxTokens: 8000,
    });

    // The prompt asks for bare JSON; models fence it anyway.
    let invariants: unknown = null;
    let parseError: string | null = null;
    try {
      invariants = JSON.parse(extractCode(out.text, 'json').trim());
    } catch (err) {
      parseError = (err as Error).message;
    }

    res.json({ invariants, raw: out.text, model: out.model, parseError });
  } catch (e) {
    next(e);
  }
});

app.post('/api/ai/inputs', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [], model } = req.body ?? {};
    const info = await inspectContract(path);
    const src = cleanView(await readFile(info.sourceFile, 'utf8'), hiddenFeatures);

    const out = await complete({
      system: systemPrompt(),
      user: prioritiseInputs(info, src),
      model,
      maxTokens: 6000,
    });

    let prior: unknown = null;
    let parseError: string | null = null;
    try {
      prior = JSON.parse(extractCode(out.text, 'json').trim());
    } catch (err) {
      parseError = (err as Error).message;
    }

    res.json({ prior, raw: out.text, model: out.model, parseError });
  } catch (e) {
    next(e);
  }
});

/**
 * Generate the harness from the *curated* invariants and write it into the
 * crate's tests/ directory.
 *
 * The curated list is what the human accepted — not the model's full proposal.
 * That handoff is the point of the whole pipeline, so the endpoint refuses an
 * empty list rather than generating a harness that asserts nothing.
 */
app.post('/api/ai/harness', async (req, res, next) => {
  try {
    const { path, invariants, hiddenFeatures = [], model, write = true } = req.body ?? {};
    if (!Array.isArray(invariants) || invariants.length === 0) {
      return res.status(400).json({
        error:
          'Nenhuma invariante curada. Aceite ao menos uma antes de gerar o harness — ' +
          'um harness sem invariante não asseria nada.',
      });
    }

    const info = await inspectContract(path);
    const src = cleanView(await readFile(info.sourceFile, 'utf8'), hiddenFeatures);

    const out = await complete({
      system: systemPrompt(),
      user: generateHarness(info, src, invariants),
      model,
      maxTokens: 16000,
    });

    const code = extractCode(out.text, 'rust');
    let written: string | null = null;
    if (write) {
      const dir = join(info.path, 'tests');
      await mkdir(dir, { recursive: true });
      written = join(dir, 'audit_generated.rs');
      await writeFile(written, code, 'utf8');
    }

    res.json({ code, raw: out.text, model: out.model, written });
  } catch (e) {
    next(e);
  }
});

// ── Execução ────────────────────────────────────────────────────────────────

app.post('/api/run/test', async (req, res, next) => {
  try {
    const { path, testTarget, cases } = req.body ?? {};
    const info = await inspectContract(path);
    const args = ['test', '-p', info.crateName];
    if (testTarget) args.push('--test', String(testTarget));
    const run = startRun({
      label: testTarget ? `cargo test --test ${testTarget}` : 'cargo test',
      cwd: info.path,
      command: 'cargo',
      args,
      env: cases ? { PROPTEST_CASES: String(cases) } : undefined,
    });
    res.json({ id: run.id });
  } catch (e) {
    next(e);
  }
});

app.post('/api/run/build-wasm', async (req, res, next) => {
  try {
    const info = await inspectContract(req.body?.path);
    const run = startRun({
      label: 'build wasm',
      cwd: info.path,
      command: 'cargo',
      // `cargo rustc --crate-type cdylib` rather than `cargo build`: carrying
      // "cdylib" in [lib] crate-type permanently breaks the cargo-fuzz build,
      // so the artifact is produced on demand instead.
      args: [
        'rustc', '-p', info.crateName,
        '--target', 'wasm32v1-none', '--release', '--crate-type', 'cdylib',
      ],
    });
    res.json({ id: run.id });
  } catch (e) {
    next(e);
  }
});

app.post('/api/run/mutants', async (req, res, next) => {
  try {
    const { path, testTarget } = req.body ?? {};
    const info = await inspectContract(path);
    const args = ['mutants', '-p', info.crateName, '--timeout', '120'];
    if (testTarget) args.push('--', '--test', String(testTarget));
    const run = startRun({
      label: 'cargo mutants',
      cwd: info.path,
      command: 'cargo',
      args,
      env: { PROPTEST_CASES: '64' },
    });
    res.json({ id: run.id });
  } catch (e) {
    next(e);
  }
});

app.get('/api/runs', (_req, res) => res.json(listRuns()));

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Execução não encontrada.' });
  const { listeners: _l, kill: _k, ...rest } = run;
  res.json(rest);
});

app.get('/api/runs/:id/stream', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Execução não encontrada.' });
  attach(run, res);
});

app.post('/api/runs/:id/cancel', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Execução não encontrada.' });
  run.kill();
  res.json({ ok: true });
});

// ── Pipeline ────────────────────────────────────────────────────────────────
//
// O fluxo automático: inspeciona, propõe, gera, compila, valida contra o
// contrato como ele é, roda a suíte, reporta. A validação é a curadoria feita
// por execução em vez de por um humano clicando — uma invariante que falha
// contra o contrato correto é falso positivo e sai sozinha.

app.post('/api/pipeline', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [], runMutants = false } = req.body ?? {};
    if (typeof path !== 'string' || !path.trim()) {
      return res.status(400).json({ error: 'Informe o caminho do crate.' });
    }
    // Falha cedo se o caminho não presta, em vez de dentro do pipeline.
    await inspectContract(path.trim());
    const p = startPipeline({ path: path.trim(), hiddenFeatures, runMutants });
    res.json({ id: p.id });
  } catch (e) {
    next(e);
  }
});

app.get('/api/pipeline', (_req, res) => res.json(listPipelines()));

app.get('/api/pipeline/:id', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline não encontrado.' });
  const { listeners: _l, cancel: _c, ...rest } = p;
  res.json(rest);
});

app.get('/api/pipeline/:id/stream', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline não encontrado.' });
  attachPipeline(p, res);
});

app.post('/api/pipeline/:id/cancel', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline não encontrado.' });
  p.cancel();
  res.json({ ok: true });
});

/** Apaga o harness gerado, deixando o crate como estava. */
app.post('/api/pipeline/:id/cleanup', async (req, res, next) => {
  try {
    const p = getPipeline(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pipeline não encontrado.' });
    await cleanupHarness(p);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ── Erros ───────────────────────────────────────────────────────────────────

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err?.message ?? 'Erro interno.' });
});

app.listen(PORT, () => {
  console.log(`API de auditoria em http://localhost:${PORT}`);
  console.log(
    isConfigured()
      ? `IA: ${currentModel()} via OpenRouter`
      : 'IA: desligada — defina OPENROUTER_API_KEY em api/.env',
  );
});

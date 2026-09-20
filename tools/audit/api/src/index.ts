import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectContract, cleanView, contractSource } from './inspect.js';
import { complete, extractCode, isConfigured, currentModel } from './openrouter.js';
import {
  startPipeline, getPipeline, listPipelines, attachPipeline, cleanupHarness,
} from './pipeline.js';
import { pickContract, resolveCrateRoot } from './picker.js';

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

// ── Seletor de pasta ────────────────────────────────────────────────────────

/**
 * Abre o diálogo nativo do sistema e devolve a **raiz do crate**.
 *
 * O usuário escolhe o arquivo do contrato, que é como ele pensa nele; a API
 * sobe a árvore até o Cargo.toml, que é do que o cargo precisa. Cancelar
 * devolve `path: null` e não é erro.
 */
app.post('/api/pick-contract', async (req, res, next) => {
  try {
    res.json({ path: await pickContract(req.body?.startIn) });
  } catch (e) {
    next(e);
  }
});

app.post('/api/inspect', async (req, res, next) => {
  try {
    const { path } = req.body ?? {};
    if (typeof path !== 'string' || !path.trim()) {
      return res.status(400).json({ error: 'Informe o caminho do crate.' });
    }
    res.json(await inspectContract(await resolveCrateRoot(path.trim())));
  } catch (e) {
    next(e);
  }
});

/** The source as a model will see it, so the UI can show it before sending. */
app.post('/api/clean-view', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [] } = req.body ?? {};
    const info = await inspectContract(path);
    const src = await contractSource(info);
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

// ── Pipeline ────────────────────────────────────────────────────────────────
//
// O fluxo automático: inspeciona, propõe, gera, compila, valida contra o
// contrato como ele é, roda a suíte, reporta. A validação é a curadoria feita
// por execução em vez de por um humano clicando — uma invariante que falha
// contra o contrato correto é falso positivo e sai sozinha.

app.post('/api/pipeline', async (req, res, next) => {
  try {
    const { path, hiddenFeatures = [], runMutants = false, model } = req.body ?? {};
    if (typeof path !== 'string' || !path.trim()) {
      return res.status(400).json({ error: 'Informe o caminho do crate.' });
    }
    // Aceita arquivo ou pasta: sobe até a raiz do crate antes de qualquer coisa.
    const raiz = await resolveCrateRoot(path.trim());
    // Falha cedo se não for um contrato, em vez de dentro do pipeline.
    await inspectContract(raiz);
    const p = startPipeline({ path: raiz, hiddenFeatures, runMutants, model });
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

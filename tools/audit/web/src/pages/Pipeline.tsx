import { useEffect, useRef, useState } from 'react';
import {
  Play, Square, Loader2, CheckCircle2, XCircle, MinusCircle, Circle,
  ChevronDown, ChevronRight, Trash2, FileCode2, Clock, UserCheck,
  FilePlus2, FileDiff, ShieldCheck, AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import { Erro } from '../components/Erro';

type StageStatus = 'pendente' | 'rodando' | 'ok' | 'falhou' | 'pulado' | 'aguardando';

interface Stage {
  id: string; label: string; status: StageStatus; detail?: string;
  startedAt?: number; finishedAt?: number; data?: any;
}

interface ArquivoDiff {
  caminho: string; tipo: 'novo' | 'alterado'; antes?: string; depois: string;
}

/**
 * Diff por linha, o suficiente para ler o que a auditoria escreveu.
 *
 * Um algoritmo de verdade (Myers) seria melhor para arquivos grandes, mas os
 * dois casos aqui são um `Cargo.toml` com duas linhas a mais e um harness que é
 * arquivo novo inteiro — a versão simples mostra os dois corretamente.
 */
function linhasDoDiff(antes: string | undefined, depois: string) {
  const a = (antes ?? '').split('\n');
  const b = depois.split('\n');
  if (antes === undefined) return b.map((t) => ({ sinal: '+' as const, texto: t }));

  const antigas = new Set(a);
  const novas = new Set(b);
  const out: { sinal: '+' | '-' | ' '; texto: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ sinal: ' ', texto: a[i] }); i++; j++; }
    else if (j < b.length && !antigas.has(b[j])) { out.push({ sinal: '+', texto: b[j] }); j++; }
    else if (i < a.length && !novas.has(a[i])) { out.push({ sinal: '-', texto: a[i] }); i++; }
    else { i++; j++; }
  }
  return out;
}

interface Invariant {
  id: string; statement: string; class: string; observation: string;
  confidence?: string; assumption?: string;
  verdict?: 'mantida' | 'achado' | 'descartada' | 'nao-testada'; verdictReason?: string;
  /** A sequência mínima que quebra a propriedade, encolhida pelo proptest. */
  contraExemplo?: string;
}

const ICON: Record<StageStatus, React.ReactNode> = {
  pendente: <Circle className="w-4 h-4 opacity-30" />,
  rodando: <Loader2 className="w-4 h-4 animate-spin text-brand-500" />,
  ok: <CheckCircle2 className="w-4 h-4 text-success" />,
  falhou: <XCircle className="w-4 h-4 text-danger" />,
  pulado: <MinusCircle className="w-4 h-4 text-ink-muted" />,
  aguardando: <UserCheck className="w-4 h-4 text-brand-500" />,
};

function dur(s: Stage) {
  if (!s.startedAt || !s.finishedAt) return null;
  const ms = s.finishedAt - s.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Preço por milhão de tokens [entrada, saída], do catálogo do OpenRouter.
 *
 * Fica no cliente porque serve para uma frase só — "esta auditoria custou X" —
 * e porque essa frase é metade do argumento: uma auditoria de três centavos
 * roda a cada pull request; uma de dois dólares roda quando alguém lembra.
 * Um preço desatualizado aqui erra o rodapé de um relatório, não uma decisão.
 */
const PRECOS: Record<string, [number, number]> = {
  'google/gemini-3.8-flash':      [0.75, 3.75],
  'google/gemini-3.1-flash-lite': [0.25, 1.50],
  'qwen/qwen3-coder-next':        [0.12, 0.80],
  'openai/gpt-5.4-nano':          [0.20, 1.25],
  'x-ai/grok-4.3':                [1.25, 2.50],
  'anthropic/claude-sonnet-4.5':  [3.00, 15.00],
};

/** Caminhos já auditados, para não ter que escolher de novo. */
const RECENTES = 'auditoria:recentes';
/** A execução em curso, para sobreviver a um reload. */
const ATUAL = 'auditoria:atual';

function lerRecentes(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTES) ?? '[]'); } catch { return []; }
}

function guardarRecente(p: string) {
  const lista = [p, ...lerRecentes().filter((x) => x !== p)].slice(0, 6);
  localStorage.setItem(RECENTES, JSON.stringify(lista));
  return lista;
}

export function Pipeline() {
  const [path, setPath] = useState('');
  const [recentes, setRecentes] = useState<string[]>(lerRecentes);
  const [escolhendo, setEscolhendo] = useState(false);
  // Features do crate, lidas assim que um contrato é apontado, para dar chance
  // de esconder do modelo as que carregam caminhos conhecidos.
  const [features, setFeatures] = useState<string[]>([]);
  const [escondidas, setEscondidas] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] =
    useState<'idle'|'rodando'|'concluido'|'falhou'|'cancelado'>('idle');
  // Só o automático. A curadoria existe, mas é feita por uma segunda passada
  // de IA dentro do pipeline — não há um passo em que uma pessoa clica.
  const modo = 'automatico' as const;
  // Poucos modelos, escolhidos por medição neste projeto e não por catálogo.
  // O grok-4.3 é o default: não raciocina antes de responder, então escreve
  // uma asserção em ~4 s contra 3 a 5 min do gemini-3.8-flash, e a auditoria
  // inteira fecha em ~2 min por ~US$ 0,25 (medido). O flash-lite fica por um
  // décimo do preço; o 3.8-flash por o dobro e cinco vezes o tempo.
  const [modelo, setModelo] = useState('x-ai/grok-4.3');
  const [vazamento, setVazamento] = useState<{ invariantes: string[]; features: string[] } | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [logAberto, setLogAberto] = useState(false);
  const fimLog = useRef<HTMLDivElement>(null);
  const es = useRef<EventSource | null>(null);

  useEffect(() => () => es.current?.close(), []);

  // Retoma uma execução que sobreviveu a um reload. Primeiro pelo id guardado;
  // sem ele, pergunta à API se há alguma rodando — cobre a execução iniciada
  // antes de o id passar a ser guardado, e qualquer outra aba.
  useEffect(() => {
    (async () => {
      let pid: string | null = null;
      try { pid = localStorage.getItem(ATUAL); } catch { /* sem storage */ }

      let p: any = null;
      if (pid) {
        const r = await fetch(`/api/pipeline/${pid}`).catch(() => null);
        if (r?.ok) p = await r.json();
      }
      if (!p || p.status !== 'rodando') {
        const r = await fetch('/api/pipeline').catch(() => null);
        const lista: any[] = r?.ok ? await r.json() : [];
        p = lista.find((x) => x.status === 'rodando') ?? null;
      }
      if (!p) { try { localStorage.removeItem(ATUAL); } catch { /* */ } return; }

      setPath(p.path ?? ''); setStatus('rodando');
      if (p.model) setModelo(p.model);
      conectar(p.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (logAberto) fimLog.current?.scrollIntoView({ block: 'end' }); }, [log, logAberto]);

  async function escolherContrato() {
    setEscolhendo(true); setErro(null);
    try {
      const res = await fetch('/api/pick-contract', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startIn: path.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      // Cancelar devolve null e não é erro.
      if (json.path) { setPath(json.path); void lerFeatures(json.path); }
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEscolhendo(false);
    }
  }

  /** Inspeção barata só para descobrir as features antes de rodar. */
  async function lerFeatures(alvo: string) {
    setFeatures([]); setEscondidas([]);
    try {
      const res = await fetch('/api/inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: alvo }),
      });
      if (!res.ok) return;
      const info = await res.json();
      // Tudo escondido por padrão. Um caminho atrás de `#[cfg(feature)]` é
      // quase sempre o que não se quer que o modelo veja — bug plantado, ramo
      // de debug — e o passo manual de marcar era o que mais falhava na demo:
      // três execuções seguidas com o gabarito vazado, todas por esquecimento.
      setFeatures(info.features ?? []);
      setEscondidas(info.features ?? []);
    } catch { /* silencioso: é conveniência, o pipeline inspeciona de novo */ }
  }

  /**
   * `ocultar` existe por causa do botão "esconder e rodar de novo": chamar
   * `setEscondidas` e `iniciar()` em seguida mandaria o valor antigo do estado,
   * e o botão prometeria esconder as features enquanto reenviava exatamente a
   * mesma requisição.
   */
  async function iniciar(alvo = path, ocultar = escondidas) {
    setErro(null); setStages([]); setLog([]); setStatus('rodando'); setAberto({});
    setVazamento(null);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: alvo.trim(), hiddenFeatures: ocultar, modo, model: modelo }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setRecentes(guardarRecente(alvo.trim()));
      conectar(json.id);
    } catch (e) {
      setErro((e as Error).message); setStatus('idle');
    }
  }

  /**
   * Liga a tela a uma execução, nova ou já em curso.
   *
   * O id fica no localStorage porque F5 apagava o estado do React: a execução
   * seguia na API, mas a tela não sabia dela e o botão Parar não tinha o que
   * parar. A API reenvia o snapshot ao conectar, então reconectar reconstrói
   * etapas e log de onde estavam.
   */
  function conectar(pid: string) {
      setId(pid);
      try { localStorage.setItem(ATUAL, pid); } catch { /* sem storage */ }
      es.current?.close();

      const src = new EventSource(`/api/pipeline/${pid}/stream`);
      es.current = src;
      src.addEventListener('snapshot', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setStages(d.stages); setLog(d.log);
      });
      src.addEventListener('stage', (e) => {
        const s: Stage = JSON.parse((e as MessageEvent).data);
        setStages((prev) => prev.map((x) => (x.id === s.id ? s : x)));
        // No modo automático não há painel de curadoria, e era lá que o aviso
        // de gabarito vazado vivia — o detector disparava e ninguém via.
        if (s.id === 'propor' && s.data?.vazamento) setVazamento(s.data.vazamento);
      });
      src.addEventListener('log', (e) => {
        setLog((l) => [...l, JSON.parse((e as MessageEvent).data)]);
      });
      src.addEventListener('done', (e) => {
        setStatus(JSON.parse((e as MessageEvent).data).status);
        try { localStorage.removeItem(ATUAL); } catch { /* sem storage */ }
        src.close();
      });
      src.onerror = () => src.close();
  }

  const relatorio = stages.find((s) => s.id === 'relatorio' && s.status === 'ok')?.data;
  const invariantes: Invariant[] = relatorio?.invariants
    ?? stages.find((s) => s.id === 'propor')?.data?.invariants
    ?? [];

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <span className="section-label">Auditoria de contrato Soroban</span>
        <h1 className="text-3xl font-bold text-ink">Fuzzing guiado por IA</h1>
        <p className="text-ink-muted max-w-[72ch] leading-relaxed">
          A IA lê o contrato e propõe as invariantes; uma segunda passada de IA separa as que
          valem das que só parecem valer. O resto é fuzzing: um rig com sequências sorteadas,
          uma asserção por invariante, e cada propriedade testada{' '}
          <strong className="text-ink">contra o contrato como ele é</strong>. O que falha vem com
          o contra-exemplo mínimo; o que passa vira suíte de regressão.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <button className="btn-outline shrink-0" onClick={escolherContrato}
            disabled={escolhendo || status === 'rodando'}>
            {escolhendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCode2 className="w-4 h-4" />}
            Escolher contrato
          </button>

          <input className="input font-mono text-sm" value={path} spellCheck={false}
            placeholder="ou cole o caminho do contrato ou do crate"
            onChange={(e) => setPath(e.target.value)}
            onBlur={(e) => e.target.value.trim() && lerFeatures(e.target.value.trim())}
            onKeyDown={(e) => e.key === 'Enter' && path.trim() && status !== 'rodando' && iniciar()} />

          {status === 'rodando' ? (
            <button className="btn-outline shrink-0"
              onClick={() => id && fetch(`/api/pipeline/${id}/cancel`, { method: 'POST' })}>
              <Square className="w-4 h-4" /> Parar
            </button>
          ) : (
            <button className="btn-primary shrink-0" onClick={() => iniciar()} disabled={!path.trim()}>
              <Play className="w-4 h-4" /> Auditar
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-ink-muted">Modelo:</span>
          <select className="text-sm border border-line rounded-md px-2 py-1 bg-surface text-ink"
            value={modelo} onChange={(e) => setModelo(e.target.value)}
            disabled={status === 'rodando'}>
            <option value="x-ai/grok-4.3">grok-4.3 · ~US$ 0,25 · ~2 min</option>
            <option value="google/gemini-3.1-flash-lite">gemini-3.1-flash-lite · ~US$ 0,03 · ~3 min</option>
            <option value="google/gemini-3.8-flash">gemini-3.8-flash · ~US$ 0,50 · ~10 min</option>
            <option value="qwen/qwen3-coder-next">qwen3-coder-next · ~US$ 0,08</option>
            <option value="openai/gpt-5.4-nano">gpt-5.4-nano · ~US$ 0,07</option>
            <option value="anthropic/claude-sonnet-4.5">claude-sonnet-4.5 · ~US$ 1,70</option>
          </select>

        </div>

        {recentes.length > 0 && status !== 'rodando' && (
          <div className="flex items-center gap-2 flex-wrap">
            <Clock className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            {recentes.map((r) => (
              <button key={r} onClick={() => { setPath(r); void lerFeatures(r); iniciar(r); }}
                title={r}
                className="font-mono text-xs px-2.5 py-1 rounded-md bg-surface-secondary border border-line
                           text-ink-muted hover:text-brand-600 hover:border-brand-200 hover:bg-brand-50
                           transition-colors max-w-[260px] truncate">
                {r.split('/').slice(-2).join('/')}
              </button>
            ))}
          </div>
        )}

      </div>

      <Erro msg={erro} />

      {vazamento && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1.5 min-w-0">
            <strong className="text-sm text-ink">
              O modelo está lendo o gabarito, não deduzindo do contrato
            </strong>
            <p className="text-sm text-ink-muted leading-relaxed">
              {vazamento.invariantes.length} invariante(s) citam{' '}
              <code className="font-mono text-xs break-words">{vazamento.features.join(', ')}</code>{' '}
              pelo nome. Essas features foram enviadas junto com o código, e os caminhos que elas
              ativam também — o modelo está descrevendo defeitos que está <em>vendo</em>, não
              encontrando.
            </p>
            <p className="text-sm text-ink-muted leading-relaxed">
              O resultado vai parecer excelente e não mede nada.
            </p>
            <button className="btn-primary w-fit mt-1"
              onClick={async () => {
                if (id) await fetch(`/api/pipeline/${id}/cancel`, { method: 'POST' }).catch(() => {});
                setEscondidas(features);
                setVazamento(null);
                void iniciar(path, features);
              }}>
              <Play className="w-4 h-4" /> Esconder as {features.length} features e rodar de novo
            </button>
          </div>
        </div>
      )}

      {stages.length > 0 && (
        <div className="flex flex-col gap-2">
          {stages.map((s) => {
            const temDetalhe = s.data && ['inspecionar','propor','gerar','validar','relatorio'].includes(s.id);
            const open = aberto[s.id];
            return (
              <div key={s.id} className={clsx('card overflow-hidden',
                s.status === 'rodando' && 'border-brand-300',
                s.status === 'falhou' && 'border-red-200')}>
                <button
                  onClick={() => temDetalhe && setAberto((a) => ({ ...a, [s.id]: !a[s.id] }))}
                  className={clsx('w-full flex items-center gap-3 px-4 py-3 text-left',
                    temDetalhe && 'hover:bg-surface-secondary cursor-pointer')}>
                  {temDetalhe
                    ? (open ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
                            : <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />)
                    : <span className="w-3.5" />}
                  {ICON[s.status]}
                  <span className={clsx('text-sm font-medium flex-1',
                    s.status === 'pendente' ? 'text-ink-muted' : 'text-ink')}>{s.label}</span>
                  {s.detail && <span className="text-xs text-ink-muted text-right">{s.detail}</span>}
                  {dur(s) && <span className="font-mono text-[11px] text-ink-muted tabular-nums w-14 text-right">{dur(s)}</span>}
                </button>

                {open && s.id === 'relatorio' && (
                  <div className="px-4 pb-4 pt-3 border-t border-line flex flex-col gap-4">
                    <div className="grid sm:grid-cols-4 gap-3">
                      {[['Propostas', s.data.propostas], ['A investigar', s.data.achados ?? 0],
                        ['Verificadas', s.data.mantidas], ['Descartadas', s.data.descartadas]].map(([k, v]) => (
                        <div key={k as string}>
                          <div className="section-label mb-1">{k as string}</div>
                          <div className={clsx('font-mono text-2xl font-bold tabular-nums',
                            k === 'A investigar' && (v as number) > 0 ? 'text-danger' : 'text-ink')}>
                            {v as any}
                          </div>
                        </div>
                      ))}
                    </div>
                    {s.data.usage && (
                      <p className="text-xs text-ink-muted font-mono">
                        {s.data.modelo} · {(s.data.usage.entrada / 1000).toFixed(0)}k tokens de
                        entrada, {(s.data.usage.saida / 1000).toFixed(0)}k de saída
                        {PRECOS[s.data.modelo] && (
                          <strong className="text-ink not-italic">
                            {' '}· US$ {(s.data.usage.entrada / 1e6 * PRECOS[s.data.modelo][0]
                              + s.data.usage.saida / 1e6 * PRECOS[s.data.modelo][1]).toFixed(3)}
                          </strong>
                        )}
                      </p>
                    )}
                  </div>
                )}

                {open && s.id === 'inspecionar' && (
                  <div className="px-4 pb-4 pt-3 border-t border-line flex flex-wrap gap-2">
                    {s.data.entryPoints.map((e: any) => (
                      <span key={e.name} className="font-mono text-xs px-2 py-1 rounded bg-surface-secondary border border-line text-ink-muted">
                        {e.name}{e.requiresAuth && <span className="text-brand-500"> · auth</span>}
                      </span>
                    ))}
                  </div>
                )}

                {open && s.id === 'gerar' && (
                  <pre className="mx-4 mb-4 p-3 rounded-lg bg-ink text-brand-100 text-[11px] font-mono overflow-auto max-h-80 leading-relaxed">
                    {s.data.code}
                  </pre>
                )}

                {open && (s.id === 'propor' || s.id === 'validar') && s.data?.raw && (
                  <pre className="mx-4 mb-4 p-3 rounded-lg bg-ink text-brand-100 text-[11px] font-mono overflow-auto max-h-80">
                    {s.data.raw}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {invariantes.length > 0 && (() => {
        // O resultado é três coisas diferentes e elas exigem coisas diferentes
        // de quem lê. Misturá-las numa lista só era o motivo de o relatório não
        // significar nada: "19 mantidas, 11 descartadas" não diz se a auditoria
        // encontrou algo.
        const achados = invariantes.filter((i) => i.verdict === 'achado');
        const verificadas = invariantes.filter((i) => i.verdict === 'mantida');
        const fora = invariantes.filter((i) => i.verdict === 'descartada');

        const Grupo = ({ titulo, explicacao, itens, tom }: {
          titulo: string; explicacao: string; itens: Invariant[];
          tom: 'achado' | 'ok' | 'fora';
        }) => itens.length === 0 ? null : (
          <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-bold text-ink flex items-center gap-2">
                {tom === 'achado' && <AlertTriangle className="w-5 h-5 text-danger" />}
                {tom === 'ok' && <ShieldCheck className="w-5 h-5 text-success" />}
                {tom === 'fora' && <MinusCircle className="w-5 h-5 text-ink-muted" />}
                {titulo}
                <span className="font-mono text-base text-ink-muted tabular-nums">{itens.length}</span>
              </h2>
              <p className="text-sm text-ink-muted max-w-[70ch] leading-relaxed">{explicacao}</p>
            </div>
            <div className="flex flex-col gap-2">
              {itens.map((inv) => (
                <div key={inv.id} className={clsx('card p-4 flex flex-col gap-2 overflow-hidden',
                  tom === 'achado' && 'border-danger/40 bg-danger/5',
                  tom === 'fora' && 'opacity-70')}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-ink">{inv.id}</span>
                    <span className="chip">{inv.class}</span>
                  </div>
                  <p className="text-sm text-ink leading-relaxed break-words">{inv.statement}</p>
                  {inv.verdictReason && (
                    <p className={clsx('text-xs leading-relaxed border-l-2 pl-3',
                      tom === 'achado' ? 'text-ink border-danger/40' : 'text-ink-muted border-line')}>
                      {inv.verdictReason}
                    </p>
                  )}
                  {inv.contraExemplo && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-danger font-medium select-none">
                        Contra-exemplo mínimo
                      </summary>
                      <pre className="mt-2 p-3 bg-ink text-brand-100 rounded-lg overflow-auto max-h-64 text-[11px] leading-relaxed whitespace-pre-wrap">
                        {inv.contraExemplo}
                      </pre>
                    </details>
                  )}
                  {tom === 'ok' && inv.assumption && (
                    <p className="text-xs text-ink-muted leading-relaxed border-l-2 border-line pl-3">
                      <span className="font-semibold">Suposição não verificada:</span> {inv.assumption}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        );

        return (
          <div className="flex flex-col gap-8">
            <Grupo tom="achado" titulo="A investigar" itens={achados}
              explicacao="A propriedade falhou contra o contrato e continuou falhando depois de uma
                tentativa de correção. São três possibilidades, e a ferramenta não distingue: o
                contrato tem um defeito; a invariante não vale para ele; ou o harness gerado está
                errado — um panic em storage.rs ou unwrap.rs dentro do SDK é quase sempre este
                último. O contra-exemplo é a sequência mínima que quebra. Quem audita decide." />

            <Grupo tom="ok" titulo="Verificadas" itens={verificadas}
              explicacao="Valem para toda sequência de operações sorteada, contra o contrato como ele
                é. O harness que ficou na cópia contém exatamente estas — é uma suíte de regressão
                pronta para entrar no CI." />

            <Grupo tom="fora" titulo="Não verificadas" itens={fora}
              explicacao="Não viraram evidência: ou o teste gerado não compilou, ou a propriedade se
                mostrou instável entre execuções, ou saiu na curadoria. Ficam listadas porque um
                silêncio aqui faria o relatório parecer mais completo do que é." />
          </div>
        );
      })()}

      {log.length > 0 && (
        <section className="rounded-xl border border-line overflow-hidden">
          <button onClick={() => setLogAberto((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-secondary hover:bg-line/50 text-left">
            {logAberto ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
                       : <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />}
            <span className="text-sm font-medium text-ink">Saída do cargo</span>
            <span className="font-mono text-xs text-ink-muted ml-auto">{log.length} linhas</span>
          </button>
          {logAberto && (
            <pre className="p-4 bg-ink text-brand-100 text-[11px] font-mono overflow-auto max-h-96 leading-relaxed whitespace-pre-wrap">
              {log.join('\n')}<div ref={fimLog} />
            </pre>
          )}
        </section>
      )}

      {relatorio?.diff?.length > 0 && (
        <section className="card p-5 flex flex-col gap-4 overflow-hidden">
          <header className="flex flex-col gap-1">
            <span className="section-label flex items-center gap-1.5">
              <FileDiff className="w-3.5 h-3.5" /> O que a auditoria escreveu
            </span>
            <p className="text-sm text-ink-muted max-w-[68ch] leading-relaxed">
              Tudo isto aconteceu numa <strong className="text-ink">cópia</strong> do crate, fora do
              seu repositório — nada aqui tocou no original. O diff é parte do entregável: uma
              ferramenta que gera código e mostra só o placar pede uma confiança que não merece.
            </p>
            {relatorio.copia && (
              <p className="font-mono text-[11px] text-ink-muted flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-success shrink-0" />
                {relatorio.copia}
              </p>
            )}
          </header>

          {(relatorio.diff as ArquivoDiff[]).map((d) => {
            const linhas = linhasDoDiff(d.antes, d.depois);
            const mais = linhas.filter((l) => l.sinal === '+').length;
            const menos = linhas.filter((l) => l.sinal === '-').length;
            const chave = `diff:${d.caminho}`;
            const abertoAgora = aberto[chave] ?? d.tipo === 'alterado';
            return (
              <div key={d.caminho} className="border border-line rounded-lg overflow-hidden">
                <button className="w-full flex items-center gap-2 px-3 py-2 bg-surface-secondary hover:bg-brand-50/50 transition-colors"
                  onClick={() => setAberto((p) => ({ ...p, [chave]: !abertoAgora }))}>
                  {abertoAgora ? <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
                               : <ChevronRight className="w-3.5 h-3.5 text-ink-muted" />}
                  {d.tipo === 'novo' ? <FilePlus2 className="w-3.5 h-3.5 text-success" />
                                     : <FileDiff className="w-3.5 h-3.5 text-brand-500" />}
                  <span className="font-mono text-xs text-ink">{d.caminho}</span>
                  <span className="chip ml-1">{d.tipo}</span>
                  <span className="font-mono text-[11px] ml-auto tabular-nums">
                    <span className="text-success">+{mais}</span>{' '}
                    {menos > 0 && <span className="text-danger">-{menos}</span>}
                  </span>
                </button>
                {abertoAgora && (
                  <pre className="text-[11px] font-mono overflow-auto max-h-[28rem] leading-[1.6]">
                    {linhas.map((l, n) => (
                      <div key={n} className={clsx('px-3 whitespace-pre-wrap',
                        l.sinal === '+' && 'bg-success/10 text-ink',
                        l.sinal === '-' && 'bg-danger/10 text-danger',
                        l.sinal === ' ' && 'text-ink-muted')}>
                        <span className="select-none opacity-40 mr-2">{l.sinal}</span>{l.texto}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            );
          })}
        </section>
      )}

      {status === 'concluido' && id && (
        <button className="btn-ghost w-fit"
          onClick={() => fetch(`/api/pipeline/${id}/cleanup`, { method: 'POST' })}>
          <Trash2 className="w-3.5 h-3.5" /> Apagar a cópia de trabalho
        </button>
      )}
    </div>
  );
}

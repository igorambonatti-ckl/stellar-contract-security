import { useEffect, useRef, useState } from 'react';
import {
  Play, Square, Loader2, CheckCircle2, XCircle, MinusCircle, Circle,
  ChevronDown, ChevronRight, Trash2, FolderOpen, Clock,
} from 'lucide-react';
import clsx from 'clsx';
import { Erro } from '../components/Erro';

type StageStatus = 'pendente' | 'rodando' | 'ok' | 'falhou' | 'pulado';

interface Stage {
  id: string; label: string; status: StageStatus; detail?: string;
  startedAt?: number; finishedAt?: number; data?: any;
}

interface Invariant {
  id: string; statement: string; class: string; observation: string;
  confidence?: string; assumption?: string;
  verdict?: 'mantida' | 'descartada' | 'nao-testada'; verdictReason?: string;
}

const ICON: Record<StageStatus, React.ReactNode> = {
  pendente: <Circle className="w-4 h-4 opacity-30" />,
  rodando: <Loader2 className="w-4 h-4 animate-spin text-brand-500" />,
  ok: <CheckCircle2 className="w-4 h-4 text-success" />,
  falhou: <XCircle className="w-4 h-4 text-danger" />,
  pulado: <MinusCircle className="w-4 h-4 text-ink-muted" />,
};

function dur(s: Stage) {
  if (!s.startedAt || !s.finishedAt) return null;
  const ms = s.finishedAt - s.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Caminhos já auditados, para não ter que escolher de novo. */
const RECENTES = 'auditoria:recentes';

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
  const [stages, setStages] = useState<Stage[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle'|'rodando'|'concluido'|'falhou'|'cancelado'>('idle');
  const [id, setId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [logAberto, setLogAberto] = useState(false);
  const fimLog = useRef<HTMLDivElement>(null);
  const es = useRef<EventSource | null>(null);

  useEffect(() => () => es.current?.close(), []);
  useEffect(() => { if (logAberto) fimLog.current?.scrollIntoView({ block: 'end' }); }, [log, logAberto]);

  async function escolherPasta() {
    setEscolhendo(true); setErro(null);
    try {
      const res = await fetch('/api/pick-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startIn: path.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      // Cancelar devolve null e não é erro.
      if (json.path) setPath(json.path);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEscolhendo(false);
    }
  }

  async function iniciar(alvo = path) {
    setErro(null); setStages([]); setLog([]); setStatus('rodando'); setAberto({});
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: alvo.trim(), hiddenFeatures: [] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setId(json.id);
      setRecentes(guardarRecente(alvo.trim()));

      const src = new EventSource(`/api/pipeline/${json.id}/stream`);
      es.current = src;
      src.addEventListener('snapshot', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setStages(d.stages); setLog(d.log);
      });
      src.addEventListener('stage', (e) => {
        const s: Stage = JSON.parse((e as MessageEvent).data);
        setStages((prev) => prev.map((x) => (x.id === s.id ? s : x)));
      });
      src.addEventListener('log', (e) => {
        setLog((l) => [...l, JSON.parse((e as MessageEvent).data)]);
      });
      src.addEventListener('done', (e) => {
        setStatus(JSON.parse((e as MessageEvent).data).status);
        src.close();
      });
      src.onerror = () => src.close();
    } catch (e) {
      setErro((e as Error).message); setStatus('idle');
    }
  }

  const relatorio = stages.find((s) => s.id === 'relatorio' && s.status === 'ok')?.data;
  const invariantes: Invariant[] = relatorio?.invariants
    ?? stages.find((s) => s.id === 'propor')?.data?.invariants
    ?? [];

  return (
    <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col gap-7">
      <header className="flex flex-col gap-2">
        <span className="section-label">Auditoria automática</span>
        <h1 className="text-3xl font-bold text-ink">Aponte e rode</h1>
        <p className="text-ink-muted max-w-[70ch] leading-relaxed">
          Inspeciona o crate, a IA propõe invariantes e gera o harness, o cargo compila, e então
          cada propriedade é testada <strong className="text-ink">contra o contrato como ele é</strong>.
          O que falha ali é falso positivo e sai sozinho — a curadoria é feita por execução, não por
          alguém clicando.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <button className="btn-outline shrink-0" onClick={escolherPasta}
            disabled={escolhendo || status === 'rodando'}>
            {escolhendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
            Escolher pasta
          </button>

          <input className="input font-mono text-sm" value={path} spellCheck={false}
            placeholder="ou cole o caminho do crate"
            onChange={(e) => setPath(e.target.value)}
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

        {recentes.length > 0 && status !== 'rodando' && (
          <div className="flex items-center gap-2 flex-wrap">
            <Clock className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            {recentes.map((r) => (
              <button key={r} onClick={() => { setPath(r); iniciar(r); }}
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
                  <div className="px-4 pb-4 pt-3 border-t border-line grid sm:grid-cols-4 gap-3">
                    {[['Propostas', s.data.propostas], ['Mantidas', s.data.mantidas],
                      ['Descartadas', s.data.descartadas], ['Yield', `${s.data.yield}%`]].map(([k, v]) => (
                      <div key={k as string}>
                        <div className="section-label mb-1">{k as string}</div>
                        <div className="font-mono text-2xl font-bold text-ink tabular-nums">{v as any}</div>
                      </div>
                    ))}
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

      {invariantes.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-bold text-ink">Invariantes</h2>
          <div className="flex flex-col gap-2">
            {invariantes.map((inv) => {
              const desc = inv.verdict === 'descartada';
              return (
                <div key={inv.id} className={clsx('card p-4 flex flex-col gap-2',
                  desc && 'opacity-70 border-red-200 bg-red-50/30')}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-ink">{inv.id}</span>
                    <span className="text-xs text-ink-muted">{inv.class}</span>
                    <span className={clsx('px-2 py-0.5 rounded text-[10px] font-bold uppercase border ml-auto',
                      desc ? 'bg-red-50 text-red-600 border-red-200'
                           : 'bg-brand-50 text-brand-600 border-brand-100')}>
                      {desc ? 'descartada' : 'mantida'}
                    </span>
                  </div>
                  <p className="text-sm text-ink leading-relaxed">{inv.statement}</p>
                  {inv.verdictReason && (
                    <p className="text-xs text-red-700 leading-relaxed border-l-2 border-red-300 pl-3">
                      {inv.verdictReason}
                    </p>
                  )}
                  {!desc && inv.assumption && (
                    <p className="text-xs text-ink-muted leading-relaxed border-l-2 border-line pl-3">
                      <span className="font-semibold">Suposição não verificada:</span> {inv.assumption}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

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

      {status === 'concluido' && id && (
        <button className="btn-ghost w-fit"
          onClick={() => fetch(`/api/pipeline/${id}/cleanup`, { method: 'POST' })}>
          <Trash2 className="w-3.5 h-3.5" /> Apagar o harness gerado do crate
        </button>
      )}
    </div>
  );
}

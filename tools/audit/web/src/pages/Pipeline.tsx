import { useEffect, useRef, useState } from 'react';
import {
  Play, Square, Loader2, CheckCircle2, XCircle, MinusCircle, Circle,
  ChevronDown, ChevronRight, Trash2, FileCode2, Clock, EyeOff, UserCheck, Wand2,
} from 'lucide-react';
import clsx from 'clsx';
import { Erro } from '../components/Erro';

type StageStatus = 'pendente' | 'rodando' | 'ok' | 'falhou' | 'pulado' | 'aguardando';

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
  aguardando: <UserCheck className="w-4 h-4 text-brand-500" />,
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
  // Features do crate, lidas assim que um contrato é apontado, para dar chance
  // de esconder do modelo as que carregam caminhos conhecidos.
  const [features, setFeatures] = useState<string[]>([]);
  const [escondidas, setEscondidas] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] =
    useState<'idle'|'rodando'|'aguardando-curadoria'|'concluido'|'falhou'|'cancelado'>('idle');
  // Curado é o padrão porque é o fluxo com evidência: no benchmark deste
  // projeto, curar as invariantes propostas levou a detecção de 1-2 dos 7 bugs
  // plantados para 7 de 7. O modo automático fica disponível ao lado, e o que
  // ele mede é exatamente o tamanho dessa diferença.
  const [modo, setModo] = useState<'curado'|'automatico'>('curado');
  const [propostas, setPropostas] = useState<Invariant[] | null>(null);
  const [aceitas, setAceitas] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [logAberto, setLogAberto] = useState(false);
  const fimLog = useRef<HTMLDivElement>(null);
  const es = useRef<EventSource | null>(null);

  useEffect(() => () => es.current?.close(), []);
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
      setFeatures(info.features ?? []);
    } catch { /* silencioso: é conveniência, o pipeline inspeciona de novo */ }
  }

  async function iniciar(alvo = path) {
    setErro(null); setStages([]); setLog([]); setStatus('rodando'); setAberto({});
    setPropostas(null); setAceitas(new Set());
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: alvo.trim(), hiddenFeatures: escondidas, modo }),
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
      src.addEventListener('curadoria', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setPropostas(d.invariants);
        // Tudo aceito por padrão: o trabalho é tirar o que não vale, e partir
        // de "nada aceito" faria uma curadoria apressada virar zero invariante.
        setAceitas(new Set(d.invariants.map((i: Invariant) => i.id)));
        setStatus('aguardando-curadoria');
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
        <span className="section-label">Auditoria de contrato Soroban</span>
        <h1 className="text-3xl font-bold text-ink">Fuzzing guiado por IA</h1>
        <p className="text-ink-muted max-w-[72ch] leading-relaxed">
          A IA lê o contrato e propõe as invariantes. Você separa as que valem das que só parecem
          valer. O resto é máquina: um rig de fuzzing com sequências sorteadas, uma asserção por
          invariante, e cada propriedade testada{' '}
          <strong className="text-ink">contra o contrato como ele é</strong> — o que falha ali é
          falso positivo e sai sozinho.
        </p>
        <p className="text-sm text-ink-muted max-w-[72ch] leading-relaxed">
          No benchmark deste projeto, com sete bugs plantados e resposta conhecida, a curadoria
          é o passo que mais pesa: <strong className="text-ink">7 de 7</strong> com ela,{' '}
          <strong className="text-ink">1 a 2 de 7</strong> sem.
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

        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-muted">Modo:</span>
          {([
            ['curado', 'Curado', UserCheck, 'Para depois de propor e espera seu veredito'],
            ['automatico', 'Automático', Wand2, 'Vai direto ao fim, sem curadoria — mede quanto ela vale'],
          ] as const).map(([v, rotulo, Icone, dica]) => (
            <button key={v} title={dica} onClick={() => setModo(v)}
              disabled={status === 'rodando' || status === 'aguardando-curadoria'}
              className={clsx('flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors',
                modo === v
                  ? 'border-brand-400 bg-brand-50 text-brand-700'
                  : 'border-line text-ink-muted hover:border-brand-200')}>
              <Icone className="w-3.5 h-3.5" /> {rotulo}
            </button>
          ))}
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

        {features.length > 0 && status !== 'rodando' && (
          <div className="card p-4 flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <EyeOff className="w-4 h-4 text-ink-muted mt-0.5 shrink-0" />
              <div>
                <h2 className="text-sm font-bold text-ink">Esconder do modelo</h2>
                <p className="text-xs text-ink-muted mt-1 leading-relaxed max-w-[70ch]">
                  O fonte pode conter as respostas. Features que escondem caminhos conhecidos —
                  bugs plantados, ramos de debug — vão para o modelo junto com o código, e aí ele
                  escreve invariantes sobre os bugs em vez de sobre o contrato. Marque para
                  resolver o <code className="font-mono">cfg</code> antes de enviar.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {features.map((f) => {
                const on = escondidas.includes(f);
                return (
                  <button key={f}
                    onClick={() => setEscondidas((xs) =>
                      on ? xs.filter((x) => x !== f) : [...xs, f])}
                    className={on
                      ? 'tag-blue cursor-pointer'
                      : 'inline-flex items-center px-3 py-1 rounded-md bg-surface-secondary text-ink-muted border border-line text-xs font-semibold hover:border-brand-200'}>
                    {f}
                  </button>
                );
              })}
              {features.length > 1 && (
                <button
                  onClick={() => setEscondidas(escondidas.length === features.length ? [] : features)}
                  className="text-xs text-ink-muted hover:text-brand-600 underline underline-offset-2 px-1">
                  {escondidas.length === features.length ? 'nenhuma' : 'todas'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <Erro msg={erro} />

      {propostas && status === 'aguardando-curadoria' && (
        <section className="card border-brand-300 flex flex-col gap-4">
          <header className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex flex-col gap-1">
              <span className="section-label flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5" /> Curadoria
              </span>
              <h2 className="text-lg font-semibold text-ink">
                {propostas.length} invariantes propostas
              </h2>
              <p className="text-sm text-ink-muted max-w-[62ch] leading-relaxed">
                Tire as que não valem a pena testar: as que restatem uma linha do código, as que
                não podem falhar, e as que você sabe que não valem para este contrato. O que
                sobrar vira um teste de fuzzing com sequências sorteadas.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button className="btn-outline text-sm"
                onClick={() => setAceitas(new Set(propostas.map((i) => i.id)))}>
                Todas
              </button>
              <button className="btn-outline text-sm" onClick={() => setAceitas(new Set())}>
                Nenhuma
              </button>
              <button className="btn-primary" disabled={enviando || aceitas.size === 0}
                onClick={async () => {
                  setEnviando(true);
                  try {
                    const res = await fetch(`/api/pipeline/${id}/curadoria`, {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ aceitas: [...aceitas] }),
                    });
                    if (!res.ok) throw new Error((await res.json()).error);
                    setStatus('rodando'); setPropostas(null);
                  } catch (e) {
                    setErro((e as Error).message);
                  } finally {
                    setEnviando(false);
                  }
                }}>
                {enviando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Testar {aceitas.size}
              </button>
            </div>
          </header>

          <ul className="flex flex-col gap-2">
            {propostas.map((inv) => {
              const on = aceitas.has(inv.id);
              return (
                <li key={inv.id}>
                  <label className={clsx(
                    'flex gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                    on ? 'border-brand-200 bg-brand-50/40' : 'border-line opacity-55 hover:opacity-80')}>
                    <input type="checkbox" checked={on} className="mt-1 accent-brand-500"
                      onChange={() => setAceitas((prev) => {
                        const p = new Set(prev);
                        if (p.has(inv.id)) p.delete(inv.id); else p.add(inv.id);
                        return p;
                      })} />
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-ink-muted">{inv.id}</span>
                        <span className="chip">{inv.class}</span>
                        {inv.confidence && (
                          <span className={clsx('chip',
                            inv.confidence === 'low' && 'text-danger border-red-200')}>
                            confiança {inv.confidence}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-ink leading-relaxed">{inv.statement}</p>
                      {inv.assumption && (
                        <p className="text-xs text-ink-muted leading-relaxed">
                          <strong>Assume:</strong> {inv.assumption}
                        </p>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
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

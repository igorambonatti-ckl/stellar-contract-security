import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, Loader2, Check, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../api';
import { useStore } from '../store';
import { Erro } from '../components/Erro';

const CONF: Record<string, string> = {
  high: 'bg-brand-50 text-brand-600 border-brand-100',
  medium: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  low: 'bg-orange-50 text-orange-600 border-orange-200',
};

export function Invariantes() {
  const store = useStore();
  const nav = useNavigate();
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function propor() {
    if (!store.info) return;
    setCarregando(true); setErro(null);
    try {
      const r = await api.invariants(store.info.path, store.hiddenFeatures);
      if (r.parseError || !r.invariants) {
        setErro(`O modelo não devolveu JSON válido (${r.parseError}). Saída bruta abaixo.`);
        store.set({ rawProposal: r.raw, proposals: [] });
      } else {
        store.set({ proposals: r.invariants, rawProposal: r.raw, accepted: new Set() });
      }
    } catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  }

  if (!store.info) {
    return <div className="max-w-6xl mx-auto px-6 py-10">
      <p className="text-ink-muted">Inspecione um contrato primeiro.</p>
    </div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <span className="section-label">Etapa 2 · o checkpoint humano</span>
        <h1 className="text-3xl font-bold text-ink">Propor e curar invariantes</h1>
        <p className="text-ink-muted max-w-[70ch] leading-relaxed">
          O modelo propõe; <strong className="text-ink">você decide o que entra</strong>. Esta é a
          etapa que separa "a IA escreveu um fuzzer" de um resultado confiável — uma proposta que
          não vale é pior que uma ausente, porque queima tempo de curadoria e vira alarme falso.
        </p>
      </header>

      <div className="flex gap-3 items-center flex-wrap">
        <button className="btn-primary" onClick={propor}
          disabled={carregando || !store.aiConfigured}>
          {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {store.proposals.length ? 'Propor de novo' : 'Propor invariantes'}
        </button>
        {!store.aiConfigured && (
          <span className="text-sm text-ink-muted">
            Defina <code className="font-mono text-xs">OPENROUTER_API_KEY</code> em{' '}
            <code className="font-mono text-xs">tools/audit/api/.env</code> e reinicie a API.
          </span>
        )}
        {store.proposals.length > 0 && (
          <span className="text-sm text-ink-muted">
            <strong className="text-ink">{store.accepted.size}</strong> de {store.proposals.length} aceitas
            {store.accepted.size > 0 && ` · yield ${Math.round(store.accepted.size / store.proposals.length * 100)}%`}
          </span>
        )}
      </div>

      <Erro msg={erro} />

      <div className="flex flex-col gap-2.5">
        {store.proposals.map((inv) => {
          const on = store.accepted.has(inv.id);
          return (
            <div key={inv.id} className={clsx('card overflow-hidden transition-colors',
              on && 'border-brand-300 bg-brand-50/40')}>
              <div className="p-4 flex gap-3 items-start">
                <button onClick={() => store.toggleAccepted(inv.id)}
                  aria-label={on ? 'Rejeitar' : 'Aceitar'}
                  className={clsx('w-7 h-7 rounded-md border flex items-center justify-center shrink-0 transition-colors',
                    on ? 'bg-brand-500 border-brand-500 text-white'
                       : 'border-line text-ink-muted hover:border-brand-300')}>
                  {on ? <Check className="w-4 h-4" /> : <X className="w-3.5 h-3.5 opacity-50" />}
                </button>

                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-ink">{inv.id}</span>
                    <span className="text-xs text-ink-muted">{inv.class}</span>
                    {inv.confidence && (
                      <span className={clsx('px-2 py-0.5 rounded text-[10px] font-bold uppercase border',
                        CONF[inv.confidence] ?? CONF.low)}>{inv.confidence}</span>
                    )}
                    {inv.silent === false && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase border bg-surface-secondary text-ink-muted border-line">
                        falha ruidosa
                      </span>
                    )}
                  </div>

                  <p className="text-sm text-ink leading-relaxed">{inv.statement}</p>
                  <p className="text-xs text-ink-muted leading-relaxed">
                    <span className="font-semibold">Como observar:</span> {inv.observation}
                  </p>
                  {inv.assumption && (
                    <p className="text-xs text-ink-muted leading-relaxed border-l-2 border-line pl-3">
                      <span className="font-semibold">Suposição:</span> {inv.assumption}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {store.proposals.length === 0 && store.rawProposal && (
        <pre className="p-4 rounded-lg bg-ink text-brand-100 text-xs font-mono overflow-x-auto max-h-96">
          {store.rawProposal}
        </pre>
      )}

      {store.accepted.size > 0 && (
        <button className="btn-primary w-fit" onClick={() => nav('/harness')}>
          Gerar harness com {store.accepted.size} invariantes <ArrowRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

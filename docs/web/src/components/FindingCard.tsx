import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { Achado, Severidade } from '../data';

// Mesma escala do FindingCard do ChainGuard, remapeada para as categorias que
// este relatório realmente tem — nenhuma delas é uma vulnerabilidade explorável,
// então "critical/high/medium" seria rotular errado.
const SEV: Record<Severidade, { classe: string; rotulo: string }> = {
  'refutado':       { classe: 'bg-red-50 text-red-600 border-red-200',          rotulo: 'REFUTADO' },
  'falso-positivo': { classe: 'bg-orange-50 text-orange-600 border-orange-200', rotulo: 'FALSO POSITIVO' },
  'ferramenta':     { classe: 'bg-orange-50 text-orange-600 border-orange-200', rotulo: 'FERRAMENTA' },
  'metodo':         { classe: 'bg-yellow-50 text-yellow-700 border-yellow-200', rotulo: 'MÉTODO' },
  'soroban':        { classe: 'bg-brand-50 text-brand-600 border-brand-100',    rotulo: 'SOROBAN' },
  'ecossistema':    { classe: 'bg-surface-secondary text-ink-muted border-line', rotulo: 'ECOSSISTEMA' },
};

export function FindingCard({ achado }: { achado: Achado }) {
  const [aberto, setAberto] = useState(false);
  const sev = SEV[achado.severidade];

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setAberto(!aberto)}
        aria-expanded={aberto}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-surface-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
      >
        {aberto ? (
          <ChevronDown className="w-4 h-4 shrink-0 text-ink-muted" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0 text-ink-muted" />
        )}

        <span className={clsx('px-2 py-0.5 rounded text-xs font-semibold border shrink-0', sev.classe)}>
          {sev.rotulo}
        </span>

        <span className="text-sm font-medium text-ink flex-1">{achado.titulo}</span>
        <span className="font-mono text-xs text-ink-muted shrink-0">{achado.id}</span>
      </button>

      {aberto && (
        <div className="px-4 pb-4 pt-4 border-t border-line flex flex-col gap-3">
          {achado.corpo.map((p, i) => (
            <p key={i} className="text-sm text-ink-muted leading-relaxed max-w-[75ch]">
              {p}
            </p>
          ))}

          {achado.codigo && (
            <pre className="p-3 rounded-lg bg-ink text-brand-100 text-xs font-mono leading-relaxed overflow-x-auto">
              {achado.codigo}
            </pre>
          )}

          <div className="rounded-lg bg-brand-50 border border-brand-100 px-4 py-3">
            <div className="section-label text-brand-600 mb-1">Desfecho</div>
            <p className="text-sm text-brand-600">{achado.desfecho}</p>
          </div>
        </div>
      )}
    </div>
  );
}

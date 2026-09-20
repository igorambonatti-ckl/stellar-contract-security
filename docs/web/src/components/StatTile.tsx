interface Props {
  rotulo: string;
  controle: string;
  assistido: string;
  pctControle: number;
  pctAssistido: number;
  nota: string;
}

/** Controle e assistido lado a lado, com as barras na mesma escala — a
 *  comparação é o dado, não cada número isolado. */
export function StatTile({ rotulo, controle, assistido, pctControle, pctAssistido, nota }: Props) {
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="section-label">{rotulo}</div>

      <div className="flex items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-3xl font-bold text-ink-muted tabular-nums leading-none">
            {controle}
          </span>
          <span className="text-xs text-ink-muted">controle</span>
        </div>
        <span className="text-ink-muted text-xl pb-5">→</span>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-3xl font-bold text-brand-500 tabular-nums leading-none">
            {assistido}
          </span>
          <span className="text-xs text-ink-muted">assistido</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="h-1.5 rounded-full bg-surface-secondary overflow-hidden">
          <div className="h-full bg-ink-muted/40" style={{ width: `${pctControle}%` }} />
        </div>
        <div className="h-1.5 rounded-full bg-surface-secondary overflow-hidden">
          <div className="h-full bg-brand-500" style={{ width: `${pctAssistido}%` }} />
        </div>
      </div>

      <p className="text-xs text-ink-muted leading-relaxed">{nota}</p>
    </div>
  );
}

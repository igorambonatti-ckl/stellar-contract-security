import { FindingCard } from '../components/FindingCard';
import { ACHADOS, LIMITACOES } from '../data';

export function Achados() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <div className="section-label">Achados</div>
        <h1 className="text-3xl font-bold text-ink">O que o processo realmente pegou</h1>
        <p className="text-ink-muted max-w-[75ch] leading-relaxed">
          Incluindo o que estava errado. Nenhum destes é uma vulnerabilidade explorável no contrato —
          são achados sobre o <em>método</em>, que é o que esta auditoria estava medindo.
        </p>
      </header>

      <div className="flex flex-col gap-2.5">
        {ACHADOS.map((a) => (
          <FindingCard key={a.id} achado={a} />
        ))}
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="section-label">Honestidade</div>
          <h2 className="text-2xl font-bold text-ink">O que estes números não mostram</h2>
          <p className="text-ink-muted max-w-[75ch]">
            Estes pontos limitam o que os números têm permissão de significar.
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {LIMITACOES.map(([titulo, corpo]) => (
            <li key={titulo} className="grid grid-cols-[auto_1fr] gap-3 items-start">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 mt-2.5" />
              <p className="text-ink-muted leading-relaxed max-w-[75ch]">
                <span className="font-semibold text-ink">{titulo}</span> {corpo}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

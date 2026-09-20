import clsx from 'clsx';
import { SEEDS, ERROS_MEDICAO, type Verdict } from '../data';

function Pill({ v }: { v: Verdict }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border',
        v === 'pegou'
          ? 'bg-brand-50 text-brand-600 border-brand-100'
          : 'bg-surface-secondary text-ink-muted border-line',
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {v}
    </span>
  );
}

export function Matriz() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <div className="section-label">Evidência</div>
        <h1 className="text-3xl font-bold text-ink">Matriz de detecção</h1>
        <p className="text-ink-muted max-w-[75ch] leading-relaxed">
          Os dois braços rodam o mesmo motor, sobre o mesmo contrato, com o mesmo orçamento. A única
          diferença é o oráculo: um pergunta <em>a chamada abortou?</em>, o outro lê o estado de
          volta e compara com um cálculo independente. Reportado por seed, nunca agregado — um dos
          seeds derruba quatro testes distintos e inflaria o total sozinho.
        </p>
      </header>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-secondary">
              {['Bug plantado', 'Invariante', 'Controle', 'Assistido', 'Pego por'].map((h) => (
                <th key={h} className="text-left px-4 py-3 section-label border-b border-line whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEEDS.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-ink whitespace-nowrap">{s.id}</td>
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{s.invariante}</td>
                <td className="px-4 py-3"><Pill v={s.controle} /></td>
                <td className="px-4 py-3"><Pill v={s.assistido} /></td>
                <td className="px-4 py-3 text-ink-muted text-xs leading-relaxed min-w-[280px]">{s.nota}</td>
              </tr>
            ))}
            <tr className="bg-surface-secondary font-bold">
              <td className="px-4 py-3 text-ink">Total</td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-ink-muted">1 / 7</td>
              <td className="px-4 py-3 text-brand-600">7 / 7</td>
              <td className="px-4 py-3 text-ink-muted text-xs font-normal">
                O contrato limpo passa em todos os braços — sem isso, nenhuma detecção seria
                atribuível.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="section-label">Confiabilidade</div>
          <h2 className="text-2xl font-bold text-ink">Seis erros de medição, e o que pegou cada um</h2>
          <p className="text-ink-muted max-w-[75ch] leading-relaxed">
            Cada um produziu um número plausível que sobreviveu até algo contradizê-lo. A lista do
            que pegou cada um é o argumento a favor do método.
          </p>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-secondary">
                {['O que estava errado', 'Pego por', 'O que teria sido publicado'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 section-label border-b border-line whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ERROS_MEDICAO.map(([erro, pego, teria]) => (
                <tr key={erro} className="border-b border-line last:border-0">
                  <td className="px-4 py-3 text-ink">{erro}</td>
                  <td className="px-4 py-3 text-ink-muted">{pego}</td>
                  <td className="px-4 py-3 text-ink-muted">{teria}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-sm text-ink-muted border-l-[3px] border-brand-500 pl-4 max-w-[75ch] leading-relaxed">
          Cinco foram pegos por um gate definido de antemão. O sexto não —{' '}
          <span className="font-semibold text-ink">
            nada exigia reler o texto de uma asserção que já estava verde.
          </span>
        </p>
      </section>
    </div>
  );
}

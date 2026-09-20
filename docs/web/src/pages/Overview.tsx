import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { StatTile } from '../components/StatTile';
import { METRICAS } from '../data';

export function Overview() {
  return (
    <>
      <section className="bg-grid border-b border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-14 flex flex-col gap-6">
          <span className="tag-blue w-fit">Auditoria de contrato Soroban</span>

          <h1 className="text-4xl sm:text-5xl font-bold text-ink max-w-3xl leading-tight text-balance">
            Dois braços de fuzzing, um contrato, sete bugs plantados.
          </h1>

          <p className="text-lg text-ink-muted max-w-2xl leading-relaxed border-l-[3px] border-brand-500 pl-4">
            <span className="font-semibold text-ink">
              A IA propõe, o humano cura, o fuzzer decide.
            </span>{' '}
            Um modelo lê uma expressão e enumera como ela pode dar errado. Ele não sabe dizer se
            aquele estado é alcançável — e vai afirmar o caso impossível com mais confiança que o
            real. A execução é a única autoridade do ciclo que não pode ser convencida de um falso
            positivo.
          </p>

          <div className="flex gap-3 flex-wrap">
            <Link to="/matriz" className="btn-primary">
              Ver a matriz <ArrowRight className="w-4 h-4" />
            </Link>
            <Link to="/achados" className="btn-outline">Achados</Link>
          </div>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col gap-8">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {METRICAS.map((m) => (
            <StatTile key={m.rotulo} {...m} />
          ))}
        </div>

        <div className="card p-6 flex flex-col gap-3">
          <h2 className="text-xl font-bold text-ink">Por que a diferença existe</h2>
          <p className="text-ink-muted leading-relaxed max-w-[75ch]">
            O controle pega exatamente o único bug que faz o contrato abortar. Os outros seis
            aceitam a chamada, retornam normalmente e deixam o estado errado — saldo duplicado,
            oferta inflada por uma multiplicação com wrap, uma entrada deixada para ser arquivada,
            o admin sobrescrito. Um oráculo de liveness é estruturalmente cego para tudo isso.
          </p>
          <p className="text-ink-muted leading-relaxed max-w-[75ch]">
            As duas últimas colunas acima são instrumentos independentes: o{' '}
            <code className="font-mono text-sm">cargo-mutants</code> não sabe nada dos bugs
            plantados, ele mutila o contrato por conta própria. A concordância entre eles é o que
            responde à objeção que um benchmark feito sob medida não consegue responder sozinho.
          </p>
        </div>
      </section>
    </>
  );
}

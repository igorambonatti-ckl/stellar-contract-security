const ETAPAS = [
  { n: '0', titulo: 'Visão limpa', humano: false,
    corpo: 'O fonte pode já conter as respostas. Aqui, 22 linhas do contrato nomeavam um bug plantado ou um ID de invariante. Remova, e verifique que a versão limpa é behavioralmente idêntica — uma visão limpa não verificada é um segundo contrato.' },
  { n: '1', titulo: 'Propor invariantes', humano: false,
    corpo: 'Peça propriedades que relacionem duas ou mais quantidades observáveis e que possam falhar em silêncio. Exija, por proposta, a suposição que está sendo aceita de fé — é a linha mais barata do método inteiro.' },
  { n: '2', titulo: 'Curar', humano: true,
    corpo: '"Isso tem que reverter" só é aceito se o teste distinguir a falha certa. E concilie o ledger contra a contagem de propostas: este projeto reportou 12 de 16 por quase um dia, quando eram 13.' },
  { n: '3', titulo: 'Priorizar entradas', humano: false,
    corpo: 'A etapa fácil de rodar, fácil de commitar, e fácil de nunca integrar — que foi exatamente o que aconteceu. O braço de fuzzing achava 2 de 7 até ela ser incorporada, e 7 de 7 depois.' },
  { n: '4', titulo: 'Gerar o harness, e consertar', humano: false,
    corpo: 'Espere código errado e raciocínio certo. 16 dos 17 erros de compilação vieram de uma suposição errada sobre o SDK, pegos pelo compilador em segundos. O bug de runtime, o modelo tinha sinalizado sozinho — incluindo a forma errada de consertar.' },
  { n: '5', titulo: 'Rodar, controles primeiro', humano: false,
    corpo: 'Rode o contrato limpo antes de tudo. Um crash ali é falso positivo, e até resolver, nenhuma detecção daquele braço é atribuível. Disparou aqui: um braço reportou 8 de 8 enquanto quebrava o contrato correto.' },
  { n: '6', titulo: 'Triar', humano: true,
    corpo: 'Duas perguntas, nesta ordem: é atribuível — leia a mensagem da asserção, não a cor; e é alcançável on-chain? Um achado que nenhum atacante consegue disparar é bug de harness fantasiado de achado.' },
];

export function Metodo() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <div className="section-label">O método</div>
        <h1 className="text-3xl font-bold text-ink">Como apontar isto para um contrato</h1>
        <p className="text-ink-muted max-w-[75ch] leading-relaxed">
          As etapas 1, 3 e 4 são os pontos de inserção da IA. As etapas 2 e 6 são onde o humano não
          é opcional. A etapa 5 é a única que produz evidência.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        {ETAPAS.map((e) => (
          <li key={e.n} className="card p-5 flex gap-4 items-start">
            <span className="font-mono text-sm font-bold text-brand-500 shrink-0 w-6 pt-0.5">
              {e.n}
            </span>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-bold text-ink">{e.titulo}</h2>
                {e.humano && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-brand-50 text-brand-600 border border-brand-100">
                    humano
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-muted leading-relaxed max-w-[75ch]">{e.corpo}</p>
            </div>
          </li>
        ))}
      </ol>

      <section className="card p-6 flex flex-col gap-3 bg-brand-50 border-brand-100">
        <h2 className="text-xl font-bold text-brand-600">O que é específico de Soroban</h2>
        <p className="text-brand-600 leading-relaxed max-w-[75ch]">
          Entrada persistente escrita sem estender TTL, TTL da instância decaindo enquanto saldos
          seguem vivos, autoridade lida de um tier que expira silenciosamente, e chamadas que
          estouram o teto de recursos da rede. Todas ausentes de checklists derivados do EVM.
        </p>
        <p className="text-brand-600 leading-relaxed max-w-[75ch]">
          E uma que <span className="font-semibold">não tem oráculo caixa-preta</span>: detectar um{' '}
          <code className="font-mono text-sm">extend_ttl</code> faltando exige ler o TTL da entrada,
          o que exige a chave de storage, o que exige ter lido o contrato. Os dois candidatos
          baseados em contadores de recurso foram testados e refutados.
        </p>
      </section>
    </div>
  );
}

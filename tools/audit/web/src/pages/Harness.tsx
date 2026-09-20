import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Code2, ArrowRight, Loader2, FileCheck } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { Erro } from '../components/Erro';

export function Harness() {
  const store = useStore();
  const nav = useNavigate();
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const curadas = store.proposals.filter((p) => store.accepted.has(p.id));

  async function gerar() {
    if (!store.info) return;
    setCarregando(true); setErro(null);
    try {
      const r = await api.harness(store.info.path, curadas, store.hiddenFeatures);
      store.set({ harnessCode: r.code, harnessPath: r.written });
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
        <span className="section-label">Etapa 3</span>
        <h1 className="text-3xl font-bold text-ink">Gerar o harness</h1>
        <p className="text-ink-muted max-w-[70ch] leading-relaxed">
          A partir das <strong className="text-ink">{curadas.length} invariantes que você aceitou</strong> —
          não da proposta inteira. Espere código errado e raciocínio certo: erros de compilação são
          baratos, o compilador pega em segundos. O que merece leitura é a seção de suposições que
          o modelo não conseguiu verificar.
        </p>
      </header>

      <div className="flex gap-3 items-center flex-wrap">
        <button className="btn-primary" onClick={gerar}
          disabled={carregando || curadas.length === 0 || !store.aiConfigured}>
          {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Code2 className="w-4 h-4" />}
          {store.harnessCode ? 'Gerar de novo' : 'Gerar harness'}
        </button>
        {curadas.length === 0 && (
          <span className="text-sm text-ink-muted">Aceite ao menos uma invariante antes.</span>
        )}
      </div>

      <Erro msg={erro} />

      {store.harnessPath && (
        <div className="flex gap-3 items-start rounded-lg border border-brand-100 bg-brand-50 px-4 py-3">
          <FileCheck className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm text-brand-600">Escrito em</p>
            <code className="font-mono text-xs text-brand-600 break-all">{store.harnessPath}</code>
          </div>
        </div>
      )}

      {store.harnessCode && (
        <>
          <pre className="p-4 rounded-lg bg-ink text-brand-100 text-xs font-mono overflow-x-auto max-h-[520px] leading-relaxed">
            {store.harnessCode}
          </pre>
          <button className="btn-primary w-fit" onClick={() => nav('/execucao')}>
            Compilar e rodar <ArrowRight className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );
}

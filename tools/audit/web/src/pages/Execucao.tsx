import { useEffect, useRef, useState } from 'react';
import { Play, Square, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api, streamRun } from '../api';
import { useStore } from '../store';
import { Erro } from '../components/Erro';

type Status = 'idle' | 'running' | 'passed' | 'failed' | 'cancelled';

export function Execucao() {
  const store = useStore();
  const [linhas, setLinhas] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [runId, setRunId] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const fim = useRef<HTMLDivElement>(null);
  const fechar = useRef<(() => void) | null>(null);

  useEffect(() => () => fechar.current?.(), []);
  useEffect(() => { fim.current?.scrollIntoView({ block: 'end' }); }, [linhas]);

  async function iniciar(tipo: 'harness' | 'todos' | 'mutants') {
    if (!store.info) return;
    setLinhas([]); setErro(null); setStatus('running');
    try {
      const alvo = tipo === 'harness' ? 'audit_generated' : undefined;
      const { id } = tipo === 'mutants'
        ? await api.runMutants(store.info.path, alvo)
        : await api.runTest(store.info.path, alvo);
      setRunId(id);
      fechar.current = streamRun(id,
        (l) => setLinhas((ls) => [...ls, l]),
        (d) => setStatus(d.status as Status));
    } catch (e) { setErro((e as Error).message); setStatus('idle'); }
  }

  if (!store.info) {
    return <div className="max-w-6xl mx-auto px-6 py-10">
      <p className="text-ink-muted">Inspecione um contrato primeiro.</p>
    </div>;
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="section-label">Etapa 4</span>
        <h1 className="text-3xl font-bold text-ink">Compilar e rodar</h1>
        <p className="text-ink-muted max-w-[70ch] leading-relaxed">
          O fuzzer é a única autoridade do ciclo que não pode ser convencida de um falso positivo.
          <strong className="text-ink"> Rode a suíte inteira antes do harness gerado:</strong> se o
          contrato já falha alguma coisa, nada do que vier depois é atribuível.
        </p>
      </header>

      <div className="flex gap-2 flex-wrap items-center">
        <button className="btn-primary" onClick={() => iniciar('todos')} disabled={status === 'running'}>
          <Play className="w-4 h-4" /> Suíte inteira
        </button>
        <button className="btn-outline" onClick={() => iniciar('harness')}
          disabled={status === 'running' || !store.harnessCode}>
          <Play className="w-4 h-4" /> Só o harness gerado
        </button>
        <button className="btn-ghost" onClick={() => iniciar('mutants')} disabled={status === 'running'}>
          cargo mutants
        </button>
        {status === 'running' && runId && (
          <button className="btn-ghost" onClick={() => api.cancel(runId)}>
            <Square className="w-3.5 h-3.5" /> Cancelar
          </button>
        )}

        <span className={clsx('ml-auto inline-flex items-center gap-2 px-3 py-1 rounded-md text-xs font-semibold border',
          status === 'running' && 'bg-brand-50 text-brand-600 border-brand-100',
          status === 'passed' && 'bg-green-50 text-green-700 border-green-200',
          (status === 'failed' || status === 'cancelled') && 'bg-red-50 text-red-600 border-red-200',
          status === 'idle' && 'bg-surface-secondary text-ink-muted border-line')}>
          {status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {status === 'passed' && <CheckCircle2 className="w-3.5 h-3.5" />}
          {(status === 'failed' || status === 'cancelled') && <XCircle className="w-3.5 h-3.5" />}
          {{ idle: 'parado', running: 'rodando', passed: 'passou', failed: 'falhou', cancelled: 'cancelado' }[status]}
        </span>
      </div>

      <Erro msg={erro} />

      <div className="rounded-xl border border-line bg-ink overflow-hidden">
        <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between">
          <span className="font-mono text-xs text-brand-300">saída do cargo</span>
          <span className="font-mono text-xs text-ink-muted">{linhas.length} linhas</span>
        </div>
        <pre className="p-4 text-xs font-mono text-brand-100 overflow-auto max-h-[560px] leading-relaxed whitespace-pre-wrap">
          {linhas.length === 0
            ? <span className="opacity-50">Nada ainda. Comece pela suíte inteira.</span>
            : linhas.join('\n')}
          <div ref={fim} />
        </pre>
      </div>

      {status === 'failed' && (
        <p className="text-sm text-ink-muted border-l-[3px] border-brand-500 pl-4 max-w-[75ch] leading-relaxed">
          Antes de tratar isto como achado: <strong className="text-ink">leia a mensagem da asserção</strong>,
          não só a cor. Uma falha que nomeia uma propriedade diferente da que você acha que quebrou
          é um bug do harness, não do contrato. E um caso minimizado não é automaticamente uma
          instância do seu bug — confira contra o contrato limpo.
        </p>
      )}
    </div>
  );
}

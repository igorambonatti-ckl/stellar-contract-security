import { useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Check, Circle } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { api } from '../api';

const ETAPAS = [
  { to: '/', label: 'Contrato' },
  { to: '/invariantes', label: 'Invariantes' },
  { to: '/harness', label: 'Harness' },
  { to: '/execucao', label: 'Execução' },
];

export function Layout() {
  const { pathname } = useLocation();
  const store = useStore();

  useEffect(() => {
    api.health()
      .then((h) => store.set({ aiConfigured: h.ai.configured, aiModel: h.ai.model }))
      .catch(() => store.set({ aiConfigured: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const feito: Record<string, boolean> = {
    '/': Boolean(store.info),
    '/invariantes': store.accepted.size > 0,
    '/harness': Boolean(store.harnessCode),
    '/execucao': false,
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-50 bg-surface border-b border-line">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-6">
          <Link to="/" className="flex items-center gap-1 text-lg font-bold text-ink shrink-0">
            <span className="text-brand-500 font-mono">&lt;</span>
            <span>auditoria</span>
            <span className="text-brand-500 font-mono">&gt;</span>
          </Link>

          <nav className="flex items-center gap-1 flex-1 justify-center">
            {ETAPAS.map((e, i) => {
              const ativo = pathname === e.to;
              return (
                <Link key={e.to} to={e.to}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                    ativo ? 'bg-brand-50 text-brand-600'
                          : 'text-ink-muted hover:text-ink hover:bg-surface-secondary')}>
                  {feito[e.to]
                    ? <Check className="w-3.5 h-3.5 text-success" />
                    : <Circle className="w-3.5 h-3.5 opacity-40" />}
                  <span className="hidden sm:inline">{i + 1}. {e.label}</span>
                </Link>
              );
            })}
          </nav>

          <span className={clsx('text-xs font-mono px-2 py-1 rounded border shrink-0',
            store.aiConfigured
              ? 'bg-brand-50 text-brand-600 border-brand-100'
              : 'bg-surface-secondary text-ink-muted border-line')}>
            {store.aiConfigured ? (store.aiModel ?? 'IA') : 'IA desligada'}
          </span>
        </div>
      </header>

      <main className="flex-1"><Outlet /></main>
    </div>
  );
}

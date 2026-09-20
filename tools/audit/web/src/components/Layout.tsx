import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import clsx from 'clsx';

export function Layout() {
  const [ai, setAi] = useState<{ configured: boolean; model: string | null } | null>(null);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then((h) => setAi(h.ai)).catch(() => setAi(null));
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-50 bg-surface border-b border-line">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 text-lg font-bold text-ink">
            <span className="text-brand-500 font-mono">&lt;</span>
            <span>auditoria</span>
            <span className="text-brand-500 font-mono">&gt;</span>
          </div>
          <span className={clsx('text-xs font-mono px-2 py-1 rounded border',
            ai?.configured
              ? 'bg-brand-50 text-brand-600 border-brand-100'
              : 'bg-surface-secondary text-ink-muted border-line')}>
            {ai === null ? 'API fora do ar' : ai.configured ? (ai.model ?? 'IA') : 'IA desligada'}
          </span>
        </div>
      </header>
      <main className="flex-1"><Outlet /></main>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

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
            <span>audit</span>
            <span className="text-brand-500 font-mono">&gt;</span>
          </div>
          {/* O modelo é escolhido por execução, na própria página. Mostrá-lo aqui
              exibia o default do .env enquanto a auditoria rodava com outro —
              um indicador que contradiz o que está acontecendo é pior que
              nenhum. Fica só o estado da API. */}
          {(ai === null || !ai.configured) && (
            <span className="text-xs font-mono px-2 py-1 rounded border bg-danger/10 text-danger border-danger/30">
              {ai === null ? 'API fora do ar' : 'sem OPENROUTER_API_KEY'}
            </span>
          )}
        </div>
      </header>
      <main className="flex-1"><Outlet /></main>
    </div>
  );
}

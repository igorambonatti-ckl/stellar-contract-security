import { Outlet, Link, useLocation } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import clsx from 'clsx';

const NAV = [
  { to: '/', label: 'Resumo' },
  { to: '/matriz', label: 'Matriz' },
  { to: '/achados', label: 'Achados' },
  { to: '/metodo', label: 'Método' },
];

export function Layout() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <header className="sticky top-0 z-50 bg-surface border-b border-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-1 text-lg font-bold text-ink shrink-0">
            <span className="text-brand-500 font-mono">&lt;</span>
            <span>stellar-studies</span>
            <span className="text-brand-500 font-mono">&gt;</span>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((l) => {
              const active = l.to === '/' ? pathname === '/' : pathname.startsWith(l.to);
              return (
                <Link
                  key={l.to}
                  to={l.to}
                  className={clsx(
                    'px-3 sm:px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150',
                    active
                      ? 'bg-brand-50 text-brand-600'
                      : 'text-ink-muted hover:text-ink hover:bg-surface-secondary',
                  )}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-line bg-surface-secondary">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 grid sm:grid-cols-3 gap-6 text-sm text-ink-muted">
          <div className="flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 text-brand-500 shrink-0" />
            <span>
              Auditoria do <span className="font-mono text-ink">soroban-vault</span> por fuzzing
              assistido por IA.
            </span>
          </div>
          <div>
            <div className="section-label mb-2">Reproduzir</div>
            <code className="text-xs block leading-relaxed">
              cargo test
              <br />
              scripts/demo.sh
            </code>
          </div>
          <div>
            <div className="section-label mb-2">Contexto</div>
            Plano de Desenvolvimento Individual
            <br />
            Cheesecake Labs · 2026
          </div>
        </div>
      </footer>
    </div>
  );
}

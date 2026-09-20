import { StrictMode, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { StoreContext, type AuditState } from './store';
import './index.css';

function Root() {
  const [state, setState] = useState<AuditState>({
    info: null, hiddenFeatures: [], proposals: [], accepted: new Set(),
    rawProposal: '', harnessCode: '', harnessPath: null,
    aiConfigured: false, aiModel: null,
  });

  const set = useCallback((patch: Partial<AuditState>) => {
    setState((s) => ({ ...s, ...patch }));
  }, []);

  const toggleAccepted = useCallback((id: string) => {
    setState((s) => {
      const next = new Set(s.accepted);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...s, accepted: next };
    });
  }, []);

  return (
    <StoreContext.Provider value={{ ...state, set, toggleAccepted }}>
      <HashRouter><App /></HashRouter>
    </StoreContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);

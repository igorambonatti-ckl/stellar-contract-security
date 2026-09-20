import { createContext, useContext } from 'react';
import type { ContractInfo, Invariant } from './api';

/** Estado do fluxo de auditoria, partilhado entre as etapas. */
export interface AuditState {
  info: ContractInfo | null;
  hiddenFeatures: string[];
  proposals: Invariant[];
  /** IDs aceitos na curadoria — o checkpoint humano. */
  accepted: Set<string>;
  rawProposal: string;
  harnessCode: string;
  harnessPath: string | null;
  aiConfigured: boolean;
  aiModel: string | null;
}

export interface AuditStore extends AuditState {
  set: (patch: Partial<AuditState>) => void;
  toggleAccepted: (id: string) => void;
}

export const StoreContext = createContext<AuditStore | null>(null);

export function useStore(): AuditStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useStore fora do provider');
  return s;
}

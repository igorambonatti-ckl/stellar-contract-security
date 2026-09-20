/** Cliente da API de auditoria. Erros trazem a mensagem do servidor, não "500". */

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error((json as any).error ?? `${res.status}`);
  return json as T;
}

export interface EntryPoint { name: string; signature: string; requiresAuth: boolean }
export interface ContractInfo {
  path: string; crateName: string; sourceFile: string;
  entryPoints: EntryPoint[];
  errorCodes: { name: string; code: number }[];
  features: string[];
  tiers: { instance: boolean; persistent: boolean; temporary: boolean };
  extendsTtl: boolean; callsOtherContracts: boolean; loc: number; warnings: string[];
}

export interface Invariant {
  id: string; statement: string; class: string; observation: string;
  silent?: boolean; assumption?: string; confidence?: string; rationale?: string;
}

export interface RunInfo {
  id: string; label: string; command: string; status: 'running'|'passed'|'failed'|'cancelled';
  startedAt: number; finishedAt?: number; exitCode?: number|null; lines: string[];
}

export const api = {
  health: () => req<{ ok: boolean; ai: { configured: boolean; model: string|null } }>('/health'),
  inspect: (path: string) => req<ContractInfo>('/inspect', { path }),
  cleanView: (path: string, hiddenFeatures: string[]) =>
    req<{ source: string; originalLines: number; viewLines: number }>('/clean-view', { path, hiddenFeatures }),
  invariants: (path: string, hiddenFeatures: string[]) =>
    req<{ invariants: Invariant[]|null; raw: string; model: string; parseError: string|null }>(
      '/ai/invariants', { path, hiddenFeatures }),
  harness: (path: string, invariants: Invariant[], hiddenFeatures: string[]) =>
    req<{ code: string; raw: string; model: string; written: string|null }>(
      '/ai/harness', { path, invariants, hiddenFeatures }),
  runTest: (path: string, testTarget?: string) => req<{ id: string }>('/run/test', { path, testTarget }),
  runMutants: (path: string, testTarget?: string) => req<{ id: string }>('/run/mutants', { path, testTarget }),
  run: (id: string) => req<RunInfo>(`/runs/${id}`),
  cancel: (id: string) => req<{ ok: boolean }>(`/runs/${id}/cancel`, {}),
};

/** Stream de uma execução. Devolve a função de cancelamento. */
export function streamRun(
  id: string,
  onLine: (l: string) => void,
  onDone: (s: { status: string; exitCode: number|null }) => void,
): () => void {
  const es = new EventSource(`/api/runs/${id}/stream`);
  es.addEventListener('line', (e) => onLine(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('done', (e) => { onDone(JSON.parse((e as MessageEvent).data)); es.close(); });
  es.onerror = () => es.close();
  return () => es.close();
}

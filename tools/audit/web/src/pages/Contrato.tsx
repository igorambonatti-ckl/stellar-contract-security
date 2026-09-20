import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRight, ShieldAlert, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { Erro } from '../components/Erro';

export function Contrato() {
  const store = useStore();
  const nav = useNavigate();
  const [path, setPath] = useState(store.info?.path ?? '');
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function inspecionar() {
    setCarregando(true); setErro(null);
    try {
      const info = await api.inspect(path);
      store.set({ info, hiddenFeatures: [], proposals: [], accepted: new Set(), harnessCode: '' });
    } catch (e) { setErro((e as Error).message); }
    finally { setCarregando(false); }
  }

  const info = store.info;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <span className="section-label">Etapa 1</span>
        <h1 className="text-3xl font-bold text-ink">Aponte para um crate Soroban</h1>
        <p className="text-ink-muted max-w-[70ch] leading-relaxed">
          O caminho da raiz do crate — onde está o <code className="font-mono text-sm">Cargo.toml</code>.
          A ferramenta lê o manifesto, acha o arquivo com <code className="font-mono text-sm">#[contract]</code>,
          e extrai os entry points de dentro dos blocos <code className="font-mono text-sm">#[contractimpl]</code>.
        </p>
      </header>

      <div className="flex gap-2">
        <input className="input font-mono text-sm" value={path} spellCheck={false}
          placeholder="/caminho/para/o/crate"
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && path.trim() && inspecionar()} />
        <button className="btn-primary shrink-0" onClick={inspecionar} disabled={!path.trim() || carregando}>
          {carregando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Inspecionar
        </button>
      </div>

      <Erro msg={erro} />

      {info && (
        <div className="flex flex-col gap-4">
          {info.warnings.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3">
              {info.warnings.map((w) => (
                <div key={w} className="flex gap-2 items-start">
                  <ShieldAlert className="w-4 h-4 text-yellow-700 mt-0.5 shrink-0" />
                  <p className="text-sm text-yellow-800">{w}</p>
                </div>
              ))}
            </div>
          )}

          <div className="grid sm:grid-cols-4 gap-3">
            {[
              ['Crate', info.crateName],
              ['Entry points', String(info.entryPoints.length)],
              ['Linhas', String(info.loc)],
              ['Códigos de erro', String(info.errorCodes.length)],
            ].map(([k, v]) => (
              <div key={k} className="card p-4">
                <div className="section-label mb-1">{k}</div>
                <div className="font-mono text-sm font-bold text-ink break-all">{v}</div>
              </div>
            ))}
          </div>

          <div className="card p-5 flex flex-col gap-3">
            <h2 className="font-bold text-ink">Superfície Soroban</h2>
            <div className="flex flex-wrap gap-2">
              {[
                ['instance', info.tiers.instance], ['persistent', info.tiers.persistent],
                ['temporary', info.tiers.temporary], ['extend_ttl', info.extendsTtl],
                ['chama outros contratos', info.callsOtherContracts],
              ].map(([label, on]) => (
                <span key={label as string}
                  className={on
                    ? 'tag-blue'
                    : 'inline-flex items-center px-3 py-1 rounded-md bg-surface-secondary text-ink-muted border border-line text-xs font-semibold'}>
                  {label as string}
                </span>
              ))}
            </div>
            {info.tiers.persistent && !info.extendsTtl && (
              <p className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2">
                Escreve no tier persistente e nunca chama <code className="font-mono">extend_ttl</code>.
                Entradas ficam para ser arquivadas — sob o protocolo 23 elas são auto-restauradas,
                então nada quebra visivelmente e o custo aparece depois.
              </p>
            )}
          </div>

          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-surface-secondary">
                {['Entry point', 'Assinatura', 'require_auth'].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 section-label border-b border-line">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {info.entryPoints.map((e) => (
                  <tr key={e.name} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-ink">{e.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{e.signature}</td>
                    <td className="px-4 py-2.5">
                      {e.requiresAuth
                        ? <span className="tag-blue">sim</span>
                        : <span className="text-xs text-ink-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {info.features.length > 0 && (
            <div className="card p-5 flex flex-col gap-3">
              <div>
                <h2 className="font-bold text-ink">Esconder features do modelo</h2>
                <p className="text-sm text-ink-muted mt-1 max-w-[70ch] leading-relaxed">
                  O fonte pode conter as respostas. Features que escondem caminhos conhecidos —
                  bugs plantados, ramos de debug — vazam para o modelo junto com o código. Marque
                  para resolver o <code className="font-mono text-xs">cfg</code> antes de enviar.
                  <strong className="text-ink"> É uma transformação textual, não um compilador:</strong> confira
                  o resultado antes de confiar.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {info.features.map((f) => {
                  const on = store.hiddenFeatures.includes(f);
                  return (
                    <button key={f} onClick={() => store.set({
                      hiddenFeatures: on
                        ? store.hiddenFeatures.filter((x) => x !== f)
                        : [...store.hiddenFeatures, f],
                    })}
                      className={on ? 'tag-blue cursor-pointer'
                        : 'inline-flex items-center px-3 py-1 rounded-md bg-surface-secondary text-ink-muted border border-line text-xs font-semibold hover:border-brand-200'}>
                      {f}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <button className="btn-primary w-fit" onClick={() => nav('/invariantes')}>
            Propor invariantes <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

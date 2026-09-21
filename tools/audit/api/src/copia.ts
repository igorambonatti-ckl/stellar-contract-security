import { readFile, writeFile, mkdir, cp, rm, readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';

/**
 * Uma cópia autônoma do crate, fora do repositório auditado.
 *
 * Motivo: a ferramenta precisa escrever para trabalhar — acrescentar `"lib"` ao
 * `crate-type`, pôr `proptest` nas dev-dependencies, criar
 * `tests/audit_generated.rs`. Fazer isso no repositório de quem contratou a
 * auditoria é uma má ideia mesmo sendo aditivo e reversível: se o processo
 * morre no meio, o `Cargo.toml` de outra pessoa fica alterado, e "eu desfaço
 * depois" não é uma garantia que se dá ao código de um cliente.
 *
 * Copiar resolve, e de quebra transforma o que a auditoria escreveu num
 * artefato que se pode ler: o diff entre o original e a cópia é exatamente o
 * que a ferramenta fez, linha por linha.
 *
 * A parte que exige cuidado é tornar a cópia **autônoma**. Um contrato Soroban
 * quase sempre é membro de um workspace e escreve `soroban-sdk = { workspace =
 * true }`; fora do workspace isso não resolve. E há uma armadilha pior que uma
 * dependência não resolvida: o `[profile.release]` do workspace costuma trazer
 * `overflow-checks = true`, que é o que faz um `+` abortar em vez de dar a
 * volta. Perder esse perfil na cópia muda o comportamento aritmético do
 * contrato — a auditoria passaria a medir um contrato que não é o que está no
 * repositório, e não avisaria.
 */

export interface Copia {
  /** Onde a cópia vive. */
  dir: string;
  /** O crate original, para o diff. */
  origem: string;
  /** O que foi preciso mudar para a cópia compilar sozinha. */
  ajustes: string[];
}

/** Sobe até o `Cargo.toml` que declara `[workspace]`. */
async function acharWorkspace(dir: string): Promise<{ raiz: string; manifesto: any } | null> {
  let atual = resolve(dir);
  for (let i = 0; i < 12; i++) {
    const pai = dirname(atual);
    if (pai === atual) break;
    atual = pai;
    const txt = await readFile(join(atual, 'Cargo.toml'), 'utf8').catch(() => null);
    if (txt === null) continue;
    const m = parseToml(txt) as any;
    if (m?.workspace) return { raiz: atual, manifesto: m };
  }
  return null;
}

/** Serializa um valor de dependência do jeito que o Cargo aceita. */
function dep(valor: any): string {
  if (typeof valor === 'string') return JSON.stringify(valor);
  const partes = Object.entries(valor)
    .filter(([k]) => k !== 'workspace')
    .map(([k, v]) => `${k} = ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`);
  return `{ ${partes.join(', ')} }`;
}

/**
 * Funde a declaração local com a do workspace.
 *
 * `soroban-sdk = { workspace = true, features = ["testutils"] }` quer dizer
 * "o que o workspace diz, mais testutils" — descartar as features locais
 * removeria justamente o `testutils`, sem o qual nenhum teste compila.
 */
function fundir(local: any, doWorkspace: any): any {
  const base = typeof doWorkspace === 'string' ? { version: doWorkspace } : { ...doWorkspace };
  if (typeof local !== 'object' || local === null) return base;

  const juntas = new Set<string>([...(base.features ?? []), ...(local.features ?? [])]);
  const out: any = { ...base, ...Object.fromEntries(
    Object.entries(local).filter(([k]) => k !== 'workspace' && k !== 'features')) };
  if (juntas.size) out.features = [...juntas];
  return out;
}

function secaoDeps(nome: string, deps: Record<string, any>, doWorkspace: Record<string, any>,
                   ajustes: string[]): string {
  const linhas = Object.entries(deps).map(([k, v]) => {
    if (typeof v === 'object' && v !== null && (v as any).workspace === true) {
      const w = doWorkspace[k];
      if (w === undefined) {
        ajustes.push(`\`${k}\` dizia \`workspace = true\` e o workspace não a declara; ficou como estava`);
        return `${k} = ${dep(v)}`;
      }
      ajustes.push(`\`${k}\` resolvida do workspace para a cópia rodar sozinha`);
      return `${k} = ${dep(fundir(v, w))}`;
    }
    return `${k} = ${dep(v)}`;
  });
  return linhas.length ? `[${nome}]\n${linhas.join('\n')}\n` : '';
}

/** Reescreve o TOML de uma tabela simples (perfis, features). */
function tabela(nome: string, valor: any): string {
  if (!valor || typeof valor !== 'object') return '';
  const linhas = Object.entries(valor)
    .filter(([, v]) => typeof v !== 'object' || Array.isArray(v))
    .map(([k, v]) => `${k} = ${Array.isArray(v) ? JSON.stringify(v) : JSON.stringify(v)}`);
  const aninhadas = Object.entries(valor)
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([k, v]) => tabela(`${nome}.${k}`, v));
  return (linhas.length ? `[${nome}]\n${linhas.join('\n')}\n\n` : '') + aninhadas.join('');
}

export async function copiarCrate(origem: string, id: string): Promise<Copia> {
  const dir = join(tmpdir(), 'auditoria-soroban', id, basename(origem));
  await rm(dirname(dir), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  await cp(join(origem, 'src'), join(dir, 'src'), { recursive: true });
  // `tests/` do original fica de fora: são testes de integração de quem
  // escreveu o contrato, podem depender de coisas que não vieram, e não é
  // papel da auditoria consertá-los. O harness gerado entra num `tests/` novo.
  const original = await readFile(join(origem, 'Cargo.toml'), 'utf8');
  const m = parseToml(original) as any;
  const ajustes: string[] = [];

  const ws = await acharWorkspace(origem);
  const wdeps: Record<string, any> = ws?.manifesto?.workspace?.dependencies ?? {};

  let out = '';
  out += tabela('package', { ...m.package, ...(m.package?.version === undefined ? { version: '0.0.0' } : {}) });
  if (m.lib) out += tabela('lib', m.lib);
  out += secaoDeps('dependencies', m.dependencies ?? {}, wdeps, ajustes);
  out += '\n' + secaoDeps('dev-dependencies', m['dev-dependencies'] ?? {}, wdeps, ajustes);
  if (m.features) out += '\n' + tabela('features', m.features);

  // Os perfis do workspace vêm junto. `overflow-checks = true` é o exemplo que
  // importa: sem ele um `+` dá a volta em vez de abortar, e a cópia deixaria de
  // ser o contrato que está no repositório.
  for (const [nome, valor] of Object.entries(ws?.manifesto?.profile ?? {})) {
    out += '\n' + tabela(`profile.${nome}`, valor);
    ajustes.push(`perfil \`${nome}\` trazido do workspace — inclui \`overflow-checks\` e outras opções que mudam o comportamento do contrato`);
  }
  for (const [nome, valor] of Object.entries(m.profile ?? {})) {
    out += '\n' + tabela(`profile.${nome}`, valor);
  }

  // Fecha a cópia como workspace próprio, senão o Cargo sobe a árvore e tenta
  // se juntar a algum workspace do /tmp.
  out += '\n[workspace]\n';

  await writeFile(join(dir, 'Cargo.toml'), out, 'utf8');
  return { dir, origem, ajustes };
}

/** Remove a cópia inteira. */
export async function descartarCopia(c: Copia) {
  await rm(dirname(c.dir), { recursive: true, force: true });
}

export interface ArquivoDiff {
  caminho: string;
  tipo: 'novo' | 'alterado';
  antes?: string;
  depois: string;
}

/**
 * O que a auditoria escreveu, para ser lido lado a lado com o original.
 *
 * É o entregável tanto quanto o relatório: uma ferramenta que gera código e não
 * mostra o que gerou pede confiança que não merece.
 */
export async function diffDaCopia(c: Copia): Promise<ArquivoDiff[]> {
  const out: ArquivoDiff[] = [];

  const antes = await readFile(join(c.origem, 'Cargo.toml'), 'utf8').catch(() => undefined);
  const depois = await readFile(join(c.dir, 'Cargo.toml'), 'utf8').catch(() => null);
  if (depois !== null && antes !== depois) {
    out.push({ caminho: 'Cargo.toml', tipo: 'alterado', antes, depois });
  }

  for (const f of await readdir(join(c.dir, 'tests')).catch(() => [])) {
    if (!f.endsWith('.rs')) continue;
    const texto = await readFile(join(c.dir, 'tests', f), 'utf8').catch(() => null);
    if (texto === null) continue;
    const anterior = await readFile(join(c.origem, 'tests', f), 'utf8').catch(() => undefined);
    out.push({
      caminho: `tests/${f}`,
      tipo: anterior === undefined ? 'novo' : 'alterado',
      antes: anterior,
      depois: texto,
    });
  }

  return out;
}

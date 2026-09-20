import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface EntryPoint {
  name: string;
  signature: string;
  /** `require_auth` appears somewhere in the body. */
  requiresAuth: boolean;
}

export interface ContractInfo {
  path: string;
  crateName: string;
  sourceFile: string;
  entryPoints: EntryPoint[];
  errorCodes: { name: string; code: number }[];
  /** Cargo features the crate declares. */
  features: string[];
  /** Storage tiers the source touches — the Soroban-specific surface. */
  tiers: { instance: boolean; persistent: boolean; temporary: boolean };
  extendsTtl: boolean;
  callsOtherContracts: boolean;
  loc: number;
  warnings: string[];
  /** Um teste existente do crate, usado como referência da API real. */
  exampleTest?: { file: string; source: string };
}

/** Strip block and line comments so they cannot fool the regexes below. */
function decomment(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The public surface of a Soroban contract lives in `impl` blocks annotated
 * with `#[contractimpl]`. A crate can have several, and it can also have plain
 * `impl` blocks of private helpers which must not be reported as entry points —
 * so the search is scoped to the annotated blocks by brace matching rather than
 * by scanning the whole file for `pub fn`.
 */
function extractEntryPoints(src: string): EntryPoint[] {
  const out: EntryPoint[] = [];
  const clean = decomment(src);

  let idx = 0;
  while ((idx = clean.indexOf('#[contractimpl]', idx)) !== -1) {
    const braceStart = clean.indexOf('{', idx);
    if (braceStart === -1) break;

    let depth = 0;
    let end = braceStart;
    for (; end < clean.length; end++) {
      if (clean[end] === '{') depth++;
      else if (clean[end] === '}' && --depth === 0) break;
    }

    const body = clean.slice(braceStart, end);
    const fnRe = /pub\s+fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)\s*(->\s*[^{;]+)?/g;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(body))) {
      const [, name, args, ret] = m;
      // The body of this particular fn, for the auth check.
      const fnBodyStart = body.indexOf('{', m.index + m[0].length);
      let d = 0;
      let fnEnd = fnBodyStart;
      for (; fnEnd < body.length && fnBodyStart !== -1; fnEnd++) {
        if (body[fnEnd] === '{') d++;
        else if (body[fnEnd] === '}' && --d === 0) break;
      }
      const fnBody = fnBodyStart === -1 ? '' : body.slice(fnBodyStart, fnEnd);

      out.push({
        name,
        signature: `${name}(${args.replace(/\s+/g, ' ').trim()})${ret ? ' ' + ret.trim() : ''}`,
        requiresAuth: /require_auth/.test(fnBody),
      });
    }
    idx = end;
  }
  return out;
}

function extractErrorCodes(src: string): { name: string; code: number }[] {
  const clean = decomment(src);
  const block = clean.match(/#\[contracterror\][\s\S]*?enum\s+\w+\s*\{([\s\S]*?)\n\}/);
  if (!block) return [];
  const out: { name: string; code: number }[] = [];
  const re = /([A-Z][A-Za-z0-9_]*)\s*=\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]))) out.push({ name: m[1], code: Number(m[2]) });
  return out;
}

async function findContractSource(dir: string): Promise<string | null> {
  const src = join(dir, 'src');
  let names: string[];
  try {
    names = await readdir(src);
  } catch {
    return null;
  }
  // lib.rs first, then any other .rs that carries #[contract].
  const ordered = ['lib.rs', ...names.filter((n) => n !== 'lib.rs' && n.endsWith('.rs'))];
  for (const n of ordered) {
    const p = join(src, n);
    try {
      const text = await readFile(p, 'utf8');
      if (/#\[contract\]/.test(text)) return p;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Um teste que já existe no crate, para servir de referência de API.
 *
 * É o antídoto para o modo de falha dominante: o modelo escreve o harness
 * chutando a superfície do SDK, erra a assinatura do cliente gerado, e o
 * compilador só diz *que* está errado — nunca qual é a certa. Devolver o erro
 * não resolve, e a prova é que o mesmo erro sobrevive a duas tentativas de
 * correção.
 *
 * Um teste que compila mostra a assinatura real. Prefere `tests/` a `src/`
 * porque um teste de integração usa exatamente a superfície pública que o
 * harness vai usar; e prefere o menor, porque serve de exemplo e não de
 * enciclopédia.
 */
async function findExampleTest(dir: string): Promise<{ file: string; source: string } | undefined> {
  const candidatos: string[] = [];
  for (const sub of ['tests', 'src']) {
    try {
      for (const f of await readdir(join(dir, sub))) {
        if (f.endsWith('.rs') && /test/i.test(f)) candidatos.push(join(dir, sub, f));
      }
    } catch { /* sem o diretório */ }
  }

  const lidos = await Promise.all(
    candidatos.map(async (f) => {
      const source = await readFile(f, 'utf8').catch(() => '');
      return { file: f, source };
    }),
  );

  const uteis = lidos
    // Precisa exercitar o contrato de verdade, não ser um módulo de helpers.
    .filter((c) => /#\[test\]|proptest!/.test(c.source) && /Client::new|env\.register/.test(c.source))
    .sort((a, b) => a.source.length - b.source.length);

  const escolhido = uteis[0];
  if (!escolhido) return undefined;

  // Um arquivo enorme empurraria o fonte do contrato para fora da janela.
  const MAX = 12000;
  return {
    file: escolhido.file,
    source: escolhido.source.length > MAX
      ? escolhido.source.slice(0, MAX) + '\n// ... (truncado)'
      : escolhido.source,
  };
}

export async function inspectContract(inputPath: string): Promise<ContractInfo> {
  const dir = resolve(inputPath);
  const warnings: string[] = [];

  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) {
    throw Object.assign(new Error(`Não é um diretório: ${dir}`), { status: 400 });
  }

  const manifestPath = join(dir, 'Cargo.toml');
  const manifestRaw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (manifestRaw === null) {
    throw Object.assign(
      new Error(`Sem Cargo.toml em ${dir}. Aponte para a raiz de um crate Soroban.`),
      { status: 400 },
    );
  }

  const manifest = parseToml(manifestRaw) as any;
  const crateName: string = manifest?.package?.name ?? basename(dir);
  const features = Object.keys(manifest?.features ?? {}).filter((f) => f !== 'default');

  const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.['dev-dependencies'] ?? {}) };
  if (!('soroban-sdk' in deps)) {
    warnings.push(
      'O Cargo.toml não declara soroban-sdk. Isto pode não ser um contrato Soroban.',
    );
  }

  const sourceFile = await findContractSource(dir);
  if (!sourceFile) {
    throw Object.assign(
      new Error(`Nenhum arquivo com #[contract] encontrado em ${join(dir, 'src')}.`),
      { status: 400 },
    );
  }

  const src = await readFile(sourceFile, 'utf8');
  const clean = decomment(src);
  const entryPoints = extractEntryPoints(src);

  if (entryPoints.length === 0) {
    warnings.push(
      'Nenhum entry point público encontrado dentro de #[contractimpl]. O harness gerado será vazio.',
    );
  }

  const cdylibOnly = /crate-type\s*=\s*\[[^\]]*"cdylib"/.test(manifestRaw) &&
    !/crate-type\s*=\s*\[[^\]]*"lib"/.test(manifestRaw);
  if (cdylibOnly) {
    warnings.push(
      'crate-type é só "cdylib". Um harness de teste precisa de "lib" para linkar o crate.',
    );
  }

  return {
    path: dir,
    crateName,
    sourceFile,
    entryPoints,
    errorCodes: extractErrorCodes(src),
    features,
    tiers: {
      instance: /storage\(\)\s*\.\s*instance\(\)/.test(clean),
      persistent: /storage\(\)\s*\.\s*persistent\(\)/.test(clean),
      temporary: /storage\(\)\s*\.\s*temporary\(\)/.test(clean),
    },
    extendsTtl: /extend_ttl/.test(clean),
    callsOtherContracts: /Client::new|token::/.test(clean),
    loc: src.split('\n').length,
    warnings,
    exampleTest: await findExampleTest(dir),
  };
}

/**
 * Source with the named cargo features resolved *away*, for handing to a model.
 *
 * Why this exists: a contract's source can contain the answers. In this
 * project's own benchmark the seeded bugs lived behind `#[cfg(feature = ...)]`
 * with comments naming each one, so showing the file to a model would have
 * leaked the answer key. The same applies to any crate with feature-gated
 * debug paths or known-bad branches.
 *
 * `#[cfg(not(feature = X))]` keeps its block and loses the attribute;
 * `#[cfg(feature = X)]` loses both. Everything else is untouched.
 *
 * **This is a textual transform and it is not a compiler.** Verify the result
 * before trusting it — the reference workflow substitutes it for the real
 * source and re-runs the test suite.
 */
export function cleanView(src: string, hiddenFeatures: string[]): string {
  if (hiddenFeatures.length === 0) return src;
  const alt = hiddenFeatures.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  const lines = src.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isNot = new RegExp(`#\\[cfg\\(not\\(feature\\s*=\\s*"(${alt})"\\)\\)\\]`).test(line);
    const isPos = new RegExp(`#\\[cfg\\(feature\\s*=\\s*"(${alt})"\\)\\]`).test(line);

    if (isNot) continue; // drop the attribute, keep the block

    if (isPos) {
      // Drop the attribute and the item that follows it. The item is either a
      // braced block or a single statement ending in `;`.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) break;

      if (lines[j].includes('{')) {
        let depth = 0;
        for (; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
          }
          if (depth <= 0 && lines[j].includes('}')) break;
        }
      } else {
        while (j < lines.length && !lines[j].trimEnd().endsWith(';')) j++;
      }
      i = j;
      continue;
    }

    out.push(line);
  }

  // Comments that name a hidden feature would leak it just as loudly.
  return out
    .filter((l) => !(new RegExp(`^\\s*//.*(${alt})`).test(l)))
    .join('\n');
}

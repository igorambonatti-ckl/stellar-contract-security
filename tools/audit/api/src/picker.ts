import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';

const run = promisify(execFile);

/**
 * Sobe a árvore a partir de um arquivo ou pasta até a raiz do crate.
 *
 * O contrato, para quem escreve, é `src/lib.rs`. Para o `cargo`, é o crate: o
 * `Cargo.toml` com as dependências e as features, e a árvore `src/`. Não dá
 * para compilar um `.rs` solto. Em vez de exigir que o usuário saiba disso e
 * aponte a pasta certa, a ferramenta aceita qualquer um dos dois e resolve.
 *
 * Procura um `Cargo.toml` com seção `[package]` — o `Cargo.toml` da raiz de um
 * workspace só tem `[workspace]`, e parar nele daria o diretório errado.
 */
export async function resolveCrateRoot(inputPath: string): Promise<string> {
  const abs = resolve(inputPath);
  const st = await stat(abs).catch(() => null);
  if (!st) {
    throw Object.assign(new Error(`Caminho não existe: ${abs}`), { status: 400 });
  }

  let dir = st.isDirectory() ? abs : dirname(abs);
  const { root } = parse(dir);

  while (true) {
    const manifest = await readFile(join(dir, 'Cargo.toml'), 'utf8').catch(() => null);
    if (manifest !== null && /^\s*\[package\]/m.test(manifest)) return dir;
    if (dir === root) break;
    dir = dirname(dir);
  }

  throw Object.assign(
    new Error(
      `Nenhum crate encontrado a partir de ${abs}. ` +
      `Subi a árvore até a raiz procurando um Cargo.toml com [package].`,
    ),
    { status: 400 },
  );
}

/**
 * Abre o seletor **nativo do sistema** e devolve a raiz do crate.
 *
 * O seletor do browser não serve: por segurança entrega `File` com nome
 * relativo e jamais o caminho no disco, que é o que a API precisa para abrir o
 * crate. Como esta API roda local, na sessão do usuário, ela pode pedir o
 * diálogo ao sistema — a única forma de transformar "clicar num arquivo" em
 * caminho absoluto.
 *
 * Devolve `null` quando o usuário cancela. Cancelar não é erro.
 */
export async function pickContract(startIn?: string): Promise<string | null> {
  const os = platform();
  let escolhido: string | null = null;

  try {
    if (os === 'darwin') {
      // `choose file` com filtro de tipo, e o Finder ainda deixa navegar até
      // qualquer lugar. Aceita .rs e o próprio Cargo.toml.
      const loc = startIn ? ` default location POSIX file "${startIn}"` : '';
      const script =
        `POSIX path of (choose file with prompt "Escolha o contrato (src/lib.rs) ` +
        `ou o Cargo.toml do crate"${loc} of type {"rs", "toml"})`;
      const { stdout } = await run('osascript', ['-e', script]);
      escolhido = stdout.trim() || null;
    } else if (os === 'linux') {
      const args = ['--file-selection', '--title=Escolha o contrato ou o Cargo.toml'];
      if (startIn) args.push(`--filename=${startIn}/`);
      const { stdout } = await run('zenity', args);
      escolhido = stdout.trim() || null;
    } else if (os === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Filter = 'Rust ou Cargo (*.rs;*.toml)|*.rs;*.toml'
${startIn ? `$d.InitialDirectory = '${startIn}'` : ''}
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }`;
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps]);
      escolhido = stdout.trim() || null;
    } else {
      throw Object.assign(new Error(`Sem seletor nativo para ${os}. Cole o caminho.`), {
        status: 501,
      });
    }
  } catch (e: any) {
    const msg = String(e?.stderr ?? e?.message ?? '');
    // osascript sai com -128 ao cancelar; zenity com 1.
    if (/-128|User canceled/i.test(msg) || e?.code === 1) return null;
    if (e?.status) throw e;
    if (os === 'linux' && /ENOENT/.test(msg)) {
      throw Object.assign(
        new Error('zenity não está instalado. Instale (apt install zenity) ou cole o caminho.'),
        { status: 501 },
      );
    }
    throw Object.assign(new Error(`Não foi possível abrir o seletor: ${msg.slice(0, 200)}`), {
      status: 500,
    });
  }

  if (!escolhido) return null;
  return resolveCrateRoot(escolhido);
}

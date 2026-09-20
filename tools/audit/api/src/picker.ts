import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';

const run = promisify(execFile);

/**
 * Abre o seletor de pasta **nativo do sistema** e devolve o caminho absoluto.
 *
 * O seletor do browser não serve: por segurança ele entrega `File` com nome
 * relativo e jamais o caminho no disco, que é exatamente o que a API precisa
 * para abrir o crate. Como esta API roda local, na sessão do usuário, ela pode
 * pedir o diálogo ao sistema operacional — que é a única forma de transformar
 * "clicar numa pasta" em um caminho absoluto.
 *
 * Devolve `null` quando o usuário cancela. Cancelar não é erro.
 */
export async function pickFolder(startIn?: string): Promise<string | null> {
  const os = platform();

  try {
    if (os === 'darwin') {
      const prompt = 'Escolha a pasta do crate Soroban';
      const script = startIn
        ? `POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${startIn}")`
        : `POSIX path of (choose folder with prompt "${prompt}")`;
      const { stdout } = await run('osascript', ['-e', script]);
      return stdout.trim().replace(/\/$/, '') || null;
    }

    if (os === 'linux') {
      const args = ['--file-selection', '--directory', '--title=Escolha a pasta do crate Soroban'];
      if (startIn) args.push(`--filename=${startIn}/`);
      const { stdout } = await run('zenity', args);
      return stdout.trim() || null;
    }

    if (os === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
${startIn ? `$d.SelectedPath = '${startIn}'` : ''}
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`;
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps]);
      return stdout.trim() || null;
    }
  } catch (e: any) {
    // osascript sai com -128 quando o usuário cancela; zenity com 1.
    const msg = String(e?.stderr ?? e?.message ?? '');
    if (/-128|User canceled/i.test(msg) || e?.code === 1) return null;

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

  throw Object.assign(new Error(`Sem seletor nativo para ${os}. Cole o caminho.`), { status: 501 });
}

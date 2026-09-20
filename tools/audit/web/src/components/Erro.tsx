import { AlertTriangle } from 'lucide-react';

/** O texto vem do servidor. Erros aqui dizem o que fazer, não "algo deu errado". */
export function Erro({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="flex gap-3 items-start rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
      <p className="text-sm text-red-700 leading-relaxed whitespace-pre-wrap">{msg}</p>
    </div>
  );
}

/**
 * OpenRouter client.
 *
 * Deliberately thin: one call, no retry-on-anything, and a hard failure when the
 * key is absent rather than a silent fallback. A tool that quietly degrades to
 * "no AI step ran" would report an empty invariant list as a result, which is
 * exactly the class of quiet wrong answer this project spent its time chasing.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface CompletionOptions {
  system: string;
  user: string;
  /** Overrides OPENROUTER_MODEL for one call. */
  model?: string;
  maxTokens?: number;
}

export function isConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function currentModel(): string {
  return process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';
}

export async function complete(
  opts: CompletionOptions,
): Promise<{ text: string; model: string; usage?: { entrada: number; saida: number } }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw Object.assign(
      new Error(
        'OPENROUTER_API_KEY não está definida. Copie api/.env.example para api/.env e preencha a chave.',
      ),
      { status: 503 },
    );
  }

  const model = opts.model || currentModel();
  return chamar(key, model, opts, opts.maxTokens ?? 8000, 0);
}

/**
 * Uma chamada, com uma única retentativa quando o orçamento acabou no meio.
 *
 * Um modelo de raciocínio gasta `max_tokens` pensando antes de escrever: a
 * resposta volta com `finish_reason: "length"`, `content: null` e o texto todo
 * no campo `reasoning`. Isso é indistinguível de "o modelo falhou" se ninguém
 * olhar, e foi lido exatamente assim duas vezes neste projeto — uma vez virou
 * "o deepseek não devolve JSON", outra "o glm não responde". Nos dois casos o
 * teto era meu.
 *
 * A retentativa triplica o orçamento uma vez. Se ainda assim vier truncado, o
 * erro diz o que aconteceu em vez de dizer "sem conteúdo".
 */
async function chamar(
  key: string,
  model: string,
  opts: CompletionOptions,
  maxTokens: number,
  tentativa: number,
): Promise<{ text: string; model: string; usage?: { entrada: number; saida: number } }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter uses these for attribution on its dashboard.
      'HTTP-Referer': 'https://github.com/stellar-studies',
      'X-Title': 'stellar-studies audit',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`OpenRouter respondeu ${res.status}: ${detail.slice(0, 400)}`),
      { status: 502 },
    );
  }

  const json: any = await res.json();
  const escolha = json?.choices?.[0];
  const text: string | undefined = escolha?.message?.content;

  if (!text) {
    const truncado = escolha?.finish_reason === 'length';
    const pensou = (escolha?.message?.reasoning ?? '').length;

    if (truncado && tentativa === 0) {
      return chamar(key, model, opts, Math.min(maxTokens * 3, 64000), 1);
    }
    throw Object.assign(
      new Error(
        truncado
          ? `O modelo consumiu os ${maxTokens} tokens de saída antes de responder` +
            (pensou ? ` (${pensou} caracteres foram para o campo "reasoning")` : '') +
            '. Não é falha do modelo — é o teto de max_tokens.'
          : `Resposta do OpenRouter sem conteúdo: ${JSON.stringify(json).slice(0, 400)}`,
      ),
      { status: 502 },
    );
  }

  const u = json?.usage;
  return {
    text,
    model,
    usage: u ? { entrada: u.prompt_tokens ?? 0, saida: u.completion_tokens ?? 0 } : undefined,
  };
}

/**
 * Pull the first fenced code block out of a model response.
 *
 * Models wrap code in fences even when told not to, and they also narrate
 * around it. Returning the raw text when there is no fence is deliberate: the
 * caller writes it to a file and lets `cargo` be the judge, rather than this
 * function guessing.
 */
export function extractCode(text: string, lang = 'rust'): string {
  const fenced = new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```').exec(text);
  if (fenced) return fenced[1];
  const any = /```\w*\s*\n([\s\S]*?)```/.exec(text);
  if (any) return any[1];
  return text;
}

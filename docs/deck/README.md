# Apresentação

| Arquivo | O que é |
|---|---|
| [`apresentacao.pdf`](apresentacao.pdf) | **O deck**, 13 slides 16:9, em português. Pronto para apresentar. |
| [`slides.html`](slides.html) | A fonte. Editar e re-renderizar com o comando abaixo. |

Marca e tokens vêm do design system do ChainGuard (`apps/web/tailwind.config.js`):
azul `#1B6EF3`, tinta `#0D1117`, textura de grid, cards `rounded-xl`.

## Re-renderizar o PDF

```bash
cd docs/deck
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$(pwd)/apresentacao.pdf" \
  --virtual-time-budget=4000 "file://$(pwd)/slides.html"
```

Os slides são páginas de 1280×720 via `@page`, então o PDF sai exatamente 16:9 sem
margem. Alternativa: abrir `slides.html` no navegador e imprimir para PDF.

## A história em cinco frases

1. Os bugs mais caros de um contrato **não quebram nada**: o saldo para de fechar, o
   admin troca sem permissão, e o contrato segue respondendo. O teste comum não vê,
   porque testa o que o desenvolvedor imaginou.
2. **Fuzzing** sorteia milhares de sequências de operações que ninguém escreveu. É
   ótimo em explorar — e cego para o que não quebra. Para ver um saldo errado ele
   precisa de **regras**, e escrever regras é trabalho de auditor sênior.
3. A ideia: **a IA escreve as regras, o fuzzer verifica.** Cada um no que faz melhor.
4. Medimos com um cofre de sete bugs plantados. Fuzzing sem regras: **1 de 7**. Com as
   regras da IA, sem ninguém no meio: **4 de 7 por execução, 6 de 7 em três** —
   por US$ 0,25 cada.
5. A ferramenta roda numa cópia do contrato, entrega o que falhou com a sequência
   exata, o que passou como testes de regressão, e o diff de tudo que a IA escreveu.
   Está pronta para rodar a cada pull request.

## Números para ter na ponta da língua

| | |
|---|---|
| bugs plantados | 7, cada um atrás de uma chave, cada um viola uma regra |
| fuzzing sem regras | 1/7 |
| IA + fuzzer, sem humano | **4/7** por execução · **6/7** na união de 3 execuções |
| custo de uma auditoria | **US$ 0,25** (grok-4.3, padrão) |
| tempo | 4 a 10 minutos, sozinha |
| uma auditoria típica | ~30 regras propostas, 20+ viram teste, 15+ verificadas |
| onde roda | qualquer crate Soroban; já monta e compila nos exemplos oficiais da Stellar |

Se perguntarem como a IA não "leu a resposta": as sete chaves ficam fora do código que
o modelo recebe, o contrato limpo tem que passar antes de qualquer número, e uma regra
que cite um bug pelo nome invalida a rodada — a ferramenta avisa em vermelho.

## Roteiro, 15 minutos

| Slides | Tempo | Conteúdo |
|---|---|---|
| 1–2 | 2 min | O problema: bugs que não quebram nada |
| 3–4 | 3 min | O que é fuzzing, onde é cego, e a ideia |
| 5–6 | 3 min | Como medimos, e o resultado |
| 7–9 | 4 min | Por dentro, a ferramenta, um exemplo real |
| 10–13 | 3 min | O que muda na prática, próximos passos, o que fica, encerramento |

Se estiver acabando o tempo, o slide 11 (próximos passos) é o primeiro a cortar. O 6
(resultado) e o 9 (o exemplo) não se cortam.

## Demonstração ao vivo

**A ferramenta, em ~5 minutos.** Com a API e a web de pé (`cd tools/audit && npm run dev`),
abrir `localhost:5173` e:

1. **Escolher contrato** → `~/Desktop/soroban-vault-demo/src/lib.rs` (cópia autônoma do cofre, com os 7 bugs atrás de chaves).
2. As sete chaves `bug_*` já aparecem **escondidas do modelo** por padrão.
3. Modelo **grok-4.3** (padrão). **Auditar.** Não há passo humano.
4. ~30 s: regras propostas e revisadas, com a razão de cada rejeição no log.
5. ~4 a 8 min depois: **A investigar / Verificadas / Não verificadas**, o custo real, e **O que a auditoria escreveu** — o diff, com o caminho da cópia em `/tmp`.

Para mostrar o fuzzer pegando um bug ao vivo: desmarcar só `bug_self_transfer` em
**Escondidas do modelo** — o bug entra no contrato compilado e a regra de conservação
aparece em **A investigar** com a sequência mínima que a quebra.

O que também funciona bem em tela:

```bash
# o fuzzer trabalhando — cov:, ft: e corp: subindo em tempo real
cargo +nightly fuzz run --fuzz-dir 04-prototype-development/fuzz \
  --sanitizer none vault_ai -- -max_total_time=60
```

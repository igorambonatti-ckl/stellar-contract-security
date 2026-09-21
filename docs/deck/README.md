# Apresentação

| Arquivo | O que é |
|---|---|
| [`apresentacao.pdf`](apresentacao.pdf) | **O deck**, 20 slides 16:9, em português. Pronto para apresentar. |
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

## Roteiro, 20 minutos

| Slides | Tempo | Conteúdo |
|---|---|---|
| 1–4 | 4 min | Tese, problema, desenho do experimento |
| 5–7 | 5 min | O resultado, e a medição limpa do que a IA acrescenta ao fuzzer |
| 8–11 | 6 min | O que a IA acertou, o que errou, e a surpresa |
| 12–13 | 2 min | O que é específico de Stellar, incluindo o achado negativo |
| 14 | 1 min | Confiabilidade |
| 15–17 | 4 min | **A ferramenta**: o fluxo, quanto vale a curadoria, os limites medidos |
| 18–20 | 2 min | Limitações, o que fica, encerramento |

Se estiver acabando o tempo, os slides 12 e 13 são os primeiros a cortar — são os
mais técnicos e os menos dependentes do resto do arco. O slide 17 (limites da
ferramenta) é o segundo corte; o 16 (quanto vale a curadoria) não se corta, é o
achado.

## Demonstração ao vivo

**A ferramenta, em ~4 minutos.** Com a API e a web de pé (`cd tools/audit && npm run dev`),
abrir `localhost:5173` e:

1. **Escolher contrato** → `~/Desktop/soroban-vault-demo/src/lib.rs` (cópia autônoma do vault, com os 7 bugs atrás de features).
2. Marcar as sete `bug_*` em **Esconder do modelo** — sem isso o modelo lê o gabarito, e a ferramenta avisa em vermelho se você esquecer. Vale mostrar o aviso de propósito.
3. Modelo `gemini-3.1-flash-lite`, modo **Curado**, **Auditar**.
4. ~40 s depois ela para com 6 a 8 invariantes. Desmarcar uma fraca (`saldo >= 0`, por exemplo) e **Testar**.
5. ~2 min depois: **A investigar / Verificadas / Não verificadas**, o custo real no relatório, e **O que a auditoria escreveu** — o diff, com o caminho da cópia em `/tmp`.

Para mostrar o fuzzer pegando um bug ao vivo: rodar a mesma auditoria sem esconder uma
feature (só `bug_self_transfer`, por exemplo) — a propriedade de conservação aparece em
**A investigar** com a sequência mínima que a quebra.

O que também funciona bem em tela, na ordem:

```bash
# 1. o fuzzer trabalhando — cov:, ft: e corp: subindo em tempo real
cargo +nightly fuzz run --fuzz-dir 04-prototype-development/fuzz \
  --sanitizer none vault_ai -- -max_total_time=60

# 2. o arco inteiro em ~2 min: bug plantado -> controle perde -> IA pega -> fix
./04-prototype-development/scripts/demo.sh
```

O relatório visual do resultado está em [`../report/index.html`](../report/index.html).

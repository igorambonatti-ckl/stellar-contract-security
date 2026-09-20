# Apresentação

| Arquivo | O que é |
|---|---|
| [`apresentacao.pdf`](apresentacao.pdf) | **O deck**, 17 slides 16:9, em português. Pronto para apresentar. |
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
| 12–13 | 3 min | O que é específico de Stellar, incluindo o achado negativo |
| 14–17 | 2 min | Confiabilidade, limitações, encerramento |

Se estiver acabando o tempo, os slides 12 e 13 são os primeiros a cortar — são os
mais técnicos e os menos dependentes do resto do arco.

## Demonstração ao vivo

O que funciona bem em tela, na ordem:

```bash
# 1. o fuzzer trabalhando — cov:, ft: e corp: subindo em tempo real
cargo +nightly fuzz run --fuzz-dir 04-prototype-development/fuzz \
  --sanitizer none vault_ai -- -max_total_time=60

# 2. o arco inteiro em ~2 min: bug plantado -> controle perde -> IA pega -> fix
./04-prototype-development/scripts/demo.sh
```

O relatório visual do resultado está em [`../report/index.html`](../report/index.html).

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

## A história em cinco frases

1. Fuzzing encontra o que **quebra**. O que este projeto persegue é o que fica
   **errado sem quebrar** — saldo que não fecha, TTL que não estende, admin que
   trocou sem autorização. Para isso o fuzzer precisa de oráculos, e escrever
   oráculos é a parte cara e humana.
2. A tese: **a IA propõe os oráculos, o fuzzer verifica**. Sete bugs plantados
   em um cofre Soroban, cada um violando exatamente uma invariante.
3. Fuzzing cego: **1 de 7**. IA propõe, humano cura, fuzzer verifica: **7 de 7**.
   Mutation score de 34% para 98% — instrumento independente, que não sabe dos bugs.
4. A ferramenta faz isso apontando para qualquer crate, sem passo humano: a IA
   propõe, uma segunda IA cura com o critério do método, o fuzzer monta o rig e
   roda sequências sorteadas. **~3 minutos, centavos**, numa cópia — o
   repositório auditado nunca é tocado.
5. E respondeu uma pergunta que não estava no plano: **sem o humano, satura em
   2 a 5 de 7**. A curadoria vale cinco dos sete bugs — é onde não se automatiza.

## Números para ter na ponta da língua

| | |
|---|---|
| bugs plantados | 7, cada um atrás de uma feature, cada um viola uma invariante |
| fuzzing cego | 1/7 |
| IA + curadoria + fuzzer | **7/7** — 13 de 16 invariantes aceitas (81%) |
| IA + fuzzer, sem humano | 2–5/7 por execução; união de 4 execuções 5/7 |
| mutation score | 34% → 98% |
| cobertura | 85,8% → 96,2% |
| custo de uma auditoria | US$ 0,03 (gemini-3.1-flash-lite) · ~US$ 0,08 (gemini-3.8-flash, padrão) · US$ 1,70 (claude-sonnet-4.5) |
| tempo | ~40 s até a curadoria, ~2 min depois dela |
| erros de medição encontrados e registrados | 6 no benchmark, mais o gabarito vazado e o proptest vazando entre execuções na ferramenta |

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

**A ferramenta, em ~3 minutos.** Com a API e a web de pé (`cd tools/audit && npm run dev`),
abrir `localhost:5173` e:

1. **Escolher contrato** → `~/Desktop/soroban-vault-demo/src/lib.rs` (cópia autônoma do vault, com os 7 bugs atrás de features).
2. As sete `bug_*` já aparecem **escondidas do modelo** por padrão. Vale desmarcar uma de propósito numa segunda rodada para mostrar o aviso vermelho de gabarito vazado — é a resposta pronta para "como você sabe que a IA não leu os bugs?".
3. **Auditar.** Não há passo humano: a IA propõe, uma segunda passada de IA cura com o critério do método (`AUDITING.md` §2), o fuzzer monta o rig e roda.
4. ~40 s: catálogo proposto e curado, com a razão de cada rejeição no log — uma rejeição que nomeia um fato do contrato ("não pode falhar: protocol 23 restaura entradas persistentes") é ela mesma um achado.
5. ~2 min depois: **A investigar / Verificadas / Não verificadas**, o custo real, e **O que a auditoria escreveu** — o diff, com o caminho da cópia em `/tmp`.

Para mostrar o fuzzer pegando um bug ao vivo: desmarcar só `bug_self_transfer` em
**Escondidas do modelo** — o bug entra no fonte compilado e a propriedade de conservação
aparece em **A investigar** com a sequência mínima que a quebra.

O que também funciona bem em tela, na ordem:

```bash
# 1. o fuzzer trabalhando — cov:, ft: e corp: subindo em tempo real
cargo +nightly fuzz run --fuzz-dir 04-prototype-development/fuzz \
  --sanitizer none vault_ai -- -max_total_time=60

# 2. o arco inteiro em ~2 min: bug plantado -> controle perde -> IA pega -> fix
./04-prototype-development/scripts/demo.sh
```

O relatório visual do resultado está em [`../report/index.html`](../report/index.html).

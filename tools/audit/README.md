# Ferramenta de auditoria Soroban

React + API, rodando local. Aponte para **qualquer crate Soroban** no disco e o
pipeline roda em cima dele: inspeção → IA propõe invariantes → **você cura** →
IA gera o harness → compila e roda.

É o loop desenhado no Tópico 3 §4.1, que até agora só existia como prompts
soltos em arquivos markdown.

## Subir

```bash
cd tools/audit
npm install && npm run install:all

cp api/.env.example api/.env     # e preencha OPENROUTER_API_KEY
npm run dev
```

Web em `localhost:5173`, API em `localhost:5174`. O Vite faz proxy de `/api`,
então o browser não vê CORS nem troca de porta.

**Sem a chave a ferramenta sobe e funciona** — inspeção e execução de cargo não
dependem de IA. As duas etapas que dependem retornam 503 com instrução explícita
em vez de falhar em silêncio, e a UI mostra `IA desligada` na barra.

## O fluxo

| Etapa | O que faz | Quem decide |
|---|---|---|
| **1 · Contrato** | Lê o `Cargo.toml`, acha o arquivo com `#[contract]`, extrai entry points de dentro dos blocos `#[contractimpl]`, detecta tiers de storage e `extend_ttl` | — |
| **2 · Invariantes** | O modelo propõe; você aceita ou rejeita uma a uma | **humano** |
| **3 · Harness** | Gera o teste a partir **das invariantes aceitas**, não da proposta inteira, e escreve em `tests/audit_generated.rs` | — |
| **4 · Execução** | Roda `cargo test` / `cargo mutants` com streaming ao vivo | **humano** |

A etapa 2 é o produto. Uma proposta que não vale é pior que uma ausente — queima
tempo de curadoria e vira alarme falso. A ferramenta mostra o yield (aceitas /
propostas) porque esse número é a medida de precisão do modelo.

## Esconder features do modelo

O fonte pode conter as respostas. Se o crate tem features que escondem caminhos
conhecidos — bugs plantados, ramos de debug — marque na etapa 1 e a API resolve
os `cfg` antes de enviar ao modelo.

**É uma transformação textual, não um compilador.** O fluxo de referência
verifica o resultado substituindo-o pelo fonte real e re-rodando a suíte. Confira
antes de confiar.

## Endpoints

```
GET  /api/health              chave presente? qual modelo?
POST /api/inspect             { path } -> ContractInfo
POST /api/clean-view          { path, hiddenFeatures } -> o fonte como o modelo verá
POST /api/ai/invariants       { path, hiddenFeatures } -> proposta + saída bruta
POST /api/ai/inputs           { path } -> prior de entradas
POST /api/ai/harness          { path, invariants } -> código, escrito em tests/
POST /api/run/test            { path, testTarget? } -> { id }
POST /api/run/mutants         { path } -> { id }
GET  /api/runs/:id/stream     SSE, com replay do que já saiu
POST /api/runs/:id/cancel
```

A saída bruta do modelo vem junto da versão estruturada em toda chamada de IA.
Se o JSON não parsear, a UI mostra o texto cru em vez de engolir o erro.

## Limites, explícitos

- **Não roda `cargo-fuzz`.** Precisaria gerar um crate de fuzz e o alvo; a
  ferramenta cobre `cargo test` e `cargo mutants`. O pipeline de fuzzing
  guiado por cobertura está em `04-prototype-development/scripts/`.
- **Não valida o harness gerado antes de escrever.** Ele vai para
  `tests/audit_generated.rs` e o `cargo` é o juiz — que é o desenho, mas
  significa que o arquivo pode não compilar de primeira. Esperado: no benchmark
  deste projeto, 16 de 17 erros de compilação vieram de uma única suposição
  errada sobre o SDK.
- **Escreve dentro do crate que você apontou.** Confira o caminho.

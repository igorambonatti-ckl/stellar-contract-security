# Ferramenta de auditoria Soroban

React + API, rodando local. Aponte para **qualquer crate Soroban** no disco,
clique em Auditar, e o pipeline roda sozinho até o relatório.

```bash
cd tools/audit
npm install && npm run install:all

cp api/.env.example api/.env     # e preencha OPENROUTER_API_KEY
npm run dev
```

Web em `localhost:5173`, API em `localhost:5174`. O Vite faz proxy de `/api`.

## Escolher o contrato

**Escolher contrato** abre o diálogo **nativo do sistema** — Finder no macOS,
zenity no Linux, OpenFileDialog no Windows. Escolha o `src/lib.rs` do contrato,
que é como se pensa nele.

A ferramenta então **sobe a árvore até a raiz do crate**, porque é disso que o
`cargo` precisa: o `Cargo.toml` com dependências e features, e a árvore `src/`.
Não existe compilar um `.rs` solto. Apontar a pasta do crate também funciona —
os dois caminhos chegam no mesmo lugar.

A subida procura um `Cargo.toml` com seção `[package]`. O `Cargo.toml` da raiz
de um workspace só tem `[workspace]`, e parar nele daria o diretório errado:

```
$ escolher .../soroban-vault/src/lib.rs   -> crate soroban-vault, 11 entry points
$ escolher .../stellar-studies/Cargo.toml -> "Nenhum crate encontrado"
```

Isto existe porque o seletor de arquivo do browser não resolve o problema: por
segurança ele entrega `File` com nome relativo e nunca o caminho no disco, que é
exatamente o que a API precisa. Como a API roda local, na sua sessão, ela pode
pedir o diálogo ao sistema operacional.

Contratos já auditados viram atalhos abaixo do campo; clicar num deles roda
direto. Colar o caminho à mão continua funcionando, arquivo ou pasta.

Uma varredura automática do disco foi tentada antes e descartada: além de lenta,
ela confundia a raiz de um workspace com um crate — pelo mesmo motivo acima — e
parava antes de achar os contratos de verdade.

## O pipeline

| # | Etapa | O que faz |
|---|---|---|
| 1 | **Inspecionar** | Lê o `Cargo.toml`, acha o arquivo com `#[contract]`, extrai entry points por brace-matching dos blocos `#[contractimpl]`, detecta tiers de storage e `extend_ttl` |
| 2 | **Propor** | A IA lê o contrato e devolve invariantes em JSON, com a suposição que cada uma assume |
| 3 | **Gerar** | A IA escreve o harness a partir das invariantes, em `tests/audit_generated.rs` |
| 4 | **Compilar** | `cargo test --no-run`. Se não compila, o pipeline segue — a suíte existente ainda diz algo |
| 5 | **Validar** | Roda o harness **contra o contrato como ele é** |
| 6 | **Suíte** | Roda a suíte que já existia |
| 7 | **Relatório** | Propostas, mantidas, descartadas, yield |

## A etapa 5 é o produto

Uma invariante que falha contra o contrato **correto** é falso positivo. Ou a
propriedade não vale, ou o harness a implementou errado — nos dois casos
reportá-la seria acusar bug onde não há evidência.

Então a validação descarta essas sozinha, casando o nome do teste que falhou com
o ID da invariante que ele cita. **A curadoria é feita por execução, não por
alguém clicando.**

Isso importa porque não é hipotético: no benchmark deste repositório, 3 de 16
propostas do modelo estavam erradas — incluindo a que ele enunciou com mais
confiança que todas as outras. Sem esta etapa, as três entrariam no relatório
como achados.

O relatório distingue as duas coisas:

- **descartada** — a invariante falhou contra o contrato correto
- **falha órfã** — um teste falhou sem citar invariante nenhuma, então é sobre o
  harness e não sobre o contrato

## Sem chave

A ferramenta sobe e funciona: inspeção e execução de cargo não dependem de IA.
A etapa 2 falha com a instrução exata em vez de degradar em silêncio, e a barra
mostra `IA desligada`. Uma lista de invariantes vazia reportada como resultado
seria a classe de resposta errada e quieta que este projeto passou o tempo
perseguindo.

## Esconder features do modelo

`POST /api/pipeline` aceita `hiddenFeatures`. O fonte pode conter as respostas —
bugs plantados, ramos de debug — e a API resolve os `cfg` antes de enviar.

**É uma transformação textual, não um compilador.** O fluxo de referência
verifica o resultado substituindo-o pelo fonte real e re-rodando a suíte.

## Endpoints

```
GET  /api/health                  chave presente? qual modelo?
POST /api/pipeline                { path, hiddenFeatures?, runMutants? } -> { id }
GET  /api/pipeline/:id/stream     SSE: snapshot, stage, log, done
GET  /api/pipeline/:id            estado completo
POST /api/pipeline/:id/cancel
POST /api/pipeline/:id/cleanup    apaga o harness gerado do crate

POST /api/inspect                 as etapas soltas, para uso manual
POST /api/clean-view
POST /api/ai/invariants | /ai/inputs | /ai/harness
POST /api/run/test | /run/mutants
GET  /api/runs/:id/stream
```

O SSE faz replay: abrir a página no meio da execução mostra tudo que já passou.

## Limites, explícitos

- **Não roda `cargo-fuzz`.** Precisaria gerar o crate de fuzz e o alvo. O
  pipeline guiado por cobertura está em `04-prototype-development/scripts/`.
- **Escreve dentro do crate que você apontou**, em `tests/audit_generated.rs`.
  O botão de limpeza apaga.
- **A validação casa teste com invariante por nome.** Se o harness gerado não
  citar o ID da invariante no nome do teste, a falha vira órfã em vez de
  descartar a propriedade certa. O prompt pede o ID no nome; modelos às vezes
  não obedecem.
- **Um harness que não compila não invalida o pipeline** — ele segue para a
  suíte existente e reporta. Esperado: no benchmark deste projeto, 16 de 17
  erros de compilação vieram de uma única suposição errada sobre o SDK.

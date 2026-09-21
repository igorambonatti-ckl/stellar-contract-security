# Ferramenta de auditoria Soroban — fuzzing guiado por IA

React + API, rodando local. Aponte para **qualquer crate Soroban** no disco,
clique em Auditar, e o pipeline vai sozinho até o relatório: a IA propõe as
invariantes, uma segunda passada de IA cura o catálogo, o fuzzer monta um rig
de operações e roda sequências sorteadas, e o que falha vem com o
contra-exemplo mínimo.

```bash
cd tools/audit
npm install && npm run install:all

cp api/.env.example api/.env     # e preencha OPENROUTER_API_KEY
npm run dev
```

Web em `localhost:5173`, API em `localhost:5174`. O Vite faz proxy de `/api`.

## O que ela faz, em ordem

| etapa | o que acontece |
|---|---|
| **Inspecionar** | acha o `#[contract]`, lê `src/` inteiro (não só o arquivo do contrato), conta entry points inclusive os de `impl Trait for`, lista features |
| **Copiar** | copia o crate para `/tmp`, resolvendo `workspace = true` e trazendo os perfis do workspace — **o repositório auditado nunca é tocado** |
| **Suíte + proposta** | em paralelo: a suíte existente roda (baseline) enquanto a IA propõe 12 a 20 invariantes, duas vezes, fundidas |
| **Curadoria por IA** | uma segunda passada rejeita o que não pode falhar, o que não se observa, o que é cenário; reescreve o vago |
| **Rig** | fixture, `enum Op` sobre os entry points, `apply` que guarda o retorno de **toda** operação, `Snapshot` com totais, saldos, TTLs, ledger e endereços, estratégia pesada nos extremos e nas bordas de TTL |
| **Asserções** | uma `check(&Rig, &Snapshot, &Op)` por invariante, chamada **depois de cada operação** da sequência — vê estado *e* transição |
| **Compilar** | uma compilação por passada; o compilador diz a linha, o mapa diz de quem é; reparos em paralelo, três tentativas por asserção |
| **Validar** | 256 sequências contra o contrato como ele é; o que falha ganha duas rodadas de reparo; prova de repetição; **o harness entregue compila ou fica vazio** |
| **Relatório** | **A investigar** (com contra-exemplo) · **Verificadas** (suíte de regressão pronta) · **Não verificadas** (com o motivo) · custo real · diff do que a IA escreveu |

Tudo isto acontece na cópia. O diff entre o original e a cópia é parte do
entregável: uma ferramenta que gera código e mostra só o placar pede uma
confiança que não merece.

## Escolher o contrato

**Escolher contrato** abre o diálogo nativo do sistema. Escolha o `src/lib.rs`
do contrato; a ferramenta sobe até a raiz do crate. Apontar a pasta também
funciona.

As **features** do crate ficam **fora do fonte que o modelo recebe**, sempre e
sem botão: um caminho atrás de `#[cfg(feature)]` é quase sempre bug plantado ou
ramo de debug, e mostrá-lo faz o modelo descrever em vez de deduzir. Se uma
invariante citar uma feature pelo nome, a ferramenta avisa em vermelho: aquela
execução não mede nada.

## Modelos

| modelo | custo por auditoria | tempo | observação |
|---|---|---|---|
| **grok-4.3** (padrão) | US$ 0,25–0,56 | 4–10 min | não raciocina antes de responder; escreve uma asserção em ~4 s |
| gemini-3.1-flash-lite | US$ 0,03 | ~3 min | propõe menos (6–8), detecta parecido no benchmark |
| gemini-3.8-flash | US$ 0,60 | ~10 min | o raciocínio é cobrado como saída |
| claude-sonnet-4.5 | US$ 1,70 | ~8 min | compila tudo de primeira |

Preços e tempos **medidos**, não de catálogo. O seletor na tela mostra os dois.

## O benchmark

`04-prototype-development/contracts/soroban-vault` tem sete bugs plantados,
cada um atrás de uma feature, cada um violando exatamente uma invariante. Os
scripts medem quantos o harness gerado pega, **sem nunca ter visto o bug**:

```bash
./ondas-par.sh x-ai/grok-4.3                  # uma auditoria completa + detecção
./ondas-par.sh x-ai/grok-4.3 x-ai/grok-4.3    # duas em paralelo, cópias independentes
./generalidade.sh google/gemini-3.1-flash-lite <lib.rs de terceiro>...
```

Controles que rodam antes de qualquer número: o contrato limpo tem que ficar
verde (senão "não medível"); um harness vazio não conta como 0/7; e uma
invariante que cita um bug pelo nome invalida a execução.

Resultado com o grok, execuções limpas no mesmo dia (4, 2, 4, 3 de 7):

| | detecção |
|---|---|
| fuzzing cego (referência do projeto) | 1/7 |
| **automático, por execução** | **3–4/7** |
| **automático, união de 3 execuções** | **6/7** |
| IA + curadoria humana + fuzzer (referência) | 7/7 |

`overflow` e `missing_auth` — os dois que nenhuma versão anterior detectava —
caem hoje, cada um pela mudança que o diagnóstico apontou: saldos grandes o
bastante para a aritmética estourar, e o retorno da operação sem autorização
disponível ao check. O que falta é `temp_nonce`, que depende de o catálogo
propor a invariante certa.

## Contrato de terceiro

Roda nos exemplos oficiais da Stellar (`timelock`, `token`, `atomic_swap`,
`liquidity_pool`): o rig compila, as asserções compilam, e o que reprova contra
o contrato correto aparece em **A investigar** com a terceira possibilidade
nomeada — o harness pode estar errado. Não há resposta conhecida nesses; um
contrato correto de terceiro deve dar zero achados, e cada achado ali é ou falso
positivo nosso ou bug num exemplo oficial.

## O que é determinístico de propósito

Quase tudo que foi consertado hoje era a camada entre o modelo e o compilador,
não o modelo. Cada item abaixo existe porque custou uma execução:

- **prosa não chega ao compilador** — maior bloco cercado, com tag ou sem; sem cerca, do primeiro `use` à última chave
- **desistência é a ausência de `fn check`**, não uma palavra em algum idioma
- **asserção com chaves que não fecham nunca entra no arquivo** — uma só derrubava as outras onze
- **campo do rig que não existe é alinhado** quando há um único candidato (`r.vault_id` → `r.id`); ambiguidade é do compilador
- **`.storage()` fora de `as_contract` e `.get().unwrap()`** são apontados antes de compilar
- **resposta cortada pelo teto, vazia por 429 ou por `tool_calls`** é retentada
- **execuções independentes**: `failure_persistence: None` no driver — a variável de ambiente que parecia fazer isso não existe
- **o harness entregue compila ou fica vazio** — nunca vermelho por cima de propriedades aprovadas

## Limites honestos

- O rig é o ponto frágil em contrato de terceiro: se `setup()` não deixa o contrato usável, toda operação bate em "não inicializado" e o resultado é um teste verde que não exercitou nada.
- Uma propriedade que falha no contrato correto pode ser o contrato, a invariante ou o harness. A ferramenta não decide; quem audita decide, com o contra-exemplo na mão.
- A curadoria humana ainda vale mais que a automática: 7/7 contra 3–4/7 por execução. A diferença é a medida do que uma pessoa acrescenta, e é o achado mais útil que a ferramenta produziu.

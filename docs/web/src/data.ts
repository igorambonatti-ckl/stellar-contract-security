/** Dados reais do benchmark. Origem: 04-prototype-development/results/ */

export type Verdict = 'pegou' | 'perdeu';

export interface Seed {
  id: string;
  invariante: string;
  controle: Verdict;
  assistido: Verdict;
  nota: string;
}

export const SEEDS: Seed[] = [
  { id: 'bug_overflow', invariante: 'I6', controle: 'perdeu', assistido: 'pegou',
    nota: 'Previu Overflow, veio ZeroShares. O contrato com bug aborta, então is_err() passa.' },
  { id: 'bug_missing_auth', invariante: 'I5', controle: 'perdeu', assistido: 'pegou',
    nota: 'Autorização revogada não rejeitou — e tinha que falhar por auth, não por outro motivo.' },
  { id: 'bug_zero_amount', invariante: 'I7', controle: 'perdeu', assistido: 'pegou',
    nota: 'Pego por uma invariante que ninguém escreveu: o oráculo prevê a razão exata da rejeição.' },
  { id: 'bug_self_transfer', invariante: 'I8, I1', controle: 'perdeu', assistido: 'pegou',
    nota: 'Transferência para si duplicou saldo. Um par (from, to) aleatório nunca colide.' },
  { id: 'bug_no_ttl', invariante: "I10′, N1", controle: 'perdeu', assistido: 'pegou',
    nota: 'Também pego por N1 — invariante nova, que o catálogo original não continha.' },
  { id: 'bug_temp_nonce', invariante: 'I11', controle: 'pegou', assistido: 'pegou',
    nota: 'O único seed que faz o contrato abortar — a única coisa que liveness enxerga.' },
  { id: 'bug_reinit', invariante: 'I9', controle: 'perdeu', assistido: 'pegou',
    nota: 'Um segundo initialize retornou Ok e sobrescreveu o admin.' },
];

export interface Metrica {
  rotulo: string;
  controle: string;
  assistido: string;
  pctControle: number;
  pctAssistido: number;
  nota: string;
}

export const METRICAS: Metrica[] = [
  { rotulo: 'Bugs plantados detectados', controle: '1/7', assistido: '7/7',
    pctControle: 14, pctAssistido: 100,
    nota: 'Mesmo motor, mesmo contrato, mesmo orçamento. A única diferença é o oráculo.' },
  { rotulo: 'Escore de mutação', controle: '34%', assistido: '98%',
    pctControle: 34, pctAssistido: 98,
    nota: 'Instrumento independente: o cargo-mutants não sabe nada dos bugs plantados.' },
  { rotulo: 'Cobertura de regiões', controle: '85,8%', assistido: '96,2%',
    pctControle: 85.8, pctAssistido: 96.2,
    nota: 'Medida sobre a mesma fonte, com llvm-cov.' },
];

export type Severidade = 'refutado' | 'falso-positivo' | 'ferramenta' | 'metodo' | 'soroban' | 'ecossistema';

export interface Achado {
  id: string;
  severidade: Severidade;
  titulo: string;
  corpo: string[];
  codigo?: string;
  desfecho: string;
}

export const ACHADOS: Achado[] = [
  {
    id: 'F-01', severidade: 'refutado',
    titulo: 'A afirmação mais confiante da IA era falsa',
    corpo: [
      'A rodada de priorização de entradas apontou, como "o alvo de truncamento de maior valor do arquivo", que withdraw pode queimar shares e pagar zero. O raciocínio era específico, citava as linhas certas, e foi enunciado com mais confiança que qualquer outra coisa que ela produziu.',
      'É inalcançável. assets ≥ total_shares vale em todo estado alcançável, por indução sobre os quatro mutadores — e com isso o pagamento nunca é zero. O modelo analisou uma expressão localmente e nunca perguntou quais estados são alcançáveis.',
    ],
    desfecho: 'A razão de ela ser falsa virou a invariante N2, hoje asserida em toda execução. Uma hipótese refutada virou invariante mantida.',
  },
  {
    id: 'F-02', severidade: 'falso-positivo',
    titulo: 'Uma falha contábil real que não é reportável',
    corpo: [
      'O fuzzer quebrou o contrato limpo: deposit(from = vault) cunha shares contra uma transferência de token do cofre para ele mesmo, que deixa o saldo intacto. Valor criado do nada.',
      'A assimetria é real. Também é inalcançável on-chain: nenhum chamador externo forja a autorização do próprio contrato. O caminho só existia porque o harness mockava toda autorização — um falso vermelho fabricado pelo próprio harness.',
    ],
    codigo: `I3 violated by deposit: A1*T0=1000000000000000000 < A0*T1=1000000066000000000
                        (A0=1000000000 T0=1000000000 A1=1000000000 T1=1000000066)`,
    desfecho: 'Endereços de contrato ficam no pool como contraparte, e saem da posição de chamador. Todas as detecções daquela rodada foram descartadas.',
  },
  {
    id: 'F-03', severidade: 'ferramenta',
    titulo: 'Um flag aceito e silenciosamente ignorado',
    corpo: [
      'cargo fuzz --features é aceito pelo cargo-fuzz 0.13.2, nunca repassado ao build subjacente, e não reporta erro. A primeira matriz anunciou que o braço de IA tinha perdido um bug — quando aquele bug nunca tinha sido compilado.',
      'O número era silencioso, plausível e apontava para o lado errado. Só foi pego porque contradizia o resultado de outra camada.',
    ],
    desfecho: 'O runner agora verifica o conjunto de features que o cargo realmente resolveu, e aborta se não for o pedido.',
  },
  {
    id: 'F-04', severidade: 'metodo',
    titulo: 'O braço assistido foi, por um tempo, pior que o controle',
    corpo: [
      'O primeiro alvo guiado por cobertura encontrou 2 de 7 — e perdeu um que o controle grosseiro pegava. Os operandos vinham crus dos bytes do fuzzer, então ele nunca construía estado de múltiplas chamadas; e toda chamada era verificada só no sucesso, então uma operação que abortava indevidamente passava batido.',
      'O conserto foi implementar o terceiro prompt — que tinha sido escrito, executado, commitado na íntegra, e nunca aberto. 2/7 → 7/7.',
    ],
    desfecho: 'Um prompt que é escrito, executado e commitado mas nunca integrado não produz valor e não deixa rastro da própria ausência.',
  },
  {
    id: 'F-05', severidade: 'soroban',
    titulo: 'Contadores de recurso não servem como oráculo de TTL',
    corpo: [
      'Propus dois oráculos "agnósticos de contrato" usando os contadores de recurso do Soroban. O apelo era real: ler o TTL exige saber a chave de storage, o que exige ter lido o contrato. Um oráculo por contador não precisaria de nenhum dos dois.',
      'O host cobra rent ao escrever uma entrada que iria expirar, o contrato tendo pedido ou não. O contador mede o host, não o contrato. O outro candidato, disk_read_entries, conflaciona restauração com leitura de conta clássica e quebrou o contrato limpo em 90 segundos.',
    ],
    codigo: `// contrato LIMPO, depois do TTL decair
deposit   write_entries 7   persist_bumps 6

// bug_no_ttl — remove TODOS os extend_ttl do contrato
deposit   write_entries 8   persist_bumps 6   <- idêntico`,
    desfecho: 'Bug de TTL — a classe mais específica de Soroban que existe — não é verificável em caixa-preta. Guardado como resultado negativo documentado.',
  },
  {
    id: 'F-06', severidade: 'ecossistema',
    titulo: 'Taxonomias de bug do EVM não se portam para Soroban',
    corpo: [
      'overflow-checks vem ligado no template Soroban, então aritmética ingênua aborta em vez de dar wrap. O bug clássico de overflow mal existe aqui e teve que ser plantado com wrapping_mul explícito.',
      'Por outro lado, as duas classes sem análogo no EVM — má gestão de TTL e autoridade lida de um tier que expira — estão ausentes de todo checklist derivado do EVM, e é onde mora o risco real.',
    ],
    desfecho: 'Portar taxonomias de bug do EVM para Soroban sem revisão é um erro de método.',
  },
];

export const LIMITACOES = [
  ['Não é medição de produtividade.', 'Os dois braços foram escritos pelo assistente, então o relógio compara um modelo com ele mesmo. A afirmação que este trabalho não pode fazer é "IA deixa o desenvolvedor mais rápido".'],
  ['Não é resultado estatístico.', 'Um contrato, um modelo, uma rodada por braço. Sem estimativa de variância, sem afirmação de significância.'],
  ['Não é livre de viés de benchmark.', 'O contrato foi construído sob medida em torno do catálogo de invariantes, então o modelo lê um contrato cuja forma já implica as propriedades.'],
  ['Duas propriedades de acesso são mais fracas que o enunciado.', '"Só o titular autorizou" é testado como "ninguém autorizou". Sinalizado pelo próprio modelo no harness dele.'],
];

export const ERROS_MEDICAO = [
  ['--features aceito e ignorado pela ferramenta', 'Contradição entre camadas', '"o braço de IA perdeu um bug"'],
  ['Alvo quebrando o contrato limpo', 'Controle de contrato limpo', '8/8, nenhuma atribuível'],
  ['Asserção nomeando a propriedade errada', 'Ler texto já marcado verde', 'Hipótese já refutada, ressuscitada'],
  ['Oráculo pulando o próprio overflow', 'Rastrear qual asserção pegou', 'Detecção perdida como skip'],
  ['Ledger de curadoria fechando 15 de 16', 'O mesmo rastreio', 'Yield 75% em vez de 81%'],
  ['Script sem bit de execução no git', 'Gate de clone limpo', 'Demo que só roda numa máquina'],
];

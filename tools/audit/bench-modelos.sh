#!/usr/bin/env bash
# Compara modelos no mesmo contrato, com resposta conhecida.
#
#   ./bench-modelos.sh <caminho-do-contrato> [modelo...]
#
# Roda o pipeline inteiro com cada modelo e tabula o que importa: o harness
# compila? em quantas tentativas? quantas invariantes sobrevivem ao contrato
# correto? quanto custou?
#
# A pergunta "qual modelo é bom o bastante" não se responde por intuição nem por
# benchmark de terceiro — se responde rodando a tarefa real. É barato: cada
# execução custa centavos e leva minutos.
set -uo pipefail

API=${API:-http://localhost:5174}
ALVO=${1:?informe o caminho do contrato}
shift

MODELOS=("$@")
if [ ${#MODELOS[@]} -eq 0 ]; then
  MODELOS=(
    deepseek/deepseek-v4-flash
    z-ai/glm-5.3-flash
    qwen/qwen3-coder-next
    minimax/minimax-m2
    moonshotai/kimi-k2-thinking
    anthropic/claude-sonnet-4.5
  )
fi

# Features a esconder do modelo: sem isto ele lê os bugs plantados no fonte e
# escreve invariantes sobre eles, o que mede outra coisa.
ESCONDER='["bug_overflow","bug_missing_auth","bug_zero_amount","bug_self_transfer","bug_no_ttl","bug_temp_nonce","bug_reinit"]'

OUT="$(dirname "$0")/bench-modelos.tsv"
printf 'modelo\tstatus\tpropostas\tcompilou\ttentativas\tmantidas\tdescartadas\tsegundos\ttok_saida\tusd\n' > "$OUT"

# Preços por milhão, do catálogo do OpenRouter.
precos=$(curl -s https://openrouter.ai/api/v1/models \
  | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    p=m.get('pricing') or {}
    try: print(m['id'], float(p['prompt'])*1e6, float(p['completion'])*1e6)
    except: pass")

for M in "${MODELOS[@]}"; do
  echo "=== $M ==="
  # O harness da rodada anterior tem que sair, senão a suíte-baseline da próxima
  # mede o estrago da anterior.
  rm -f "$(dirname "$ALVO")/../tests/audit_generated.rs" 2>/dev/null
  rm -f "$ALVO/tests/audit_generated.rs" 2>/dev/null

  INI=$(date +%s)
  ID=$(curl -s -X POST "$API/api/pipeline" -H 'Content-Type: application/json' \
    -d "{\"path\":\"$ALVO\",\"hiddenFeatures\":$ESCONDER,\"model\":\"$M\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")

  if [ -z "$ID" ]; then echo "  falhou ao iniciar"; continue; fi

  while :; do
    sleep 10
    S=$(curl -s "$API/api/pipeline/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo erro)
    [ "$S" != "rodando" ] && break
    [ $(( $(date +%s) - INI )) -gt 900 ] && { S=timeout; break; }
  done
  FIM=$(date +%s)

  curl -s "$API/api/pipeline/$ID" | MODELO="$M" STATUS="$S" SEG=$((FIM-INI)) PRECOS="$precos" \
    python3 -c "
import json,sys,os
d=json.load(sys.stdin)
st={s['id']:s for s in d['stages']}
rel=st.get('relatorio',{}).get('data') or {}
corr=st.get('corrigir',{})
compilou = st.get('compilar',{}).get('status')=='ok'
tent = (corr.get('data') or {}).get('tentativas', 0 if corr.get('status')=='pulado' else '-')
u=d.get('usage') or {}
pin=pout=0.0
for linha in os.environ['PRECOS'].splitlines():
    p=linha.split()
    if p and p[0]==os.environ['MODELO']: pin,pout=float(p[1]),float(p[2])
usd = u.get('entrada',0)/1e6*pin + u.get('saida',0)/1e6*pout
row=[os.environ['MODELO'], os.environ['STATUS'], rel.get('propostas', st.get('propor',{}).get('data',{}).get('invariants') and len(st['propor']['data']['invariants']) or 0),
     'sim' if compilou else 'nao', tent, rel.get('mantidas','-'), rel.get('descartadas','-'),
     os.environ['SEG'], u.get('saida',0), f'{usd:.4f}']
print('\t'.join(str(x) for x in row))" >> "$OUT"

  tail -1 "$OUT" | sed 's/^/  /'
done

echo
column -t -s $'\t' "$OUT"

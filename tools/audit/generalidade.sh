#!/usr/bin/env bash
# A ferramenta funciona em contratos que não são os desta casa?
#
#   ./generalidade.sh <modelo> <caminho-do-lib.rs> [caminho...]
#
# `ondas.sh` mede detecção contra sete bugs plantados, e só o soroban-vault os
# tem. Isso torna o número forte e a amostra de um. Um prompt ajustado até
# acertar sete bugs conhecidos num contrato conhecido é indistinguível de um
# prompt bom — até rodar em outro contrato.
#
# Aqui não há resposta conhecida, então não se mede detecção. Mede-se o que dá
# para medir sem ela: o pipeline chega ao fim? o harness compila? fica verde
# contra o contrato como ele é? quantas propriedades sobrevivem? Um contrato
# correto de terceiro **deve** dar zero achados — se der vermelho, ou é falso
# positivo nosso, ou é um bug de verdade num exemplo oficial, e os dois casos
# merecem ser olhados.
set -uo pipefail

API=${API:-http://localhost:5174}
# Modo automático explícito: sem isso o pipeline entra em curadoria e fica
# parado esperando um humano que este script não tem. O default do produto é
# curado — um medidor não pode herdar o default de ninguém.
RAIZ=$(cd "$(dirname "$0")" && pwd)
MODELO=${1:?informe o modelo}
shift

OUT="$RAIZ/generalidade.tsv"
DET="$RAIZ/ondas-detalhe"
mkdir -p "$DET"
printf 'contrato\tcrate\tentry\tstatus\tpropostas\tcompilam\treparados\tmantidas\tverde\tseg\tusd\n' > "$OUT"

precos=$(curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    p=m.get('pricing') or {}
    try: print(m['id'], float(p['prompt'])*1e6, float(p['completion'])*1e6)
    except: pass")

for ALVO in "$@"; do
  NOME=$(basename "$(dirname "$(dirname "$ALVO")")")
  echo "════════ $NOME ════════"
  INI=$(date +%s)

  ID=$(curl -s -X POST "$API/api/pipeline" -H 'Content-Type: application/json' \
    -d "{\"path\":\"$ALVO\",\"hiddenFeatures\":[],\"model\":\"$MODELO\",\"modo\":\"automatico\"}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id') or 'ERRO:'+str(d.get('error'))[:120])")

  case "$ID" in
    ERRO:*) echo "  $ID"; printf '%s\t-\t-\t%s\t-\t-\t-\t-\t-\t-\t-\n' "$NOME" "${ID#ERRO:}" >> "$OUT"; continue ;;
    '')     echo "  não iniciou"; continue ;;
  esac
  echo "  pipeline $ID"

  while :; do
    sleep 15
    S=$(curl -s "$API/api/pipeline/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo erro)
    [ "$S" != "rodando" ] && break
    if [ $(( $(date +%s) - INI )) -gt 2400 ]; then
      curl -s -X POST "$API/api/pipeline/$ID/cancel" >/dev/null; S=timeout; break
    fi
  done
  FIM=$(date +%s)

  curl -s "$API/api/pipeline/$ID" > "$DET/gen-$NOME.json"
  CRATE_DIR=$(dirname "$(dirname "$ALVO")")
  [ -f "$CRATE_DIR/tests/audit_generated.rs" ] && cp "$CRATE_DIR/tests/audit_generated.rs" "$DET/gen-$NOME.rs"

  cat "$DET/gen-$NOME.json" | NOME="$NOME" ST="$S" SEG=$((FIM-INI)) M="$MODELO" P="$precos" python3 -c "
import json,sys,os
d=json.load(sys.stdin)
st={s['id']:s for s in d['stages']}
def dat(k): return (st.get(k,{}).get('data') or {})
rel=dat('relatorio'); u=d.get('usage') or {}
pin=pout=0.0
for l in os.environ['P'].splitlines():
    q=l.split()
    if q and q[0]==os.environ['M']: pin,pout=float(q[1]),float(q[2])
usd=u.get('entrada',0)/1e6*pin+u.get('saida',0)/1e6*pout
comp=st.get('compilar',{})
verde='sim' if st.get('validar',{}).get('status')=='ok' and dat('validar').get('descartadas',1)==0 else 'nao'
print('\t'.join(str(x) for x in [
  os.environ['NOME'], (dat('inspecionar') or {}).get('crateName','-'),
  len((dat('inspecionar') or {}).get('entryPoints') or []), os.environ['ST'],
  rel.get('propostas','-'), (comp.get('detail') or '-').split(' ')[0],
  dat('compilar').get('reparados','-'), rel.get('mantidas','-'), verde,
  os.environ['SEG'], f'{usd:.4f}']))" >> "$OUT"

  tail -1 "$OUT" | sed 's/^/  /'

  # Desfaz o que a ferramenta escreveu: o Cargo.toml e o harness são de outra
  # pessoa, e um clone sujo faz a próxima execução medir o lixo da anterior.
  curl -s -X POST "$API/api/pipeline/$ID/cleanup" >/dev/null
done

echo
column -t -s $'\t' "$OUT"

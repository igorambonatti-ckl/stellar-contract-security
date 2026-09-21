#!/usr/bin/env bash
# Vários modelos ao mesmo tempo, cada um na sua cópia do contrato.
#
#   ./ondas-par.sh <modelo> [modelo...]
#
# `ondas.sh` roda em série e uma comparação de quatro modelos leva horas — quase
# todas gastas esperando o `cargo`, não os modelos. O que impedia o paralelismo
# eram duas coisas, ambas do lado da infraestrutura:
#
#   1. todas as execuções escreviam o mesmo `tests/audit_generated.rs`;
#   2. todas disputavam o lock do `target/` do workspace.
#
# A saída é uma cópia do crate por modelo, cada uma com seu próprio diretório de
# build. As cópias entram como membros do workspace (`*/contracts/*`), levam os
# mesmos sete bugs plantados atrás das mesmas features, e são descartáveis.
set -uo pipefail

API=${API:-http://localhost:5174}
# O benchmark mede o modo automático por padrão; MODO=curado exige um humano.
MODO=${MODO:-automatico}
RAIZ=$(cd "$(dirname "$0")" && pwd)
ORIG=${VAULT:-/Users/igorfambonatti/dev/stellar-studies/04-prototype-development/contracts/soroban-vault}
CONTRACTS=$(dirname "$ORIG")

BUGS=(bug_overflow bug_missing_auth bug_zero_amount bug_self_transfer
      bug_no_ttl bug_temp_nonce bug_reinit)
ESCONDER="[$(printf '"%s",' "${BUGS[@]}" | sed 's/,$//')]"

OUT="$RAIZ/ondas.tsv"
DET="$RAIZ/ondas-detalhe"
mkdir -p "$DET"
[ -f "$OUT" ] || printf 'modelo\tstatus\tpropostas\tcompilam\treparados\tdescartados\tmantidas\tdetectados\tquais\tseg\tusd\n' > "$OUT"

precos=$(curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    p=m.get('pricing') or {}
    try: print(m['id'], float(p['prompt'])*1e6, float(p['completion'])*1e6)
    except: pass")

# ── Uma auditoria completa, numa cópia só dela ────────────────────────────────
rodar() {
  local M="$1" N="$2"
  local SLUG; SLUG=$(echo "$M" | tr '/:.' '___')-$N
  local CRATE="soroban-vault-$N"
  local DIR="$CONTRACTS/$CRATE"

  rm -rf "$DIR"
  mkdir -p "$DIR"
  cp -R "$ORIG/src" "$DIR/src"
  # `tests/` fica de fora de propósito: os testes de integração do original
  # importam `soroban_vault::` pelo nome e não compilariam na cópia. Os testes
  # unitários em `src/` vêm junto e bastam como suíte-baseline.
  sed "s/^name = \"soroban-vault\"/name = \"$CRATE\"/" "$ORIG/Cargo.toml" > "$DIR/Cargo.toml"

  local INI FIM ID S
  INI=$(date +%s)
  ID=$(curl -s -X POST "$API/api/pipeline" -H 'Content-Type: application/json' \
    -d "{\"path\":\"$DIR/src/lib.rs\",\"hiddenFeatures\":$ESCONDER,\"model\":\"$M\",\"modo\":\"${MODO:-automatico}\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
  [ -z "$ID" ] && { echo "[$N $M] não iniciou"; return; }
  echo "[$N $M] pipeline $ID"

  while :; do
    sleep 20
    S=$(curl -s "$API/api/pipeline/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo erro)
    [ "$S" != "rodando" ] && break
    [ $(( $(date +%s) - INI )) -gt 2400 ] && { curl -s -X POST "$API/api/pipeline/$ID/cancel" >/dev/null; S=timeout; break; }
  done
  FIM=$(date +%s)
  curl -s "$API/api/pipeline/$ID" > "$DET/$SLUG.json"

  local HARNESS="$DIR/tests/audit_generated.rs"
  local DETECTADOS=0 QUAIS=""
  if [ ! -f "$HARNESS" ] || ! grep -q "fn .*_sequencia" "$HARNESS"; then
    echo "[$N $M] harness sem nenhum teste — nada a medir"
    QUAIS="sem-testes"; DETECTADOS=-1
  elif ! (cd "$DIR" && CARGO_TARGET_DIR="$DIR/.audit-target" PROPTEST_CASES=64 \
          PROPTEST_FAILURE_PERSISTENCE=off cargo test -p "$CRATE" --test audit_generated \
          > "$DET/$SLUG.limpo.out" 2>&1); then
    echo "[$N $M] ✗✗ vermelho contra o contrato LIMPO — não medível"
    QUAIS="baseline-vermelha"; DETECTADOS=-1
  else
    for B in "${BUGS[@]}"; do
      if ! (cd "$DIR" && CARGO_TARGET_DIR="$DIR/.audit-target" PROPTEST_CASES=64 \
            PROPTEST_FAILURE_PERSISTENCE=off cargo test -p "$CRATE" --features "$B" \
            --test audit_generated > "$DET/$SLUG.$B.out" 2>&1); then
        DETECTADOS=$((DETECTADOS+1)); QUAIS="$QUAIS${QUAIS:+,}${B#bug_}"
        echo "[$N $M] ✓ $B"
      fi
    done
    [ "$DETECTADOS" -eq 0 ] && echo "[$N $M] nenhum dos 7"
  fi
  cp "$HARNESS" "$DET/$SLUG.rs" 2>/dev/null

  cat "$DET/$SLUG.json" | MODELO="$M" STATUS="$S" SEG=$((FIM-INI)) DET="$DETECTADOS" \
    QUAIS="$QUAIS" PRECOS="$precos" python3 -c "
import json,sys,os
d=json.load(sys.stdin)
st={s['id']:s for s in d['stages']}
def dat(k): return (st.get(k,{}).get('data') or {})
rel=dat('relatorio'); u=d.get('usage') or {}
pin=pout=0.0
for l in os.environ['PRECOS'].splitlines():
    q=l.split()
    if q and q[0]==os.environ['MODELO']: pin,pout=float(q[1]),float(q[2])
usd=u.get('entrada',0)/1e6*pin+u.get('saida',0)/1e6*pout
comp=st.get('compilar',{})
print('\t'.join(str(x) for x in [
  os.environ['MODELO'], os.environ['STATUS'], rel.get('propostas','-'),
  (comp.get('detail') or '-').split(' ')[0] if comp.get('status')=='ok' else '0',
  dat('compilar').get('reparados','-'), dat('compilar').get('descartadosCompilacao','-'),
  rel.get('mantidas','-'), os.environ['DET']+'/7', os.environ['QUAIS'] or '-',
  os.environ['SEG'], f'{usd:.4f}']))" >> "$OUT"

  # A cópia some; os artefatos ficam em ondas-detalhe/.
  rm -rf "$DIR"
  echo "[$N $M] fim"
}

N=0
for M in "$@"; do
  N=$((N+1))
  rodar "$M" "$N" &
done
wait

echo
column -t -s $'\t' "$OUT"

#!/usr/bin/env bash
# Ondas: roda a auditoria com vários modelos e mede o que importa de verdade.
#
#   ./ondas.sh <modelo> [modelo...]
#
# O benchmark anterior media "a invariante sobrevive ao contrato correto", que é
# *ausência de falso positivo* — necessário, mas não é evidência positiva. Um
# harness vazio tem yield perfeito por esse critério.
#
# A evidência positiva deste projeto já existe: os sete bugs plantados em P3,
# cada um atrás de uma feature, cada um violando exatamente uma invariante. Se o
# harness que um modelo barato escreveu pega N deles, isso é uma detecção
# atribuível contra resposta conhecida — e é o mesmo número que o braço de
# referência reporta (7/7 curado, 1/7 fuzzing cego).
#
# Uma onda = um modelo. Cada onda deixa a linha no TSV mesmo se falhar, porque
# uma falha medida também é resultado.
set -uo pipefail

API=${API:-http://localhost:5174}
RAIZ=$(cd "$(dirname "$0")" && pwd)
VAULT=${VAULT:-/Users/igorfambonatti/dev/stellar-studies/04-prototype-development/contracts/soroban-vault}
ALVO="$VAULT/src/lib.rs"
HARNESS="$VAULT/tests/audit_generated.rs"

BUGS=(bug_overflow bug_missing_auth bug_zero_amount bug_self_transfer
      bug_no_ttl bug_temp_nonce bug_reinit)

ESCONDER=$(printf '"%s",' "${BUGS[@]}" | sed 's/,$//')
ESCONDER="[$ESCONDER]"

OUT="$RAIZ/ondas.tsv"
DETALHE="$RAIZ/ondas-detalhe"
mkdir -p "$DETALHE"
[ -f "$OUT" ] || printf 'modelo\tstatus\tpropostas\tcompilam\treparados\tdescartados\tmantidas\tdetectados\tquais\tseg\tusd\n' > "$OUT"

precos=$(curl -s https://openrouter.ai/api/v1/models | python3 -c "
import json,sys
for m in json.load(sys.stdin)['data']:
    p=m.get('pricing') or {}
    try: print(m['id'], float(p['prompt'])*1e6, float(p['completion'])*1e6)
    except: pass")

# Numera as repetições. Rodar o mesmo modelo três vezes sobrescrevia os
# artefatos das duas primeiras, e a execução interessante é sempre uma das que
# se perdeu — aconteceu três vezes nesta série antes de eu consertar isto.
N=0
for M in "$@"; do
  N=$((N+1))
  echo "════════ onda $N: $M ════════"
  rm -f "$HARNESS"
  # O proptest grava as entradas que falharam ao lado do teste e as reexecuta
  # na rodada seguinte. O arquivo acumulava sementes de ondas anteriores, com
  # formas de `Op` de rigs que não existem mais, e reprovava harnesses que a
  # validação tinha acabado de aprovar. Cada onda começa limpa.
  rm -f "$VAULT"/tests/audit_generated.proptest-regressions
  INI=$(date +%s)

  ID=$(curl -s -X POST "$API/api/pipeline" -H 'Content-Type: application/json' \
    -d "{\"path\":\"$ALVO\",\"hiddenFeatures\":$ESCONDER,\"model\":\"$M\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")

  if [ -z "$ID" ]; then echo "  não iniciou"; continue; fi
  echo "  pipeline $ID"

  while :; do
    sleep 15
    S=$(curl -s "$API/api/pipeline/$ID" | python3 -c "
import json,sys
p=json.load(sys.stdin); print(p['status'])
import os" 2>/dev/null || echo erro)
    [ "$S" != "rodando" ] && break
    if [ $(( $(date +%s) - INI )) -gt 2400 ]; then
      curl -s -X POST "$API/api/pipeline/$ID/cancel" >/dev/null; S=timeout; break
    fi
  done
  FIM=$(date +%s)

  SLUG_J=$(echo "$M" | tr '/' '_')-$N
  curl -s "$API/api/pipeline/$ID" > "$DETALHE/$SLUG_J.json"

  # ── O braço de detecção ────────────────────────────────────────────────────
  # O harness ficou no crate. Para cada bug plantado, liga a feature e vê se
  # algum teste fica vermelho. Uma falha aqui é a evidência positiva: o harness
  # que o modelo escreveu, sem nunca ter visto o bug, o encontrou.
  #
  # O controle limpo vem primeiro e é eliminatório. Um teste que já falha
  # contra o contrato correto falha contra qualquer versão dele, então um
  # harness vermelho de nascença marca os sete bugs e não detectou nenhum. A
  # primeira medição deste braço reportou 7/7 exatamente assim — com cinco
  # testes que falhavam sozinhos. Sem esta porta, o número é indistinguível de
  # uma detecção real.
  DETECTADOS=0; QUAIS=""; SLUG=$(echo "$M" | tr '/' '_')-$N
  # Um harness vazio passa no controle limpo — não há o que falhar — e sai como
  # "0/7", indistinguível de um harness que rodou e não achou nada. São coisas
  # diferentes: um mediu e não encontrou, o outro não mediu.
  if [ ! -f "$HARNESS" ] || ! grep -q "fn .*_sequencia" "$HARNESS"; then
    echo "    harness sem nenhum teste — nada a medir"
    QUAIS="sem-testes"; DETECTADOS=-1
  elif ! (cd "$VAULT" && PROPTEST_CASES=64 PROPTEST_FAILURE_PERSISTENCE=off cargo test -p soroban-vault \
          --test audit_generated > "$DETALHE/$SLUG.limpo.out" 2>&1); then
    echo "    ✗✗ o harness falha contra o contrato LIMPO — detecção não medível"
    QUAIS="baseline-vermelha"; DETECTADOS=-1
  else
    for B in "${BUGS[@]}"; do
      if ! (cd "$VAULT" && PROPTEST_CASES=64 PROPTEST_FAILURE_PERSISTENCE=off cargo test -p soroban-vault \
            --features "$B" --test audit_generated > "$DETALHE/$SLUG.$B.out" 2>&1); then
        DETECTADOS=$((DETECTADOS+1))
        # Qual teste ficou vermelho — uma detecção que não se atribui a uma
        # invariante não é uma detecção, é um harness instável.
        QUEM=$(grep -oE '^\s{4}[a-z0-9_]+::[a-z0-9_]+$' "$DETALHE/$SLUG.$B.out" | tr -d ' ' | paste -sd, -)
        QUAIS="$QUAIS${QUAIS:+,}${B#bug_}"
        echo "    ✓ pegou $B  ← ${QUEM:-?}"
      else
        echo "    ✗ passou $B"
      fi
    done
  fi
  [ -f "$HARNESS" ] && cp "$HARNESS" "$DETALHE/$SLUG.rs"

  cat "$DETALHE/$SLUG_J.json" \
    | MODELO="$M" STATUS="$S" SEG=$((FIM-INI)) DET="$DETECTADOS" QUAIS="$QUAIS" PRECOS="$precos" python3 -c "
import json,sys,os
d=json.load(sys.stdin)
st={s['id']:s for s in d['stages']}
def dat(k): return (st.get(k,{}).get('data') or {})
rel=dat('relatorio')
u=d.get('usage') or {}
pin=pout=0.0
for l in os.environ['PRECOS'].splitlines():
    q=l.split()
    if q and q[0]==os.environ['MODELO']: pin,pout=float(q[1]),float(q[2])
usd=u.get('entrada',0)/1e6*pin+u.get('saida',0)/1e6*pout
comp=st.get('compilar',{})
n_comp=(comp.get('detail') or '').split(' ')[0] if comp.get('status')=='ok' else '0'
print('\t'.join(str(x) for x in [
  os.environ['MODELO'], os.environ['STATUS'], rel.get('propostas','-'), n_comp,
  dat('compilar').get('reparados','-'), dat('compilar').get('descartadosCompilacao','-'),
  rel.get('mantidas','-'), os.environ['DET']+'/7', os.environ['QUAIS'] or '-',
  os.environ['SEG'], f'{usd:.4f}']))" >> "$OUT"

  tail -1 "$OUT" | sed 's/^/  /'
done

echo
column -t -s $'\t' "$OUT"

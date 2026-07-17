#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-pre-commit}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "Erro: nao foi possivel localizar o repositorio git."
  exit 2
fi

cd "${ROOT}"

CODEX_BIN="${CODEX_BIN:-}"
if [[ -z "${CODEX_BIN}" ]]; then
  if command -v codex >/dev/null 2>&1; then
    CODEX_BIN="$(command -v codex)"
  elif [[ -d "${HOME}/.vscode/extensions" ]]; then
    CODEX_BIN="$(find "${HOME}/.vscode/extensions" -type f -name codex -perm -111 2>/dev/null | head -n1)"
  fi
fi

if [[ -z "${CODEX_BIN}" ]]; then
  echo "Erro: codex CLI nao encontrado no PATH."
  echo "Dica: defina CODEX_BIN com o caminho absoluto do executavel."
  exit 2
fi

CONFIG_FILE="codex.config.json"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Erro: ${CONFIG_FILE} nao encontrado."
  exit 2
fi

SCHEMA_FILE="tools/codex/security-output.schema.json"
PROMPT_FILE="tools/codex/prompts/${MODE}.txt"

if [[ ! -f "${SCHEMA_FILE}" ]]; then
  echo "Erro: schema de saida nao encontrado em ${SCHEMA_FILE}."
  exit 2
fi

if [[ ! -f "${PROMPT_FILE}" ]]; then
  echo "Erro: prompt nao encontrado para o modo ${MODE}."
  exit 2
fi

DIFF=""
SUMMARY_FILES=""
SUMMARY_STATS=""
case "${MODE}" in
  pre-commit)
    DIFF="$(git diff --cached --patch --no-color)"
    SUMMARY_FILES="$(git diff --cached --name-status --no-color)"
    SUMMARY_STATS="$(git diff --cached --stat --no-color)"
    ;;
  pre-push)
    if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
      DIFF="$(git diff --patch --no-color "@{u}...HEAD")"
      SUMMARY_FILES="$(git diff --name-status --no-color "@{u}...HEAD")"
      SUMMARY_STATS="$(git diff --stat --no-color "@{u}...HEAD")"
    else
      DIFF="$(git diff --cached --patch --no-color)"
      SUMMARY_FILES="$(git diff --cached --name-status --no-color)"
      SUMMARY_STATS="$(git diff --cached --stat --no-color)"
    fi
    ;;
  ci-fast|ci-deep)
    BASE_REF="${BASE_REF:-}"
    if [[ -n "${BASE_REF}" ]]; then
      DIFF="$(git diff --patch --no-color "${BASE_REF}...HEAD")"
      SUMMARY_FILES="$(git diff --name-status --no-color "${BASE_REF}...HEAD")"
      SUMMARY_STATS="$(git diff --stat --no-color "${BASE_REF}...HEAD")"
    else
      DIFF="$(git diff --patch --no-color "HEAD~1...HEAD" 2>/dev/null || true)"
      SUMMARY_FILES="$(git diff --name-status --no-color "HEAD~1...HEAD" 2>/dev/null || true)"
      SUMMARY_STATS="$(git diff --stat --no-color "HEAD~1...HEAD" 2>/dev/null || true)"
    fi
    ;;
  *)
    echo "Erro: modo invalido ${MODE}."
    exit 2
    ;;
esac

if [[ -z "${DIFF}" ]]; then
  echo "Sem diff para analisar."
  exit 0
fi

MAX_CHARS=900000
if [[ "${#DIFF}" -gt "${MAX_CHARS}" ]]; then
  echo "Aviso: diff muito grande (${#DIFF} chars). Usando resumo para evitar limite do Codex."
  FILES_CHANGED="${SUMMARY_FILES}"
  STATS="${SUMMARY_STATS}"
  DIFF="RESUMO_DIFF_INICIO
${STATS}

ARQUIVOS_ALTERADOS
${FILES_CHANGED}
RESUMO_DIFF_FIM"
fi

OUTPUT_FILE="$(mktemp)"

{
  cat "${PROMPT_FILE}"
  echo ""
  echo "DIFF_INICIO"
  echo "${DIFF}"
  echo "DIFF_FIM"
} | "${CODEX_BIN}" exec --output-schema "${SCHEMA_FILE}" --output-last-message "${OUTPUT_FILE}" - >/dev/null

if [[ ! -s "${OUTPUT_FILE}" ]]; then
  echo "Erro: codex nao retornou resultado."
  exit 2
fi

SEVERITY="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(j.severity||'none');" "${OUTPUT_FILE}")"
RESULT="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(j.result||'pass');" "${OUTPUT_FILE}")"

BLOCK_LIST="$(node -e "\
const cfg=require('./codex.config.json');\
const mode=process.argv[1];\
let block=[];\
if (mode==='pre-commit') {\
  if (cfg.hooks && cfg.hooks.pre_commit && cfg.hooks.pre_commit.block_on_critical) {\
    block=['critical'];\
  }\
} else if (mode==='pre-push') {\
  if (cfg.hooks && cfg.hooks.pre_push && cfg.hooks.pre_push.block_on) {\
    block=cfg.hooks.pre_push.block_on;\
  } else if (cfg.ci && cfg.ci.fail_on) {\
    block=cfg.ci.fail_on;\
  }\
} else {\
  if (cfg.ci && cfg.ci.fail_on) {\
    block=cfg.ci.fail_on;\
  }\
}\
process.stdout.write(Array.isArray(block)?block.join(','):'');\
" "${MODE}")"

echo "Codex Security: result=${RESULT} severity=${SEVERITY}"
echo "Relatorio completo em: ${OUTPUT_FILE}"

if [[ "${RESULT}" == "fail" ]]; then
  if [[ -n "${BLOCK_LIST}" ]]; then
    IFS=',' read -r -a BLOCKS <<< "${BLOCK_LIST}"
    for b in "${BLOCKS[@]}"; do
      if [[ "${SEVERITY}" == "${b}" ]]; then
        echo "Bloqueado por severidade: ${SEVERITY}"
        exit 1
      fi
    done
  fi
fi

exit 0

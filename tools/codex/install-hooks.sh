#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "Erro: nao foi possivel localizar o repositorio git."
  exit 2
fi

cd "${ROOT}"

chmod +x tools/codex/run-security-check.sh
chmod +x .githooks/pre-commit
chmod +x .githooks/pre-push

git config core.hooksPath .githooks

echo "Hooks instalados em .githooks"

#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-nail-ar-mvp}"

command -v gh >/dev/null || { echo "缺少 gh，请先安装 GitHub CLI" >&2; exit 1; }
command -v vercel >/dev/null || { echo "缺少 vercel，请先安装 Vercel CLI" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 未登录：运行 gh auth login" >&2; exit 1; }
vercel whoami >/dev/null 2>&1 || { echo "Vercel 未登录：运行 vercel login" >&2; exit 1; }

npm install
npm run build

git init -b main
git add .
git commit -m "feat: initial nail AR try-on MVP" || true
if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
else
  git push -u origin main
fi

URL="$(vercel --prod --yes 2>&1 | tee /dev/stderr | grep -Eo 'https://[^[:space:]]+' | tail -n 1)"
echo "Production URL: ${URL:-请从上方 Vercel 输出复制 HTTPS 地址}"

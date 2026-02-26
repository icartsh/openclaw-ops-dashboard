#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$HOME/obsidian-vault}"
OUT_DIR="$VAULT_DIR/Worklog/OpenClaw Dashboard"
REPO_DIR="${REPO_DIR:-$HOME/openclaw-ops-dashboard}"

DATE_KST="$(TZ=Asia/Seoul date +%F)"
NOW_KST="$(TZ=Asia/Seoul date '+%F %R %Z')"

mkdir -p "$OUT_DIR"

OUT_FILE="$OUT_DIR/$DATE_KST.md"

{
  echo "# $DATE_KST — OpenClaw 개인 운영 대시보드 (자동 로그)"
  echo
  echo "- 생성 시각: $NOW_KST"
  echo
  echo "## 오늘 커밋 요약"
  if [ -d "$REPO_DIR/.git" ]; then
    (cd "$REPO_DIR" && git log --since="00:00" --pretty=format:'- %h %s (%an)' ) || true
  else
    echo "- (repo not found: $REPO_DIR)"
  fi
  echo
  echo "## 현재 상태 체크"
  if command -v curl >/dev/null 2>&1; then
    echo "- dashboard /api/health: $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3412/api/health || true)"
  fi
  echo "- GitHub: https://github.com/icartsh/openclaw-ops-dashboard"
  echo
  echo "## 다음 할 일(자동 추천)"
  echo "- P0(C) 트렌드/히스토리 UI 확인"
  echo "- idle 감지 룰 확장(❯ 외 패턴) 점검"
  echo
  echo "---"
  echo
} > "$OUT_FILE"

echo "WROTE $OUT_FILE"

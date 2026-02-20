#!/bin/bash
# Git post-commit hook to notify Discord changelog channel
# Install: cp scripts/post-commit-hook.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit

WEBHOOK_URL="${GIT_WEBHOOK_URL:-http://127.0.0.1:4099/git-commit}"

# Get commit info
HASH=$(git rev-parse HEAD)
MESSAGE=$(git log -1 --pretty=%B)
AUTHOR=$(git log -1 --pretty=%an)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Get changed files
FILES=$(git diff-tree --no-commit-id --name-only -r HEAD | jq -R -s -c 'split("\n") | map(select(length > 0))')

# Get stats
STATS=$(git diff --shortstat HEAD~1 HEAD 2>/dev/null || echo "")
ADDITIONS=$(echo "$STATS" | grep -oP '\d+(?= insertion)' || echo "0")
DELETIONS=$(echo "$STATS" | grep -oP '\d+(?= deletion)' || echo "0")

# Build JSON payload
JSON=$(cat <<EOF
{
  "hash": "$HASH",
  "message": $(echo "$MESSAGE" | jq -R -s .),
  "author": "$AUTHOR",
  "branch": "$BRANCH",
  "files": $FILES,
  "additions": ${ADDITIONS:-0},
  "deletions": ${DELETIONS:-0}
}
EOF
)

# Send to webhook (silent, don't block commit)
curl -s -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$JSON" > /dev/null 2>&1 &

exit 0

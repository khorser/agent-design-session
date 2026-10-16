#!/bin/sh
# Run a Codex/Claude design session on a question kept in a file.
#
#   ./agent-design-session.sh QUESTION.md [OUTPUT-BASENAME] [ROUNDS]
#
# Writes OUTPUT-BASENAME.md (read this one) and OUTPUT-BASENAME.jsonl. The
# output basename defaults to the question file's name with -session appended;
# rounds default to 3. Both agents read the repository read-only, and you are
# prompted to steer the debate, or ask the last speaker to clarify, between turns.
#
# Further arguments pass through to the runner, including --topic, --auto,
# --resume, --force, --recover, --answers FILE, --note FILE and --designer codex|claude.
# Deno is preferred; Node.js 22.18+ is used when Deno is not installed.
set -eu

runner="$(dirname "$0")/agent-design-session.ts"

run_runner() {
  if command -v deno >/dev/null 2>&1; then
    exec deno run --allow-run --allow-read --allow-write "$runner" "$@"
  fi
  if command -v node >/dev/null 2>&1; then
    if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'; then
      echo 'agent-design-session: Node.js 22.18 or newer is required.' >&2
      exit 1
    fi
    exec node "$runner" "$@"
  fi
  echo 'agent-design-session: install Deno or Node.js 22.18+ to run this session.' >&2
  exit 1
}

if [ $# -lt 1 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# Flags that need no question file go straight through.
case $1 in
  --*) run_runner "$@" ;;
esac

question=$1
shift

# Consume the optional positionals only when they are not flags, so
# `agent-design-session.sh Q.md --auto` passes --auto through instead of
# turning it into an --out value.
out=""
rounds=""
case ${1-} in
  ""|--*) ;;
  *) out=$1; shift ;;
esac
case ${1-} in
  ""|--*) ;;
  *) rounds=$1; shift ;;
esac
[ -n "$out" ] || out="${question%.*}-session"
# Left to the runner when not given, so a plain --resume adds no rounds.
[ -z "$rounds" ] || set -- --rounds "$rounds" "$@"

run_runner \
  --topic-file "$question" \
  --out "$out" \
  "$@"

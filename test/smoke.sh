#!/bin/sh
# Run the session runner against stub codex and claude CLIs.
#
#   test/smoke.sh [deno|node]      (default: deno)
#
# The stubs answer every prompt with a canned turn and log how the prompt
# arrived, so this checks the runner's plumbing (turn order, labels, resume,
# render, follow-up, stdin prompts) without calling any model.
set -eu

runtime=${1:-deno}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

case $runtime in
  deno) run() { deno run --allow-run --allow-read --allow-write "$root/agent-design-session.ts" "$@" </dev/null; } ;;
  node) run() { node "$root/agent-design-session.ts" "$@" </dev/null; } ;;
  *) echo "unknown runtime: $runtime" >&2; exit 2 ;;
esac

reply='Proposal: keep it simple, verified (README.md:1).

### Questions for the human
- Should we ship it? Recommended default: yes.'

# codex: the prompt must arrive on stdin (`-`), the answer goes to --output-last-message.
cat > "$work/bin/codex" <<STUB
#!/bin/sh
[ "\$1" = "--version" ] && { echo "codex stub"; exit 0; }
out=""; last=""
while [ \$# -gt 0 ]; do
  [ "\$1" = "--output-last-message" ] && out=\$2
  last=\$1; shift
done
[ "\$last" = "-" ] || { echo "codex: prompt was not read from stdin" >&2; exit 3; }
bytes=\$(wc -c | tr -d ' ')
echo "codex \$bytes" >> "$work/prompts.log"
printf '%s\n' "$reply" | tee "\$out"
STUB

# claude: no prompt argument after the options, so --print reads stdin.
cat > "$work/bin/claude" <<STUB
#!/bin/sh
[ "\$1" = "--version" ] && { echo "claude stub"; exit 0; }
bytes=\$(wc -c | tr -d ' ')
[ "\$bytes" -gt 0 ] || { echo "claude: empty stdin" >&2; exit 3; }
echo "claude \$bytes" >> "$work/prompts.log"
printf '%s\n' "$reply"
STUB
chmod +x "$work/bin/codex" "$work/bin/claude"
PATH="$work/bin:$PATH"
export PATH

fail() { echo "FAIL: $*" >&2; exit 1; }
turns() { grep -c '"kind":"turn"' "$1"; }

echo "==> $runtime: one round, claude leading"
run --topic "Smoke question" --designer claude --rounds 1 --auto --repo "$root" --out "$work/a" >/dev/null
[ "$(turns "$work/a.jsonl")" -eq 2 ] || fail "expected 2 turns"
grep -q '"kind":"decision"' "$work/a.jsonl" || fail "no decision record"
grep -q '^## 1\. Claude — proposing architect' "$work/a.md" || fail "claude not labelled as proposer"
grep -q '^## 2\. Codex — skeptical reviewer' "$work/a.md" || fail "codex not labelled as reviewer"

echo "==> $runtime: resume to two rounds"
run --resume --out "$work/a" --rounds 2 --auto --repo "$root" >/dev/null
[ "$(turns "$work/a.jsonl")" -eq 4 ] || fail "expected 4 turns after resume"
grep -q 'decision record (superseded)' "$work/a.md" || fail "first record not marked superseded"

echo "==> $runtime: render"
rm "$work/a.md"
run --render --out "$work/a" >/dev/null
[ -s "$work/a.md" ] || fail "render wrote nothing"

echo "==> $runtime: follow-up inherits the designer"
run --follow-up "$work/a" --topic "Next question" --rounds 1 --auto --repo "$root" --out "$work/b" >/dev/null
grep -q '^Follows: \[a.md\](a.md)' "$work/b.md" || fail "no Follows link"
grep -q 'Claude — proposing architect' "$work/b.md" || fail "designer not inherited"

echo "==> $runtime: a 200 KB context file (over Linux's 128 KiB argument cap)"
head -c 200000 /dev/zero | tr '\0' 'x' > "$work/context.md"
: > "$work/prompts.log"
run --topic "Big context" --context-file "$work/context.md" --rounds 1 --auto --repo "$root" --out "$work/c" >/dev/null
awk '$2 < 200000 { bad = 1 } END { exit bad }' "$work/prompts.log" || fail "a prompt lost the context"
[ "$(wc -l < "$work/prompts.log")" -eq 3 ] || fail "expected 3 agent calls"

echo "==> $runtime: launcher --check"
"$root/agent-design-session.sh" --check >/dev/null

echo "ok ($runtime)"

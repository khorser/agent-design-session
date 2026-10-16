#!/bin/sh
# Run the session runner against stub codex and claude CLIs.
#
#   test/smoke.sh [deno|node]      (default: deno)
#
# The stubs answer every prompt with a canned turn and log how the prompt
# arrived, so this checks the runner's plumbing (turn order, labels, resume,
# render, follow-up, stdin prompts, prompt budgets) without calling any model.
# Each prompt is saved as prompt-N.txt; SMOKE_PAD=BYTES lengthens every reply.
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
n=\$((\$(cat "$work/prompts.log" 2>/dev/null | wc -l) + 1))
cat > "$work/prompt-\$n.txt"
bytes=\$(wc -c < "$work/prompt-\$n.txt" | tr -d ' ')
echo "codex \$bytes" >> "$work/prompts.log"
{ printf '%s\n' "$reply"; [ -z "\${SMOKE_PAD:-}" ] || { head -c "\$SMOKE_PAD" /dev/zero | tr '\0' y; echo; }; } | tee "\$out"
STUB

# claude: no prompt argument after the options, so --print reads stdin.
cat > "$work/bin/claude" <<STUB
#!/bin/sh
[ "\$1" = "--version" ] && { echo "claude stub"; exit 0; }
n=\$((\$(cat "$work/prompts.log" 2>/dev/null | wc -l) + 1))
cat > "$work/prompt-\$n.txt"
bytes=\$(wc -c < "$work/prompt-\$n.txt" | tr -d ' ')
[ "\$bytes" -gt 0 ] || { echo "claude: empty stdin" >&2; exit 3; }
echo "claude \$bytes" >> "$work/prompts.log"
printf '%s\n' "$reply"
[ -z "\${SMOKE_PAD:-}" ] || { head -c "\$SMOKE_PAD" /dev/zero | tr '\0' y; echo; }
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

echo "==> $runtime: a new session refuses existing outputs"
sums() { cksum "$work/a.jsonl" "$work/a.md"; }
before=$(sums)
if run --topic "Smoke question" --rounds 1 --auto --repo "$root" --out "$work/a" >/dev/null 2>"$work/err"; then
  fail "a rerun replaced an existing session"
fi
grep -q 'a.jsonl already exists.*--force' "$work/err" || fail "unexpected refusal: $(cat "$work/err")"
[ "$(sums)" = "$before" ] || fail "a refused rerun changed the existing session"
: > "$work/d.jsonl"
if run --topic "Empty log" --rounds 1 --auto --repo "$root" --out "$work/d" >/dev/null 2>"$work/err"; then
  fail "an empty log was replaced"
fi
grep -q 'd.jsonl already exists' "$work/err" || fail "unexpected refusal: $(cat "$work/err")"
[ ! -e "$work/d.md" ] || fail "a refused run wrote a transcript"
: > "$work/e.md"
if run --topic "Stray transcript" --rounds 1 --auto --repo "$root" --out "$work/e" >/dev/null 2>"$work/err"; then
  fail "a stray transcript was replaced"
fi
grep -q 'e.md already exists.*--force' "$work/err" || fail "unexpected refusal: $(cat "$work/err")"
[ ! -e "$work/e.jsonl" ] || fail "a refused run left its log behind"
run --topic "Forced question" --rounds 1 --auto --repo "$root" --out "$work/e" --force >/dev/null
grep -q 'Forced question' "$work/e.md" || fail "--force did not replace the transcript"
if run --resume --force --out "$work/a" --auto --repo "$root" >/dev/null 2>&1; then
  fail "--force was accepted with --resume"
fi

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

echo "==> $runtime: a long debate is trimmed by whole entries, keeping notes"
echo "EARLY-NOTE-MARKER" > "$work/early.md"
: > "$work/prompts.log"
export SMOKE_PAD=6000
run --topic "Long debate" --note "$work/early.md" --rounds 3 --auto --repo "$root" --out "$work/g" >/dev/null
unset SMOKE_PAD
[ "$(wc -l < "$work/prompts.log")" -eq 7 ] || fail "expected 7 agent calls"
last_turn="$work/prompt-6.txt"
grep -q '^\[Omitted for size: 2 ' "$last_turn" || fail "the last turn's prompt lists no omitted entries"
grep -q 'EARLY-NOTE-MARKER' "$last_turn" || fail "the moderator note was trimmed"
after=$(grep -A2 '^\[Omitted for size' "$last_turn" | sed -n 3p)
[ "$after" = "MODERATOR:" ] || fail "the trimmed transcript starts mid-entry: $after"
synthesis="$work/prompt-7.txt"
! grep -q 'Omitted for size' "$synthesis" || fail "the decision record saw a trimmed debate"
[ "$(grep -c '^Proposal: keep it simple' "$synthesis")" -eq 6 ] || fail "the decision record missed a turn"

echo "==> $runtime: a prompt over the ceiling stops before any agent call"
head -c 450000 /dev/zero | tr '\0' 'x' > "$work/huge.md"
: > "$work/prompts.log"
if run --topic "Huge context" --context-file "$work/huge.md" --rounds 1 --auto --repo "$root" --out "$work/f" >/dev/null 2>"$work/err"; then
  fail "an over-ceiling prompt was sent"
fi
grep -q 'over the 400000-character ceiling.*--context-file' "$work/err" || fail "unexpected failure: $(cat "$work/err")"
[ ! -s "$work/prompts.log" ] || fail "an agent was called"
[ ! -e "$work/f.jsonl" ] && [ ! -e "$work/f.md" ] || fail "a refused session left files behind"

echo "==> $runtime: a decision record over the ceiling stops instead of trimming"
head -c 360000 /dev/zero | tr '\0' 'x' > "$work/large.md"
: > "$work/prompts.log"
export SMOKE_PAD=25000
if run --topic "Large debate" --context-file "$work/large.md" --rounds 1 --auto --repo "$root" --out "$work/h" >/dev/null 2>"$work/err"; then
  fail "the decision record was written from a trimmed debate"
fi
unset SMOKE_PAD
grep -q 'over the 400000-character ceiling.*--resume --out' "$work/err" || fail "unexpected failure: $(cat "$work/err")"
[ "$(wc -l < "$work/prompts.log")" -eq 2 ] || fail "expected only the 2 debate calls"
[ "$(turns "$work/h.jsonl")" -eq 2 ] || fail "expected 2 turns kept"
! grep -q '"kind":"decision"' "$work/h.jsonl" || fail "a decision record was written"

echo "==> $runtime: launcher --check"
"$root/agent-design-session.sh" --check >/dev/null

echo "ok ($runtime)"

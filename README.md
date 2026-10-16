# agent-design-session

A chaired architecture debate between two coding agents: [Codex CLI] and
[Claude Code]. One agent proposes and the other reviews. Both read your
repository read-only, and every claim they make about the code must be marked
`verified (path:line)` or `unverified`. You moderate between turns. The session
ends with a decision record listing the decision, rejected alternatives, risks,
claims still unverified, and questions only you can answer.

It is a single TypeScript file with no dependencies, plus a shell launcher.

[Codex CLI]: https://github.com/openai/codex
[Claude Code]: https://docs.claude.com/en/docs/claude-code/overview

```
=== round 1 of 3 ===
[turn 1/7] claude reading the repo and thinking...
[turn 1/7] claude done (1m42s elapsed)

...

  [enter] next turn   [c] ask claude to clarify   [n] note to steer it   [s] stop and write the decision record   [q] quit now
>
```

## Requirements

- `codex` and `claude` on `PATH`, installed and authenticated.
- [Deno] (preferred), or Node.js 22.18 or newer.

[Deno]: https://deno.com

## Quick start

### 1. Run 3 rounds with Claude leading

Use an inline design question:

```sh
./agent-design-session.sh --repo ~/src --designer claude --rounds 3 \
  --topic "Design feature foo for bar" --out foo-claude
```

### 2. Run 3 rounds with Codex leading

Put the question and a separate note in files:

```sh
./agent-design-session.sh --repo ~/src --designer codex --rounds 3 \
  --topic-file question.md --note note.md --out foo-codex
```

`question.md` holds the design prompt. `note.md` holds additional human guidance,
such as the repository layout, relevant paths, constraints or priorities. The
runner records it as a moderator note before the first turn. For static background
that must appear in **every** turn and carry into resumed or follow-up sessions,
use `--context-file repo-layout.md`; a note can leave the prompt when an older
part of the transcript is trimmed.

`--out foo-codex` creates **two files**: `foo-codex.md`, the readable transcript
and decision record, and `foo-codex.jsonl`, the log used for resume and render.

### 3. Continue to 5 total rounds

```sh
./agent-design-session.sh --repo ~/src --resume --out foo-codex --rounds 5
```

This adds two rounds to a completed 3-round session. The question and designer
come from the log, so neither needs to be supplied again.

### 4. Supply human answers

Answer the decision record's questions:

```sh
./agent-design-session.sh --repo ~/src --resume --out foo-codex --answers answers.md
```

`answers.md` is free-form Markdown. Answers are recorded and shown in full to
later turns; this command alone adds no debate rounds. You can also answer
interactively with `a` after the decision record.

Each round is one proposer turn and one reviewer turn; 3 rounds give 6 debate
turns followed by a decision record. Without `--out`, the runner uses a
timestamped basename. The positional form uses a question file and defaults to
3 rounds:

```sh
./agent-design-session.sh --repo ~/src my-question.md
```

That writes `my-question-session.md` and `my-question-session.jsonl` next to it.
Running the same command again does not replace them: a new session refuses
to start over an existing `.md` or `.jsonl`, even an empty one. Add `--resume`
to continue that session, or `--force` to replace it.
Replace `~/src` with the directory containing all checkouts the agents
need to inspect. `--repo` sets their read-only working directory and the scope
Claude can read; without it, the runner uses your current directory. Pass it
again on resume because the session log does not save this setting.

## The agents can read the repo

Both run with read access to the repository (`--repo DIR`, default: the current
directory) and neither can write to it. The runner takes one directory, and
Claude can read only inside it. If the question spans several checkouts, pass
their common parent and name the exact paths in the question file or in
`--context-file`. Codex runs under `codex exec --sandbox
read-only`; Claude gets `--tools Read,Grep,Glob`.

Each turn is instructed to open the files the question depends on and to mark
every claim about the code as `verified (path:line)` or `unverified`. That is
what keeps the debate concrete: the reviewer can, and does, check the
proposer's citations against the source.

This matters more than it looks. An early version of this runner handed both
agents an *empty temporary directory*, so they could only speculate. The result
was a debate that carried unverified assumptions about library bindings for six
rounds, with each agent politely building on the other's guesses.

## You moderate

After every turn the session pauses:

```
  [enter] next turn   [c] ask codex to clarify   [n] note to steer it   [s] stop and write the decision record   [q] quit now
```

`c` asks the agent that just spoke a question — "which file is that
signature in?", "do you mean the HTTP or the gRPC handler?" — and prints
its answer. The agent is told to answer directly, not re-argue its turn, and
to mark claims `verified`/`unverified` as usual. Ask as many as you like; the
menu comes back after each answer, and clarifications never count as turns, so
round numbering and whose turn it is stay unchanged.

A note (`n`) is appended to the transcript as a `Moderator note:` line, and the
next agent is instructed to follow it. Use it to pull the discussion back to
what you care about, rule an option out, or demand that a claim be checked.

`s` stops the debate early but still writes the decision record — usually what
you want once the useful material has surfaced. `--auto` skips the pauses
entirely; a non-interactive stdin (a pipe, CI) does the same automatically.

After the final turn the menu changes, since the next step is the record:

```
  [enter] write the decision record   [m] one more round   [c] ask claude to clarify   [n] note for the record   [q] quit now
```

`m` adds a round right there, so when you already know the debate is not done
you do not wait for a decision record that would only be superseded. It can
be repeated after each new final turn.

After the decision record, one more menu:

```
  [enter] finish   [c] ask claude about the record   [a] answer the questions for the human   [m] one more round and a new record
```

`c` questions the record's author. `a` walks the record's **Questions for the
human** one at a time; an empty line accepts the recommended default. `m` runs
another round with your answers in view and writes a new record.

## What to expect

Each turn is a full CLI invocation and takes a minute or more. Three rounds is
seven turns — roughly 5-15 minutes, plus your thinking time between them. The
runner prints `[turn 3/7] codex reading the repo and thinking...` as it goes
and rewrites the Markdown file after every turn.

If a turn fails or you interrupt it, everything already written is kept, and
rerunning without `--resume` is refused rather than starting over:

```sh
./agent-design-session.sh my-question.md sessions/pricing-debate 4 --resume
```

With `--resume`, `--rounds` is the total, earlier rounds included. Resuming a
session that already ended in a decision record, without raising `--rounds`,
reopens that record and its menu instead of writing it again. With `--note`
it writes a new record steered by the note, still without new turns.

## Answering the questions and continuing

A decision record ends with questions only you can answer. There are two ways
to answer them and keep going; in both, your answers and the record they
answer are **pinned**: every later prompt carries them in full, outside the
part of the transcript that is trimmed from the front when it grows past the
prompt budget. Agents are told to treat answers as decisions and to reopen one
only with evidence from the code.

**Same discussion, more rounds.** Answer with `a` at the end of the run and
pick `m`, or come back later. Put the answers in a file (free-form Markdown)
and resume with a higher round count:

```sh
./agent-design-session.sh my-question.md sessions/pricing-debate 5 --resume --answers answers.md
```

The old record stays in the transcript, marked *superseded*, next to your
answers; the new rounds end in a fresh record.

**Same discussion, new direction.** Between turns you steer with `n`, but a
resumed session that adds turns with `--rounds` starts the next one straight
away. To steer that turn, put the note in a file and pass `--note`; it is
recorded exactly like `n`:

```sh
./agent-design-session.sh --resume --out sessions/pricing-debate --rounds 5 --note steer.md
```

The question comes from the log, so the question file may be omitted; passing
a different one is refused rather than silently changing what the earlier
turns answered. When the new direction is really a new question, use
`--follow-up` below.

**New question, building on a finished session.** When the next step is a
different question — "the PoC is implemented, what did we learn?" — start a
linked session instead of re-explaining the previous one in the question file:

```sh
./agent-design-session.sh follow-up.md sessions/pricing-followup 3 \
  --follow-up sessions/pricing-debate --answers answers.md
```

Every turn then sees the parent's question, its latest decision record and all
answers you gave in it (and the same for its own parent, if it was a follow-up
too). The new transcript starts with a `Follows:` link, the parent path is
stored relative to the log, and `--designer` defaults to the parent's.
`--answers` here records answers to the parent's questions at the start of the
new session.

Pinned context is not trimmed, so a long chain of follow-ups carries every
ancestor's decision record in each prompt. For a few records that is fine; for a deep chain, fold the settled points into the new question file
and start a fresh session instead.

## The decision record

The closing turn is a facilitator pass with fixed sections: Decision,
Rationale, Alternatives rejected, Risks, **Claims still unverified**, and
**Questions for the human**. The last two exist because the first version of
this tool produced neither: it ended with open questions addressed to nobody,
and no marker for what the debate had assumed without checking.

## Checking the setup

```sh
./agent-design-session.sh --check
```

Both `codex` and `claude` must be installed and authenticated. The shell launcher
also requires Deno or Node.js 22.18+; it prefers Deno when both are installed.

## Direct invocation

The shell wrapper only covers the common case. The runner itself can be invoked
with either runtime:

```sh
deno run --allow-run --allow-read --allow-write ./agent-design-session.ts \
  --topic "Should our pricing service use a rule engine or a decision table?" \
  --repo . --rounds 3 --out /tmp/pricing-design
```

Replace `deno run --allow-run --allow-read --allow-write` with `node` on
Node.js 22.18+.

`--out` takes a basename; a `.md` or `.jsonl` suffix is stripped, so
`--out x`, `--out x.md`, and `--out x.jsonl` all produce the same pair. Omit it
for a timestamped file in the current directory. `--codex-model` and
`--claude-model` select models supported by the respective CLI. `--help` lists
everything.

By default Codex proposes and Claude reviews. Pass `--designer claude` to
swap it: Claude proposes, Codex reviews — and, either way, the closing
decision record is written by whichever CLI reviewed, not the proposer. The
choice is saved in the log, so `--resume` picks it up; logs recorded before
that fall back to `--designer` (default: codex).

## Rebuilding the readable file

`--render` regenerates `NAME.md` from an existing `NAME.jsonl` without running
any agent turns. Use it on a session recorded before the Markdown output
existed, or after editing the log:

```sh
./agent-design-session.sh --render --out sessions/poc-review-session
```

## Why not a chat protocol (IRC, Matrix, Slack)?

It was considered, and it would not buy anything yet:

- **Nobody here is a chat peer.** Every agent turn is a one-shot process
  (`codex exec --ephemeral`, `claude --print --no-session-persistence`) that
  starts, answers one prompt and exits. Nothing is long-lived, nothing speaks
  unprompted, and there is one human. A chat protocol exists to multiplex
  persistent, asynchronous participants; this session has none.
- **It adds infrastructure without removing any.** A server, plus a bridge bot
  that would still spawn the same two CLIs and still need the same prompts and
  turn order.
- **It gives up the property the runner is built on.** One process decides who
  speaks next and is the only writer of an append-only JSONL log. That is what
  makes `--resume`, `--render`, pinning and `--follow-up` reliable; a chat room
  as the source of truth would make the log a reconstruction.

What would change the answer: wanting to moderate from a client you already
have open (phone, Matrix, Slack), or agents that need to interrupt each other
mid-turn. Even then, keep this runner as the scheduler and the log as the
record, and make the chat room only its input and output.

## License

MIT. See [LICENSE](LICENSE).

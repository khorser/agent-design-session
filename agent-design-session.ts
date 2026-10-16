#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

import process from "node:process";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";

/**
 * A small, local, turn-based design discussion between Codex and Claude Code.
 *
 * It deliberately uses the installed CLIs instead of a FIFO or a web server:
 * the transcript is the durable shared state, and only this process decides
 * which agent gets the next turn.
 *
 * Both agents run read-only inside the repository, so they can check claims
 * against the code instead of speculating. You moderate between turns unless
 * --auto is given. Two files are written side by side: a JSONL log for tooling
 * and a Markdown transcript for reading.
 */
/** Debate turns see at most this much transcript; whole entries drop out oldest first. */
const MAX_TRANSCRIPT_CHARS = 28_000;
/**
 * No prompt may be longer, about 100k tokens, which leaves the agent room to
 * read the repository. It counts everything: the question, context, settled
 * records and the transcript.
 */
const MAX_PROMPT_CHARS = 400_000;
/** Set once a turn has been written, so failures know whether --resume is useful. */
let sessionStarted = false;
const decoder = new TextDecoder();

const readTextFile = (path: string) => readFile(path, "utf8");
const writeTextFile = (path: string, text: string) => writeFile(path, text);

type Output = { success: boolean; code: number; stdout: Uint8Array; stderr: Uint8Array };

/**
 * Collect all output: an agent's final answer can exceed a fixed exec buffer.
 * `input`, if given, is written to stdin. Prompts go that way rather than as an
 * argument, because Linux caps a single argument at 128 KiB.
 */
async function commandOutput(command: string, args: string[], cwd?: string, input?: string): Promise<Output> {
  // Deno's Node spawn compatibility needs --allow-env to inherit the shell's
  // environment. Keep the launcher's narrower existing permission set.
  if (typeof Deno !== "undefined") {
    const child = new Deno.Command(command, {
      args, cwd, stdin: input === undefined ? "null" : "piped", stdout: "piped", stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      // A command that exits without reading its input reports through its status.
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input)).then(() => writer.close()).catch(() => {});
    }
    return child.output();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    // A command that exits without reading its input reports through its status.
    child.stdin.on("error", () => {}).end(input ?? "");
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Uint8Array) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      success: code === 0,
      code: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
}

function usage(exitCode = 0): never {
  console.log(`Usage:
  agent-design-session.ts --topic-file QUESTION.md [--out NAME] [options]

Options:
  --topic "..."           The design question, inline.
  --topic-file FILE       Read the design question from FILE instead.
  --repo DIR              Repository both agents may read (default: this
                          directory). They run read-only and cannot edit it.
                          Saved in the log, so --resume and --follow-up reuse
                          it; passing it on --resume moves the session there.
  --rounds N              Number of Codex/Claude exchanges (default: 3, max 12).
                          With --resume, the total including earlier rounds;
                          omit it to reopen a finished session's decision
                          record without new turns.
  --auto                  Do not pause for moderation between turns.
  --codex-model MODEL     Passed to \`codex exec --model\`.
  --claude-model MODEL    Passed to \`claude --model\`.
  --designer codex|claude Which CLI proposes the design; the other reviews
                          and, at the end, writes the decision record
                          (default: codex, or the parent's with --follow-up).
                          Saved in the log, so --resume need not repeat it.
  --context-file FILE     Repo-specific background (for example the paths both
                          agents may read), given to every turn. Saved in the
                          log, so --resume and --follow-up inherit it; passing
                          it on --resume replaces it for later runs too, and
                          a finished session's decision record is rewritten.
  --out NAME              Output basename. Writes NAME.md (readable) and
                          NAME.jsonl (log). Default: a timestamped file in the
                          current directory. A new session refuses to replace
                          either file; use --resume or --force.
  --force                 Replace an existing NAME.md and NAME.jsonl when
                          starting a new session.
  --resume                Continue an interrupted or finished session from an
                          existing NAME.jsonl instead of restarting. The
                          question comes from the log, so --topic and
                          --topic-file may be omitted; a different one is
                          refused. To add turns to a finished session, raise
                          --rounds above the rounds already spoken; otherwise
                          the existing record is shown with its menu. A new
                          record is written only if the last one is missing,
                          superseded, or followed by --note.
  --recover               With --resume or --render: if the log's last line was
                          cut short by an interrupted write, move it to
                          NAME.damaged-TIMESTAMP.jsonl and keep the rest.
                          Damage anywhere else is refused.
  --answers FILE          Record FILE as the human's answers to the previous
                          decision record's questions before the next turn.
  --note FILE             Record FILE as a moderator note steering the next
                          turn, or the new decision record when no turns are
                          added (as the interactive [n] key does).
  --follow-up PARENT      Start a new session that builds on PARENT.jsonl: its
                          question, decision record and answers are given to
                          every turn in full.
  --render                Rewrite NAME.md from an existing NAME.jsonl and exit,
                          without running any agent turns.
  --check                 Verify codex and claude are on PATH, then exit.
  --help                  Show this help.

Prerequisites: authenticated \`codex\` and \`claude\` CLIs on PATH.

Moderating: after every turn the session pauses and offers to continue, ask the
agent that just spoke to clarify, add a note steering the next turn, or stop
early and write the decision record. After the last turn you can instead run
one more round before any record is written. After the record you can question its
author, answer its questions for the human, or run another round. Everything is
appended to the transcript, so later turns see it. Use --auto to skip the
pauses; a non-interactive stdin does the same automatically. The decision
record is always written by the reviewer (the CLI --designer did not pick),
so it is never authored by the agent that just argued for its own proposal.

Each turn is a full CLI invocation and can take a minute or more. A 3-round
session is 7 turns, so expect roughly 5-15 minutes. Every turn is flushed to
disk immediately: if you interrupt it, what already happened is kept, and
--resume picks up from there.`);
  process.exit(exitCode);
}

type Options = {
  topic?: string;
  topic_file?: string;
  repo?: string;
  rounds?: number;
  codex_model?: string;
  claude_model?: string;
  designer?: string;
  out?: string;
  answers?: string;
  context_file?: string;
  note?: string;
  follow_up?: string;
  resume: boolean;
  force: boolean;
  recover: boolean;
  check: boolean;
  render: boolean;
  auto: boolean;
};

const FLAGS = new Set(["resume", "force", "recover", "check", "render", "auto"]);
const VALUED = new Set([
  "topic", "topic_file", "repo", "rounds", "codex_model", "claude_model", "designer", "out", "answers", "context_file", "note", "follow_up",
]);

function parseArgs(argv: string[]): Options {
  const options: Options = { resume: false, force: false, recover: false, check: false, render: false, auto: false };
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === "--help") usage();
    if (!option.startsWith("--")) usage(2);
    const name = option.slice(2).replaceAll("-", "_");
    if (FLAGS.has(name)) {
      (options as Record<string, unknown>)[name] = true;
      continue;
    }
    if (!VALUED.has(name)) {
      console.error(`Unknown option: ${option}`);
      usage(2);
    }
    const value = argv[++i];
    if (value === undefined) {
      console.error(`${option} needs a value`);
      usage(2);
    }
    (options as Record<string, unknown>)[name] = value;
  }
  if (options.check) return options;
  if (options.render) {
    if (!options.out) throw new Error("--render needs --out naming the existing transcript");
    return options;
  }

  if (options.rounds !== undefined) {
    options.rounds = Number(options.rounds);
    if (!Number.isInteger(options.rounds) || options.rounds < 1 || options.rounds > 12) {
      throw new Error("--rounds must be an integer from 1 through 12");
    }
  }
  if (options.designer !== undefined && options.designer !== "codex" && options.designer !== "claude") {
    throw new Error("--designer must be 'codex' or 'claude'");
  }
  if (options.topic && options.topic_file) throw new Error("Provide only one of --topic or --topic-file");
  if (!options.resume && !options.topic && !options.topic_file) {
    throw new Error("Provide one of --topic or --topic-file");
  }
  if (options.resume && !options.out) throw new Error("--resume needs --out naming the existing transcript");
  if (options.recover && !options.resume) {
    throw new Error("--recover repairs an existing log; combine it with --resume or --render");
  }
  if (options.resume && options.force) {
    throw new Error("--force replaces a session; it cannot be combined with --resume");
  }
  return options;
}

/**
 * `turn` is a debate turn and the only kind that counts towards rounds.
 * `clarification` answers a `clarify-question`; `answers` holds the human's
 * replies to a decision record's questions. Logs written before `kind` existed
 * have none, so `kindOf` infers it from the speaker.
 */
const KINDS = new Set(["meta", "turn", "note", "clarify-question", "clarification", "answers", "decision"]);
type Kind = "meta" | "turn" | "note" | "clarify-question" | "clarification" | "answers" | "decision";
/**
 * The settings a resumed run may change. Each change is a later `meta` entry
 * carrying only the changed keys; `settingsOf` folds them over the first.
 * `repo` is the repository directory, relative to this log's directory.
 */
type Settings = { repo?: string; context?: string };
/** `parent` is the parent session's basename, relative to this log's directory. */
type Meta = Settings & { designer: string; parent?: string };
type Entry = { at: string; speaker: string; text: string; kind?: Kind; meta?: Meta | Settings };

/** The settings the session started with; `readLog` has checked their shape. */
const startMeta = (entries: Entry[]) => entries[0]?.meta as Meta | undefined;

/** The settings in effect after every update. `designer` and `parent` never change. */
function settingsOf(entries: Entry[]): Settings {
  const settings: Settings = { repo: startMeta(entries)?.repo, context: startMeta(entries)?.context };
  for (const entry of entries.slice(1)) {
    if (entry.kind !== "meta" || !entry.meta) continue;
    if (entry.meta.repo !== undefined) settings.repo = entry.meta.repo;
    if (entry.meta.context !== undefined) settings.context = entry.meta.context;
  }
  return settings;
}

function kindOf(entry: Entry, index: number): Kind {
  if (entry.kind) return entry.kind;
  if (index === 0) return "meta";
  if (entry.speaker === "codex" || entry.speaker === "claude") return "turn";
  if (entry.speaker === "moderator") return "note";
  return "decision";
}

function withKinds(entries: Entry[]): Entry[] {
  return entries.map((entry, i) => ({ ...entry, kind: kindOf(entry, i) }));
}

/** A decision record stops being current once the debate moves on past it. */
function superseded(entries: Entry[], index: number): boolean {
  return entries.slice(index + 1).some(({ kind }) => kind === "turn" || kind === "decision");
}

/** The index of the latest decision record, unless the debate has moved past it. */
function standingDecision(entries: Entry[]): number | undefined {
  const index = entries.findLastIndex((entry) => entry.kind === "decision");
  return index < 0 || superseded(entries, index) ? undefined : index;
}

/** Strip the extension the user may have typed, so --out x.md and --out x agree. */
function basename(out: string): string {
  return out.replace(/\.(jsonl|md)$/, "");
}

function defaultBasename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `design-session-${stamp}`;
}

function absolute(path: string): string {
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${process.cwd()}/${path}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const dirOf = (path: string) => absolute(path).split("/").slice(0, -1).join("/") || "/";

/** Path of `to` as seen from the directory `from`; `.` when they are the same. */
function relativeDir(from: string, to: string): string {
  const fromDirs = absolute(from).split("/").filter(Boolean);
  const toParts = absolute(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < fromDirs.length && shared < toParts.length && fromDirs[shared] === toParts[shared]) shared += 1;
  return [...fromDirs.slice(shared).map(() => ".."), ...toParts.slice(shared)].join("/") || ".";
}

/** Path of `to` as a link from a document stored at `from`. */
const relative = (from: string, to: string) => relativeDir(dirOf(from), to);

const capitalize = (name: string) => name[0].toUpperCase() + name.slice(1);

function promptLabel(entry: Entry): string {
  const speaker = entry.speaker.toUpperCase();
  return entry.kind === "clarification" ? `${speaker} (clarification)` : speaker;
}

/**
 * The human's answers, and the decision record each one answers, are what a
 * later turn must never lose. They are pinned: shown in full, outside the
 * transcript, which loses its oldest entries when it grows too long.
 */
function pinnedIndices(entries: Entry[]): Set<number> {
  const pinned = new Set<number>();
  entries.forEach((entry, i) => {
    if (entry.kind !== "answers") return;
    pinned.add(i);
    for (let j = i - 1; j >= 0; j -= 1) {
      if (entries[j].kind === "decision") {
        pinned.add(j);
        break;
      }
    }
  });
  return pinned;
}

/**
 * The debate as a prompt shows it. Over `budget`, whole entries are dropped
 * oldest first and listed by the number they have in the Markdown transcript,
 * so a prompt never starts mid-entry. Moderator notes are instructions and are
 * always kept, as is the latest entry, which is what the next turn answers.
 */
function transcriptForPrompt(entries: Entry[], budget: number): { text: string; omitted: number[] } {
  const pinned = pinnedIndices(entries);
  // Only the opening entry is hidden; later settings changes are history the agents should see.
  let kept = entries.flatMap((_, i) => i === 0 || pinned.has(i) ? [] : [i]);
  const render = (indices: number[]) => indices.map((i) => `${promptLabel(entries[i])}:\n${entries[i].text}`).join("\n\n");
  const omitted: number[] = [];
  let text = render(kept);
  while (text.length > budget) {
    const drop = kept.findIndex((i, k) => entries[i].kind !== "note" && k < kept.length - 1);
    if (drop < 0) break;
    omitted.push(kept[drop]);
    kept = kept.filter((_, k) => k !== drop);
    const listed = omitted.map((i) => `${i} ${promptLabel(entries[i])}`).join(", ");
    text = `[Omitted for size: ${listed}. Numbers match the Markdown transcript; moderator notes are always kept.]`
      + `\n\n${render(kept)}`;
  }
  return { text, omitted };
}

function pinnedForPrompt(parentContext: string, entries: Entry[]): string {
  const pinned = pinnedIndices(entries);
  const own = entries
    .filter((_, i) => pinned.has(i))
    .map((entry) => entry.kind === "decision"
      ? `EARLIER DECISION RECORD (this session):\n${entry.text}`
      : `HUMAN ANSWERS:\n${entry.text}`)
    .join("\n\n");
  return [parentContext, own].filter(Boolean).join("\n\n");
}

function pinnedSection(pinned: string): string {
  return pinned
    ? "Settled context (always shown in full). The human's answers are decisions: build on them, and "
      + `reopen one only if the code contradicts it, citing the evidence.\n${pinned}\n\n`
    : "";
}

function repoRules(repo: string, context: string): string {
  return `The repository is at ${repo} and you can read it. Before you answer, open the files this `
    + "question actually depends on and check the claims you are about to make. You have read "
    + "access only; do not attempt to edit anything.\n\n"
    + (context ? `Repository context:\n${context}\n\n` : "");
}

/**
 * The verified/unverified rule is what turns repository access into evidence.
 * Each turn is a fresh process with no memory, so it has to be restated.
 */
function agentPrompt(role: string, topic: string, pinned: string, transcript: string, repo: string, context: string): string {
  return `You are ${role} in a two-agent architecture design review.\n\n`
    + repoRules(repo, context)
    + `Design question:\n${topic}\n\n`
    + pinnedSection(pinned)
    + `Conversation so far:\n${transcript || "(You have the first turn.)"}\n\n`
    + "Rules for your turn:\n"
    + "- Open with one sentence saying what changed since the previous turn, or what you are "
    + "proposing if you have the first turn.\n"
    + "- Mark every factual claim about the code as `verified (path:line)` or `unverified`. Do not "
    + "assert that a binding, signature, or behaviour exists unless you have read it.\n"
    + "- Respond to the other agent's latest substantive point. Refine or reject it; do not "
    + "restate agreement at length.\n"
    + "- State assumptions and name the risks and trade-offs you are accepting.\n"
    + "- About 400 words. Prefer a specific objection over a broad survey.\n"
    + "- A line beginning `Moderator note:` is an instruction from the human running this session. "
    + "Follow it.\n"
    + "- `Moderator question to ...` lines and replies marked (clarification) are side exchanges "
    + "with the human. Use what they establish, but they are not turns to respond to.\n"
    + "- Never claim validation you did not perform.";
}

function clarifyPrompt(
  speaker: string,
  topic: string,
  pinned: string,
  transcript: string,
  question: string,
  repo: string,
  context: string,
): string {
  return `You are ${capitalize(speaker)}, one of two agents in an architecture design review. The human `
    + "moderating it has paused the discussion to ask you about your latest contribution.\n\n"
    + repoRules(repo, context)
    + `Design question:\n${topic}\n\n`
    + pinnedSection(pinned)
    + `Conversation so far:\n${transcript}\n\n`
    + `The human's question to you:\n${question}\n\n`
    + "Rules for your answer:\n"
    + "- Answer the question directly, in the first sentence. Do not re-argue your turn or advance "
    + "the debate, and do not address the other agent unless the question asks you to.\n"
    + "- If the question exposes a mistake or a gap in what you said, say so plainly.\n"
    + "- Mark every factual claim about the code as `verified (path:line)` or `unverified`.\n"
    + "- As short as the question allows; at most about 250 words.\n"
    + "- Never claim validation you did not perform.";
}

function synthesisPrompt(topic: string, pinned: string, transcript: string, context: string): string {
  return "You are the neutral facilitator closing a two-agent design review. Using only the debate "
    + "below, write a compact decision record with these sections: Decision, Rationale, "
    + "Alternatives rejected, Risks, Claims still unverified, and Questions for the human.\n\n"
    + "`Claims still unverified` lists anything the debate relied on without reading the code. "
    + "`Questions for the human` must be decisions only the person running this session can make: "
    + "phrase each as a direct question and give your recommended default. Do not introduce new "
    + "facts, and do not leave questions addressed to nobody. Questions the human has already "
    + "answered in the settled context are decided: fold the answers into the Decision and do not "
    + "ask them again.\n\n"
    + (context ? `Repository context:\n${context}\n\n` : "")
    + `Design question:\n${topic}\n\n`
    + pinnedSection(pinned)
    + `Debate:\n${transcript}`;
}

/** The bullets under the decision record's `Questions for the human` heading. */
function questionsForHuman(record: string): string[] {
  const lines = record.split("\n");
  const start = lines.findIndex((line) =>
    /^\s*(#{1,6}\s*|\*\*)?Questions for the human(\*\*)?:?\s*$/i.test(line)
  );
  if (start < 0) return [];
  const questions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line)) break;
    const bullet = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (bullet) questions.push(bullet[1].trim());
    else if (line.trim() && questions.length) questions[questions.length - 1] += ` ${line.trim()}`;
  }
  return questions;
}

function entryTitle(entries: Entry[], index: number): string {
  const entry = entries[index];
  switch (entry.kind) {
    case "turn": {
      // Logs from before the designer was saved had codex propose.
      const designer = startMeta(entries)?.designer ?? "codex";
      return `${capitalize(entry.speaker)} — ${entry.speaker === designer ? "proposing architect" : "skeptical reviewer"}`;
    }
    case "clarification":
      return `${capitalize(entry.speaker)} — clarification`;
    case "clarify-question":
      return "Moderator question (you)";
    case "answers":
      return "Moderator answers (you)";
    case "note":
      return "Moderator (you)";
    case "decision":
      return superseded(entries, index) ? "Facilitator — decision record (superseded)" : "Facilitator";
    default:
      return capitalize(entry.speaker);
  }
}

function markdownEntry(entries: Entry[], index: number, number: number): string {
  const entry = entries[index];
  const time = entry.at.slice(11, 19);
  return `## ${number}. ${entryTitle(entries, index)}\n\n<sub>${time}</sub>\n\n${entry.text.trim()}\n`;
}

/** A long question is folded away, so the turns stay at the top of the file. */
function questionSection(topic: string): string {
  const lines = topic.trim().split("\n");
  if (lines.length <= 12) {
    return `**Question**\n\n${lines.map((line) => `> ${line}`).join("\n")}`;
  }
  return `<details>\n<summary><b>Question</b> (${lines.length} lines) — click to expand</summary>\n\n`
    + `${topic.trim()}\n\n</details>`;
}

/** Both files of a session share a directory, so the stored parent path is already a valid link. */
function markdownDocument(topic: string, entries: Entry[]): string {
  const parent = startMeta(entries)?.parent;
  const follows = parent ? `Follows: [${parent.split("/").at(-1)}.md](${parent}.md)\n\n` : "";
  const head = `# Design session\n\n${follows}${questionSection(topic)}\n\n---\n`;
  const body = entries
    .slice(1)
    .map((_, i) => markdownEntry(entries, i + 1, i + 1))
    .join("\n---\n\n");
  return `${head}\n${body}`;
}

async function run(command: string, args: string[], cwd: string, input: string): Promise<string> {
  const output = await commandOutput(command, args, cwd, input);
  const stdout = decoder.decode(output.stdout).trim();
  const stderr = decoder.decode(output.stderr).trim();
  if (stderr) console.error(`[${command}] ${stderr}`);
  if (!output.success) throw new Error(`${command} exited with status ${output.code}: ${stderr || stdout}`);
  if (!stdout) throw new Error(`${command} returned no response`);
  return stdout;
}

type Agent = (prompt: string) => Promise<string>;

/** `scratch` holds only the last-message file; the agent works inside `repo`. */
function codexAgent(repo: string, scratch: string, model?: string): Agent {
  return async (prompt) => {
    const outputFile = `${scratch}/codex-${crypto.randomUUID()}.txt`;
    const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", repo, "--output-last-message", outputFile];
    if (model) args.push("--model", model);
    // `-` reads the prompt from stdin.
    args.push("-");
    await run("codex", args, repo, prompt);
    return (await readTextFile(outputFile)).trim();
  };
}

function claudeAgent(repo: string, model?: string): Agent {
  return (prompt) => {
    const args = [
      "--print",
      "--output-format", "text",
      "--no-session-persistence",
      "--add-dir", repo,
      "--tools", "Read,Grep,Glob",
      "--system-prompt", "You are participating in a design discussion about the repository you "
        + "can read. Use Read, Grep, and Glob to check claims against the code. You have no write "
        + "tools; do not claim to have edited or run anything.",
    ];
    if (model) args.push("--model", model);
    // With no prompt argument, --print reads it from stdin.
    return run("claude", args, repo, prompt);
  };
}

async function onPath(command: string): Promise<boolean> {
  try {
    const output = await commandOutput(command, ["--version"]);
    return output.success;
  } catch {
    return false;
  }
}

async function checkPrerequisites(): Promise<boolean> {
  let ok = true;
  for (const command of ["codex", "claude"]) {
    const found = await onPath(command);
    console.log(`${found ? "ok  " : "MISSING"}  ${command}`);
    ok &&= found;
  }
  if (!ok) console.error("\nInstall and authenticate the missing CLI before running a session.");
  return ok;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Why a parsed log line is not a usable entry, or undefined if it is. */
function entryProblem(value: unknown, index: number): string | undefined {
  if (!isObject(value)) return "not a JSON object";
  for (const field of ["at", "speaker", "text"]) {
    if (typeof value[field] !== "string") return `"${field}" is not a string`;
  }
  if (value.kind !== undefined && !KINDS.has(value.kind as string)) return `unknown kind ${JSON.stringify(value.kind)}`;
  const meta = value.meta;
  if (index === 0) {
    if (value.kind !== undefined && value.kind !== "meta") return "the first entry is not the session's settings";
    if (meta === undefined) return undefined;
    if (!isObject(meta) || typeof meta.designer !== "string") return "the session's settings have no designer";
    const bad = ["parent", "context", "repo"].find((key) => meta[key] !== undefined && typeof meta[key] !== "string");
    return bad && `setting "${bad}" is not a string`;
  }
  if (value.kind !== "meta") return undefined;
  if (!isObject(meta) || !Object.keys(meta).length) return "a settings update changes nothing";
  const bad = Object.entries(meta).find(([key, setting]) => !(key === "repo" || key === "context") || typeof setting !== "string");
  return bad && `a settings update cannot set "${bad[0]}" to ${JSON.stringify(bad[1])}`;
}

/**
 * The entries of a session log. A missing log and a damaged one are reported
 * apart, by physical line number. Only a damaged last line, the trace of an
 * interrupted append, can be recovered, and only with `recover`: its bytes are
 * moved to a side file, never discarded, and the log keeps the valid lines.
 */
async function readLog(jsonl: string, recover = false): Promise<Entry[]> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(jsonl);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error(`${jsonl} does not exist`);
    throw error;
  }
  const lines: { number: number; start: number; text: string }[] = [];
  for (let start = 0, number = 1; start < bytes.length; number += 1) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline;
    const text = decoder.decode(bytes.subarray(start, end));
    if (text.trim()) lines.push({ number, start, text });
    start = end + 1;
  }
  const entries: Entry[] = [];
  for (const [index, line] of lines.entries()) {
    let problem: string | undefined;
    try {
      const value: unknown = JSON.parse(line.text);
      problem = entryProblem(value, index);
      if (!problem) entries.push(value as Entry);
    } catch {
      problem = "incomplete or invalid JSON";
    }
    if (!problem) continue;
    const base = basename(jsonl);
    if (index === 0) {
      throw new Error(`${jsonl} line ${line.number}, the session's first entry, is malformed (${problem}); `
        + "without it there is no session to recover.");
    }
    if (index < lines.length - 1) {
      throw new Error(`${jsonl} line ${line.number} is malformed (${problem}). Only a damaged last line can be `
        + "recovered; fix or remove this one by hand.");
    }
    if (!recover) {
      throw new Error(`${jsonl} line ${line.number}, its last, is malformed (${problem}), probably from an interrupted `
        + `write. Set it aside and keep the ${entries.length} valid entries with --resume --recover --out ${base}, or `
        + `with --render --recover --out ${base} to repair the log without running any turns.`);
    }
    const aside = `${base}.damaged-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`;
    await writeFile(aside, bytes.subarray(line.start), { flag: "wx" });
    await writeFile(jsonl, bytes.subarray(0, line.start));
    console.log(`Moved damaged line ${line.number} of ${jsonl} to ${aside}; ${entries.length} entries remain.`);
    return withKinds(entries);
  }
  // A last entry without its newline would fuse with the next one appended.
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) await appendFile(jsonl, "\n");
  return withKinds(entries);
}

/**
 * Claim both files of a new session, so a rerun cannot wipe an earlier one.
 * Exclusive creation refuses an existing file even when it is empty, and two
 * racing launches cannot both claim it. A failed claim removes only the files
 * this attempt created; --force truncates instead and has nothing to undo.
 */
async function reserve(jsonl: string, markdown: string, force: boolean): Promise<void> {
  const created: string[] = [];
  for (const path of [jsonl, markdown]) {
    try {
      await writeFile(path, "", { flag: force ? "w" : "wx" });
      if (!force) created.push(path);
    } catch (error) {
      await Promise.all(created.map((file) => rm(file).catch(() => {})));
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      throw new Error(path === jsonl
        ? `${jsonl} already exists. Continue it with --resume, choose another --out, or pass --force to replace it.`
        : `${markdown} already exists. Choose another --out, or pass --force to replace it.`);
    }
  }
}

/** The absolute basename of the session `base` follows, if any. */
function parentOf(base: string, entries: Entry[]): string | undefined {
  const parent = startMeta(entries)?.parent;
  return parent && absolute(`${dirOf(base)}/${parent}`);
}

/** A repository path saved in `jsonl`, resolved against that log's directory. */
async function resolveRepo(jsonl: string, saved: string): Promise<{ path: string; exists: boolean }> {
  const path = absolute(`${await realpath(dirOf(jsonl))}/${saved}`);
  try {
    return { path: await realpath(path), exists: true };
  } catch {
    return { path, exists: false };
  }
}

const questionOf = (start: Entry) =>start.text.replace(/^Design session started\. Question: /, "");

/**
 * What a follow-up session inherits: for each ancestor, oldest first, its
 * question, its last decision record, and every answer the human gave in it.
 */
async function parentContext(parent: string | undefined, seen = new Set<string>()): Promise<string> {
  if (!parent || seen.has(parent)) return "";
  seen.add(parent);
  const entries = await readLog(`${parent}.jsonl`);
  if (!entries.length) throw new Error(`No turns found in ${parent}.jsonl`);
  const ancestors = await parentContext(parentOf(parent, entries), seen);
  const lastDecision = entries.findLastIndex((entry) => entry.kind === "decision");
  const answers = entries.filter((entry) => entry.kind === "answers");
  const own = [
    `PREVIOUS SESSION (${parent}.md)`,
    `Its question:\n${questionOf(entries[0])}`,
    lastDecision >= 0 ? `Its decision record:\n${entries[lastDecision].text}` : "(It ended without a decision record.)",
    ...answers.map((entry) => `The human's answers to it:\n${entry.text}`),
  ].join("\n\n");
  return [ancestors, own].filter(Boolean).join("\n\n");
}

function minutes(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * A read can return several lines at once, so buffer and split. Returns null at
 * end of input, which drops the session into unmoderated mode.
 */
class LineReader {
  #rest = "";
  #input = process.stdin[Symbol.asyncIterator]();

  async next(): Promise<string | null> {
    for (;;) {
      const end = this.#rest.indexOf("\n");
      if (end >= 0) {
        const line = this.#rest.slice(0, end);
        this.#rest = this.#rest.slice(end + 1);
        return line.trim();
      }
      const chunk = await this.#input.next();
      if (chunk.done) {
        if (!this.#rest) return null;
        const line = this.#rest;
        this.#rest = "";
        return line.trim();
      }
      this.#rest += decoder.decode(chunk.value, { stream: true });
    }
  }

  ask(label: string): Promise<string | null> {
    if (label) console.log(label);
    process.stdout.write("> ");
    return this.next();
  }
}

type Recorder = (speaker: string, text: string, kind: Kind, meta?: Meta | Settings) => Promise<void>;

type Steer =
  | { steer: "continue" | "synthesize" | "more" | "quit" | "unattended" }
  | { steer: "clarify"; question: string };

/**
 * Between turns, let the human redirect the debate instead of watching it drift.
 * After the `last` turn, enter writes the decision record, and `m` adds a round
 * instead, so no synthesis turn is spent on a record that would be superseded.
 */
async function moderate(lines: LineReader, speaker: string, record: Recorder, last: boolean): Promise<Steer> {
  for (;;) {
    const answer = await lines.ask(
      last
        ? `  [enter] write the decision record   [m] one more round   [c] ask ${speaker} to clarify   `
          + "[n] add a note   [q] quit now"
        : `  [enter] next turn   [c] ask ${speaker} to clarify   [n] note to steer it   `
          + "[s] stop and write the decision record   [q] quit now",
    );
    if (answer === null) {
      console.log("  (no more input; continuing unmoderated)\n");
      return { steer: "unattended" };
    }
    const choice = answer.toLowerCase();
    if (choice === "") return { steer: "continue" };
    if (choice === "s") return { steer: "synthesize" };
    if (choice === "q") return { steer: "quit" };
    if (choice === "m" && last) return { steer: "more" };
    if (choice === "c") {
      const question = await lines.ask(`  Question for ${speaker} (one line):`);
      if (question) return { steer: "clarify", question };
      continue;
    }
    if (choice === "n") {
      const note = await lines.ask(`  Note for the ${last ? "decision record or the extra round" : "next turn"} (one line):`);
      if (note) {
        await record("moderator", `Moderator note: ${note}`, "note");
        console.log(`  Noted; the next agent will see it.\n`);
      }
      // A note only adds context; the human still picks what happens next.
      continue;
    }
    console.log(`  Unrecognized: ${JSON.stringify(answer)}`);
  }
}

type Closing = { action: "finish" | "answer" | "more" } | { action: "clarify"; question: string };

/** After the decision record: question its author, answer it, or keep going. */
async function afterRecord(lines: LineReader, author: string): Promise<Closing> {
  for (;;) {
    const answer = await lines.ask(
      `  [enter] finish   [c] ask ${author} about the record   [a] answer the questions for the human   `
        + "[m] one more round and a new record",
    );
    if (answer === null || answer === "") return { action: "finish" };
    const choice = answer.toLowerCase();
    if (choice === "a") return { action: "answer" };
    if (choice === "m") return { action: "more" };
    if (choice === "c") {
      const question = await lines.ask(`  Question for ${author} (one line):`);
      if (question) return { action: "clarify", question };
      continue;
    }
    console.log(`  Unrecognized: ${JSON.stringify(answer)}`);
  }
}

/** Walks the record's questions one at a time; an empty line accepts the recommended default. */
async function answerQuestions(lines: LineReader, decision: string, record: Recorder): Promise<boolean> {
  const questions = questionsForHuman(decision);
  const pairs: string[] = [];
  if (!questions.length) {
    const text = await lines.ask("  No 'Questions for the human' section found. Your answer or ruling (one line):");
    if (!text) return false;
    pairs.push(text);
  }
  for (const [i, question] of questions.entries()) {
    const text = await lines.ask(`\n  Q${i + 1}/${questions.length}: ${question}\n  (enter accepts the recommended default)`);
    if (text === null) break;
    pairs.push(`- Q: ${question}\n  A: ${text || "Accepted the recommended default."}`);
  }
  if (!pairs.length) return false;
  await record("moderator", `Answers to the questions for the human:\n\n${pairs.join("\n")}`, "answers");
  console.log("  Recorded; every later turn sees these answers in full.\n");
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) process.exit(await checkPrerequisites() ? 0 : 1);

  if (options.render) {
    const base = basename(options.out!);
    const existing = await readLog(`${base}.jsonl`, options.recover);
    if (!existing.length) throw new Error(`No turns found in ${base}.jsonl`);
    await writeTextFile(`${base}.md`, markdownDocument(questionOf(existing[0]), existing));
    console.log(`Wrote ${base}.md from ${existing.length} turns.`);
    return;
  }

  if (!await checkPrerequisites()) process.exit(1);

  const given = options.topic_file ? (await readTextFile(options.topic_file)).trim() : options.topic?.trim();
  if (given === "") throw new Error("The design question is empty");
  const answersText = options.answers ? (await readTextFile(options.answers)).trim() : undefined;
  if (options.answers && !answersText) throw new Error(`${options.answers} is empty`);
  const contextText = options.context_file ? (await readTextFile(options.context_file)).trim() : undefined;
  if (options.context_file && !contextText) throw new Error(`${options.context_file} is empty`);
  const noteText = options.note ? (await readTextFile(options.note)).trim() : undefined;
  if (options.note && !noteText) throw new Error(`${options.note} is empty`);

  const base = basename(options.out ?? defaultBasename());
  const jsonl = `${base}.jsonl`;
  const markdown = `${base}.md`;
  const lines = new LineReader();
  let interactive = !options.auto && Boolean(process.stdin.isTTY);

  let entries: Entry[] = [];
  let topic: string;
  let meta: Meta;
  let parent: string | undefined;
  // The settings this run starts from, and the log that saved them: a new
  // follow-up starts from its parent's.
  let saved: Settings = {};
  let savedIn = jsonl;
  const followUp = options.follow_up ? absolute(basename(options.follow_up)) : undefined;
  if (options.resume) {
    entries = await readLog(jsonl, options.recover);
    if (!entries.length) throw new Error(`--resume found no previous turns in ${jsonl}`);
    // The log is the record of what was asked; a changed question file must not rewrite it.
    topic = questionOf(entries[0]);
    if (given !== undefined && given !== topic) {
      throw new Error("This session's question is fixed; use --note to steer it or --follow-up for a new question");
    }
    // Logs from before settings were saved carry no meta; fall back to the flags.
    meta = startMeta(entries) ?? { designer: options.designer ?? "codex" };
    saved = settingsOf(entries);
    if (options.designer && options.designer !== meta.designer) {
      throw new Error(`This session was started with --designer ${meta.designer}`);
    }
    parent = parentOf(base, entries);
    if (followUp && followUp !== parent) {
      throw new Error("--follow-up cannot be added to a session on --resume; start a new session instead");
    }
    // Refresh the readable file now, so it is complete before the next turn lands.
    await writeTextFile(markdown, markdownDocument(topic, entries));
    console.log(`Resuming ${jsonl} with ${entries.length} existing turns.`);
  } else {
    topic = given!;
    const parentEntries = followUp ? await readLog(`${followUp}.jsonl`) : [];
    if (followUp && !parentEntries.length) throw new Error(`--follow-up found no turns in ${followUp}.jsonl`);
    parent = followUp;
    saved = settingsOf(parentEntries);
    if (followUp) savedIn = `${followUp}.jsonl`;
    meta = { designer: options.designer ?? startMeta(parentEntries)?.designer ?? "codex" };
  }
  const context = contextText ?? saved.context ?? "";

  // Paths are stored relative to the log, so a committed log does not carry
  // this machine's paths. Both ends are resolved through symlinks first:
  // `..` in a path written from /var/x means something else from /private/var/x.
  const logDir = await realpath(dirOf(jsonl));
  const savedRepo = saved.repo === undefined ? undefined : await resolveRepo(savedIn, saved.repo);
  if (!options.repo && savedRepo && !savedRepo.exists) {
    throw new Error(`${savedIn} saved the repository as ${saved.repo}, which resolves to ${savedRepo.path} and no `
      + "longer exists. Pass --repo DIR to point the session at the checkout.");
  }
  const repo = await realpath(options.repo ?? savedRepo?.path ?? process.cwd());
  const repoInLog = relativeDir(logDir, repo);
  const updates: [string, Settings][] = [];
  if (!options.resume) {
    meta = {
      ...meta,
      ...(followUp ? { parent: relative(jsonl, followUp) } : {}),
      repo: repoInLog,
      ...(context ? { context } : {}),
    };
  } else {
    // Each change is recorded where the agents can see it, and holds for later runs.
    if (!savedRepo) updates.push([`Repository recorded as ${repoInLog} (relative to this log).`, { repo: repoInLog }]);
    else if (savedRepo.path !== repo) {
      updates.push([
        `Repository changed from ${saved.repo} to ${repoInLog} (relative to this log); entries before this one `
          + "cite the earlier tree.",
        { repo: repoInLog },
      ]);
    }
    if (contextText !== undefined && contextText !== (saved.context ?? "")) {
      updates.push([
        `Repository context ${saved.context ? "replaced" : "set"} for this and later runs (${contextText.length} characters).`,
        { context: contextText },
      ]);
    }
  }
  // Read once: a parent is finished and not written to by this session.
  const inherited = await parentContext(parent);
  const pinned = () => pinnedForPrompt(inherited, entries);

  const overCeiling = (size: number) => new Error(
    `A prompt would be ${size} characters, over the ${MAX_PROMPT_CHARS}-character ceiling (question `
      + `${topic.length}, context ${context.length}, settled records ${pinned().length}; the rest is the transcript). `
      + (sessionStarted ? `Rerun with --resume --out ${base} --context-file SHORTER.md` : "Pass a shorter --context-file")
      + ", or fold a long --follow-up chain's settled points into a fresh question. Moderator notes, and the "
      + "debate given to the decision record, are never trimmed; compaction is not implemented.",
  );
  /**
   * Everything but the transcript is required, so a prompt over the ceiling
   * stops the session rather than reach an agent that cannot hold it. `window`
   * caps the transcript further for turns; synthesis passes Infinity, so the
   * decision record is written from the whole debate or not at all.
   */
  const fitPrompt = (build: (transcript: string) => string, window: number): string => {
    const room = MAX_PROMPT_CHARS - build("").length;
    const { text, omitted } = transcriptForPrompt(entries, window === Infinity ? Infinity : Math.min(window, room));
    const prompt = build(text);
    if (prompt.length > MAX_PROMPT_CHARS) throw overCeiling(prompt.length);
    if (omitted.length) console.log(`  (prompt omits entries ${omitted.join(", ")} for size)`);
    return prompt;
  };

  const record: Recorder = async (speaker, text, kind, entryMeta) => {
    const entry: Entry = { at: new Date().toISOString(), speaker, text, kind, ...(entryMeta ? { meta: entryMeta } : {}) };
    entries.push(entry);
    await appendFile(jsonl, `${JSON.stringify(entry)}\n`);
    await writeTextFile(markdown, markdownDocument(topic, entries));
    sessionStarted = true;
  };

  // Checked before the outputs are claimed, so an oversized context leaves no session behind.
  const settled = [pinned(), answersText, noteText].filter(Boolean).join("\n\n");
  const fixed = agentPrompt("", topic, settled, "", repo, context).length;
  if (fixed > MAX_PROMPT_CHARS) throw overCeiling(fixed);

  if (!options.resume) {
    await reserve(jsonl, markdown, options.force);
    await record("facilitator", `Design session started. Question: ${topic}`, "meta", meta);
  }
  for (const [text, settings] of updates) await record("facilitator", text, "meta", settings);
  if (answersText) await record("moderator", `Answers to the questions for the human:\n\n${answersText}`, "answers");
  if (noteText) await record("moderator", `Moderator note: ${noteText}`, "note");

  // Created only once the outputs are claimed: cleanup runs on a normal exit only.
  const scratch = typeof Deno !== "undefined"
    ? await Deno.makeTempDir({ prefix: "codex-claude-design-" })
    : await mkdtemp(`${tmpdir()}/codex-claude-design-`);
  const codex = codexAgent(repo, scratch, options.codex_model);
  const claude = claudeAgent(repo, options.claude_model);
  const agents: Record<string, Agent> = { codex, claude };
  const designer = meta.designer;
  const reviewer = designer === "claude" ? "codex" : "claude";

  // Only debate turns count; clarifications, notes and answers never shift whose turn it is.
  const spoken = () => entries.filter((entry) => entry.kind === "turn").length;
  // Resuming a finished session adds turns only when --rounds asks for more, even
  // after a record written mid-round by [s]. Its record is reopened rather than
  // written again, unless a note since is addressed to it or the context it was
  // written with has changed; answers and clarifications are not, as in a
  // session neither rewrites the record. A moved repository changes no argument.
  const standing = options.resume ? standingDecision(entries) : undefined;
  let finished = standing !== undefined && (options.rounds ?? 0) * 2 <= spoken();
  const then = standing === undefined ? {} : settingsOf(entries.slice(0, standing + 1));
  const now = settingsOf(entries);
  let kept = finished && then.context === now.context
      && !entries.slice(standing! + 1).some(({ kind }) => kind === "note")
    ? entries[standing!].text
    : undefined;
  if (kept !== undefined && then.repo !== undefined && then.repo !== now.repo) {
    console.log(`The repository moved after this decision record was written; its citations refer to ${then.repo} (relative to the log).\n`);
  }
  let rounds = Math.max(options.rounds ?? 3, Math.ceil(spoken() / 2));
  const startedAt = Date.now();

  console.log(`Repository: ${repo} (read-only)`);
  if (parent) console.log(`Follows:    ${parent}.md`);
  console.log(`Reading:    ${markdown}`);
  console.log(`Log:        ${jsonl}`);
  console.log(interactive ? "Moderated: you are prompted after every turn.\n" : "Unmoderated: running straight through.\n");

  const clarify = async (speaker: string, question: string): Promise<void> => {
    await record("moderator", `Moderator question to ${capitalize(speaker)}: ${question}`, "clarify-question");
    console.log(`[clarification] ${speaker} reading the repo and thinking...`);
    const text = await agents[speaker](
      fitPrompt((transcript) => clarifyPrompt(speaker, topic, pinned(), transcript, question, repo, context), MAX_TRANSCRIPT_CHARS),
    );
    await record(speaker, text, "clarification");
    console.log(`[clarification] ${speaker} done (${minutes(startedAt)} elapsed)\n\n${text}\n`);
  };

  let answered = false;
  let quit = false;
  session:
  for (;;) {
    let steer: Steer["steer"] = "continue";
    debate:
    while (!finished && spoken() < rounds * 2) {
      const turn = spoken();
      if (turn % 2 === 0) console.log(`=== round ${turn / 2 + 1} of ${rounds} ===`);
      const speaker = turn % 2 === 0 ? designer : reviewer;
      const role = speaker === designer ? "the proposing architect" : "the skeptical design reviewer";
      const label = `[turn ${turn + 1}/${rounds * 2 + 1}] ${speaker}`;
      console.log(`${label} reading the repo and thinking...`);
      const text = await agents[speaker](fitPrompt(
        (transcript) => agentPrompt(`${capitalize(speaker)}, ${role}`, topic, pinned(), transcript, repo, context),
        MAX_TRANSCRIPT_CHARS,
      ));
      await record(speaker, text, "turn");
      console.log(`${label} done (${minutes(startedAt)} elapsed)\n\n${text}\n`);
      if (!interactive) continue;

      const last = spoken() === rounds * 2;
      let next = await moderate(lines, speaker, record, last);
      while (next.steer === "clarify") {
        await clarify(speaker, next.question);
        next = await moderate(lines, speaker, record, last);
      }
      if (next.steer === "more") {
        rounds += 1;
      } else if (next.steer === "unattended") {
        interactive = false;
      } else if (next.steer !== "continue") {
        steer = next.steer;
        break debate;
      }
    }

    if (steer === "quit") {
      console.log(`Stopped without a decision record. Read it: ${markdown}`);
      quit = true;
      break;
    }
    finished = false;
    let decision: string;
    if (kept !== undefined) {
      decision = kept;
      kept = undefined;
      console.log("=== decision record (already written) ===");
    } else {
      console.log("=== decision record ===");
      decision = await agents[reviewer](
        fitPrompt((transcript) => synthesisPrompt(topic, pinned(), transcript, context), Infinity),
      );
      await record("facilitator", decision, "decision");
    }
    console.log(`${decision}\n`);
    if (!interactive) break;

    for (;;) {
      const closing = await afterRecord(lines, reviewer);
      if (closing.action === "finish") break session;
      if (closing.action === "clarify") await clarify(reviewer, closing.question);
      if (closing.action === "answer") answered = await answerQuestions(lines, decision, record) || answered;
      if (closing.action === "more") {
        // Completes a half-finished round, or adds one full round.
        rounds = Math.floor(spoken() / 2) + 1;
        answered = false;
        continue session;
      }
    }
  }

  if (!quit) console.log(`Finished in ${minutes(startedAt)}. Read it: ${markdown}`);
  if (!quit) {
    console.log(`${answered ? "Your answers are recorded. " : ""}To build on this later, either continue this transcript:\n`
      + `  --resume --out ${base} --rounds ${Math.floor(spoken() / 2) + 1} [--note STEER.md]\n`
      + "or start a new session on a follow-up question:\n"
      + `  --follow-up ${base} --topic-file NEXT.md --out NEXT-session`);
  }

  await rm(scratch, { recursive: true }).catch(() => {});
}

main().catch((error: unknown) => {
  console.error(`Design session failed: ${error instanceof Error ? error.message : String(error)}`);
  if (sessionStarted) console.error("Turns already written are kept; rerun with --resume to continue.");
  process.exitCode = 1;
});

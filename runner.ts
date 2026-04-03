/**
 * runner.ts
 * Low-level agent process runner — spawns `pi --mode json -p --no-session`
 * and streams structured output back to the caller.
 * Adapted from the official subagent extension example.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentRunConfig {
  /** Display name (used in logs & rendering) */
  name: string;
  /** Task text sent as the user prompt */
  task: string;
  /** System prompt injected via --append-system-prompt */
  systemPrompt?: string;
  /** Override model (e.g. "claude-haiku-4-5") */
  model?: string;
  /** Comma-separated tool whitelist */
  tools?: string[];
  /** Working directory for the subprocess */
  cwd?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface AgentRunResult {
  agentName: string;
  task: string;
  messages: Message[];
  exitCode: number;
  stderr: string;
  /** Final assistant text (last assistant message) */
  output: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function writeTempPrompt(name: string, content: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-mt-"));
  const file = path.join(dir, `${name.replace(/[^\w.-]+/g, "_")}.md`);
  await withFileMutationQueue(file, () =>
    fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 }),
  );
  return { dir, file };
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runAgent(
  config: AgentRunConfig,
  signal?: AbortSignal,
  onUpdate?: (partial: string) => void,
): Promise<AgentRunResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (config.model) args.push("--model", config.model);
  if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  const result: AgentRunResult = {
    agentName: config.name,
    task: config.task,
    messages: [],
    exitCode: 0,
    stderr: "",
    output: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };

  try {
    if (config.systemPrompt?.trim()) {
      const tmp = await writeTempPrompt(config.name, config.systemPrompt);
      tmpDir = tmp.dir;
      tmpFile = tmp.file;
      args.push("--append-system-prompt", tmpFile);
    }

    args.push(`Task: ${config.task}`);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const inv = getPiInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd: config.cwd ?? process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buf = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          result.messages.push(msg);

          if (msg.role === "assistant") {
            result.usage.turns++;
            const u = msg.usage;
            if (u) {
              result.usage.input += u.input ?? 0;
              result.usage.output += u.output ?? 0;
              result.usage.cacheRead += u.cacheRead ?? 0;
              result.usage.cacheWrite += u.cacheWrite ?? 0;
              result.usage.cost += (u as any).cost?.total ?? 0;
            }
            if (!result.model && msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
          }

          const out = getFinalOutput(result.messages);
          if (out) {
            result.output = out;
            onUpdate?.(out);
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (buf.trim()) processLine(buf);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) throw new Error("Agent was aborted");
    result.output = getFinalOutput(result.messages);
    return result;
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

export function formatUsage(u: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns}t`);
  if (u.input) parts.push(`↑${fmt(u.input)}`);
  if (u.output) parts.push(`↓${fmt(u.output)}`);
  if (u.cacheRead) parts.push(`R${fmt(u.cacheRead)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model.split("/").pop() ?? model);
  return parts.join(" ");
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

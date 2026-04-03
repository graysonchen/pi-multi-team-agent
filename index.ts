/**
 * index.ts
 * Multi-Team Agentic Coding Extension for Pi
 *
 * Implements the three-layer architecture from the Gist:
 *   Orchestrator  →  Team Leads  →  Workers
 *
 * Key innovations:
 *   • Domain Locking  — workers can only touch their own file domains
 *   • Mental Models   — per-role expertise injected into every system prompt
 *   • Parallel teams  — all teams execute simultaneously
 *   • Zero micromanagement — leads delegate, never code
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { injectMentalModel, listMentalModels } from "./mental-models.js";
import { type AgentRunResult, formatUsage, runAgent, type UsageStats } from "./runner.js";
import { loadRolePrompt, resolveTeams, type TeamConfig } from "./teams.js";
import { ORCHESTRATOR_PROMPT } from "./prompts.js";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface AgentResult {
  role: string;
  team: string;
  isLead: boolean;
  task: string;
  output: string;
  success: boolean;
  usage: UsageStats;
  model?: string;
}

export interface TeamResult {
  team: string;
  lead?: AgentResult;
  workers: AgentResult[];
}

export type MultiTeamPhase =
  | "decomposing"
  | "executing"
  | "synthesizing"
  | "complete"
  | "error";

export interface MultiTeamDetails {
  phase: MultiTeamPhase;
  task: string;
  activeTeams: string[];
  orchestratorBriefs?: Record<string, string>;
  teamResults: TeamResult[];
  synthesis?: string;
  totalUsage: UsageStats;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function addUsage(a: UsageStats, b: UsageStats): UsageStats {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    turns: a.turns + b.turns,
  };
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Extract the first ```json ... ``` block from text and parse it. */
function extractJSON(text: string): any | null {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch { /* fall through */ }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function defaultBriefs(task: string, teams: string[]): Record<string, string> {
  const defaults: Record<string, string> = {
    planning: `Analyse the architecture and produce a technical plan for:\n\n${task}`,
    engineering: `Implement the following:\n\n${task}`,
    validation: `Design tests and conduct a security review for:\n\n${task}`,
  };
  return Object.fromEntries(teams.map((t) => [t, defaults[t] ?? task]));
}

/** Build the full system prompt for a role: base + optional domain lock + mental model. */
function buildSystemPrompt(
  role: string,
  domainPatterns?: string[],
): string {
  let prompt = loadRolePrompt(role);

  // Domain lock injection (for workers that have a domain defined in team config)
  if (domainPatterns && domainPatterns.length > 0) {
    const patterns = domainPatterns.map((p) => `  - ${p}`).join("\n");
    prompt += `\n\n---\n## ⚠️ Active Domain Lock\nFor this session you may ONLY modify files matching:\n${patterns}\nAny write attempt outside these patterns MUST be refused.`;
  }

  // Mental model injection
  prompt = injectMentalModel(prompt, role);
  return prompt;
}

// ─── Orchestration ────────────────────────────────────────────────────────────

async function runOrchestration(
  task: string,
  activeTeamNames: string[],
  orchestratorModel: string | undefined,
  skipLead: boolean,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: (d: MultiTeamDetails) => void,
): Promise<MultiTeamDetails> {
  const details: MultiTeamDetails = {
    phase: "decomposing",
    task,
    activeTeams: activeTeamNames,
    teamResults: [],
    totalUsage: emptyUsage(),
  };

  const emit = () => onUpdate({ ...details, teamResults: [...details.teamResults] });

  // ── Phase 1: Orchestrator decomposes task ─────────────────────────────────
  emit();

  const orchDecomposePrompt =
    buildSystemPrompt("orchestrator") +
    "\n\n---\n_Mode: DECOMPOSE. Produce the JSON team-brief block. Do not synthesise yet._";

  const orchResult = await runAgent(
    {
      name: "orchestrator",
      task: `Decompose this task for your teams:\n\n${task}`,
      systemPrompt: orchDecomposePrompt,
      model: orchestratorModel,
      tools: ["read", "grep", "find", "ls"],
      cwd,
    },
    signal,
  );

  details.totalUsage = addUsage(details.totalUsage, orchResult.usage);

  const parsed = extractJSON(orchResult.output);
  details.orchestratorBriefs = parsed?.team_briefs
    ? (parsed.team_briefs as Record<string, string>)
    : defaultBriefs(task, activeTeamNames);

  // ── Phase 2: Teams execute in parallel ────────────────────────────────────
  details.phase = "executing";
  emit();

  const teams = resolveTeams(cwd, activeTeamNames);

  const teamResults = await Promise.all(
    teams.map((team) => runTeam(team, details.orchestratorBriefs!, skipLead, cwd, signal, () => emit())),
  );

  details.teamResults = teamResults;
  for (const tr of teamResults) {
    for (const a of [tr.lead, ...tr.workers]) {
      if (a) details.totalUsage = addUsage(details.totalUsage, a.usage);
    }
  }

  // ── Phase 3: Orchestrator synthesises ─────────────────────────────────────
  details.phase = "synthesizing";
  emit();

  const synthContext = buildSynthesisContext(task, teamResults);
  const orchSynthPrompt =
    buildSystemPrompt("orchestrator") +
    "\n\n---\n_Mode: SYNTHESISE. Produce the final unified report._";

  const synthResult = await runAgent(
    {
      name: "orchestrator-synthesis",
      task: synthContext,
      systemPrompt: orchSynthPrompt,
      model: orchestratorModel,
      tools: ["read", "grep", "find", "ls"],
      cwd,
    },
    signal,
  );

  details.totalUsage = addUsage(details.totalUsage, synthResult.usage);
  details.synthesis = synthResult.output;
  details.phase = "complete";
  emit();

  return details;
}

async function runTeam(
  team: TeamConfig,
  briefs: Record<string, string>,
  skipLead: boolean,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
): Promise<TeamResult> {
  const brief = briefs[team.name] ?? `Work on the task for the ${team.name} domain.`;
  const result: TeamResult = { team: team.name, workers: [] };

  // ── Team Lead ──────────────────────────────────────────────────────────────
  let leadOutput = brief;

  if (!skipLead) {
    const lead = team.lead;
    const leadResult = await runAgent(
      {
        name: lead.role,
        task: `Here is your brief from the Orchestrator:\n\n${brief}`,
        systemPrompt: buildSystemPrompt(lead.role),
        model: lead.model,
        tools: lead.tools,
        cwd,
      },
      signal,
    );

    result.lead = toAgentResult(leadResult, lead.role, team.name, true);
    leadOutput = leadResult.output || brief;
    onUpdate();
  }

  // ── Workers (parallel within the team) ────────────────────────────────────
  const workerResults = await Promise.all(
    team.workers.map((worker) =>
      runAgent(
        {
          name: worker.role,
          task: `${leadOutput}`,
          systemPrompt: buildSystemPrompt(worker.role, worker.domain),
          model: worker.model,
          tools: worker.tools,
          cwd,
        },
        signal,
        () => onUpdate(),
      ).then((r) => {
        const ar = toAgentResult(r, worker.role, team.name, false);
        onUpdate();
        return ar;
      }),
    ),
  );

  result.workers = workerResults;
  return result;
}

function toAgentResult(
  r: AgentRunResult,
  role: string,
  team: string,
  isLead: boolean,
): AgentResult {
  const success = r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
  return {
    role,
    team,
    isLead,
    task: r.task,
    output: r.output,
    success,
    usage: r.usage,
    model: r.model,
  };
}

function buildSynthesisContext(task: string, teamResults: TeamResult[]): string {
  const lines: string[] = [`## Original Task\n${task}\n`];
  for (const tr of teamResults) {
    const teamLabel = tr.team.charAt(0).toUpperCase() + tr.team.slice(1);
    lines.push(`## ${teamLabel} Team`);
    if (tr.lead) {
      lines.push(`### ${tr.lead.role} (Lead)\n${tr.lead.output || "(no output)"}\n`);
    }
    for (const w of tr.workers) {
      lines.push(`### ${w.role}\n${w.output || "(no output)"}\n`);
    }
  }
  lines.push("Please synthesise all of the above into the final unified report.");
  return lines.join("\n");
}

// ─── Tool parameters ──────────────────────────────────────────────────────────

const MultiTeamParams = Type.Object({
  task: Type.String({ description: "The high-level task to accomplish." }),
  teams: Type.Optional(
    Type.Array(
      StringEnum(["planning", "engineering", "validation"] as const),
      { description: 'Which teams to activate. Default: all three.' },
    ),
  ),
  model: Type.Optional(
    Type.String({ description: "Model for the Orchestrator (e.g. \"claude-opus-4-5\"). Omit to use pi default." }),
  ),
  skip_lead: Type.Optional(
    Type.Boolean({ description: "Skip Team Lead step and send Orchestrator briefs directly to workers. Default: false." }),
  ),
});

// ─── TUI Rendering ────────────────────────────────────────────────────────────

const PHASE_ICONS: Record<MultiTeamPhase, string> = {
  decomposing: "📋",
  executing: "⚙️",
  synthesizing: "🔬",
  complete: "✅",
  error: "❌",
};

const PHASE_LABELS: Record<MultiTeamPhase, string> = {
  decomposing: "Decomposing task…",
  executing: "Teams executing…",
  synthesizing: "Synthesising results…",
  complete: "Complete",
  error: "Error",
};

function renderAgentResult(ar: AgentResult, theme: any, expanded: boolean): string {
  const icon = ar.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const label = ar.isLead
    ? theme.fg("accent", ar.role) + theme.fg("muted", " [lead]")
    : theme.fg("accent", ar.role);
  let out = `${icon} ${label}`;
  if (ar.usage.turns) {
    out += " " + theme.fg("dim", formatUsage(ar.usage, ar.model));
  }
  if (expanded && ar.output) {
    out += `\n${theme.fg("dim", ar.output.slice(0, 300))}${ar.output.length > 300 ? "…" : ""}`;
  }
  return out;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool registration ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "multi_team",
    label: "Multi-Team",
    description:
      "Orchestrate a three-layer multi-team agentic system: Orchestrator → Team Leads → Workers. " +
      "Implements domain locking, mental models, and parallel execution.",
    promptSnippet:
      "Coordinate planning, engineering, and validation teams with domain-locked workers and accumulated mental models",

    parameters: MultiTeamParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const activeTeams = params.teams ?? ["planning", "engineering", "validation"];
      const skipLead = params.skip_lead ?? false;

      const makeResult = (d: MultiTeamDetails): AgentToolResult<MultiTeamDetails> => ({
        content: [
          {
            type: "text",
            text: d.synthesis
              ? d.synthesis
              : `Phase: ${PHASE_LABELS[d.phase]} | Teams: ${d.activeTeams.join(", ")}`,
          },
        ],
        details: d,
      });

      try {
        const details = await runOrchestration(
          params.task,
          activeTeams,
          params.model,
          skipLead,
          ctx.cwd,
          signal,
          (d) => onUpdate?.(makeResult(d)),
        );
        return makeResult(details);
      } catch (err: any) {
        const errDetails: MultiTeamDetails = {
          phase: "error",
          task: params.task,
          activeTeams,
          teamResults: [],
          totalUsage: emptyUsage(),
          error: err?.message ?? String(err),
        };
        return {
          content: [{ type: "text", text: `Multi-team error: ${errDetails.error}` }],
          details: errDetails,
          isError: true,
        };
      }
    },

    // ── renderCall ────────────────────────────────────────────────────────────
    renderCall(args, theme) {
      const teams = (args.teams ?? ["planning", "engineering", "validation"]).join(", ");
      const preview = args.task
        ? args.task.length > 70
          ? `${args.task.slice(0, 70)}…`
          : args.task
        : "…";
      const text =
        theme.fg("toolTitle", theme.bold("multi_team ")) +
        theme.fg("muted", `[${teams}]`) +
        `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    // ── renderResult ──────────────────────────────────────────────────────────
    renderResult(result, { expanded }, theme) {
      const details = result.details as MultiTeamDetails | undefined;

      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      const phaseIcon = PHASE_ICONS[details.phase];
      const phaseLabel = PHASE_LABELS[details.phase];

      if (!expanded) {
        // ── Collapsed view ────────────────────────────────────────────────────
        let text =
          `${phaseIcon} ` +
          theme.fg("toolTitle", theme.bold("multi_team")) +
          " " +
          theme.fg("accent", phaseLabel);

        if (details.phase === "complete" && details.synthesis) {
          const preview = details.synthesis.slice(0, 200);
          text += `\n${theme.fg("dim", preview)}${details.synthesis.length > 200 ? "…" : ""}`;
        } else {
          for (const tr of details.teamResults) {
            const workerCount = tr.workers.length;
            const doneCount = tr.workers.filter((w) => w.success).length;
            text +=
              `\n  ${theme.fg("muted", tr.team)} ` +
              theme.fg("dim", `${doneCount}/${workerCount} workers`);
          }
        }

        const usageStr = formatUsage(details.totalUsage);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      // ── Expanded view ─────────────────────────────────────────────────────
      const mdTheme = getMarkdownTheme();
      const container = new Container();

      // Header
      container.addChild(
        new Text(
          `${phaseIcon} ` +
          theme.fg("toolTitle", theme.bold("multi_team")) +
          " " +
          theme.fg("accent", phaseLabel) +
          (details.error ? " " + theme.fg("error", details.error) : ""),
          0,
          0,
        ),
      );

      // Task
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", details.task), 0, 0));

      // Orchestrator briefs
      if (details.orchestratorBriefs) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Orchestrator Briefs ───"), 0, 0));
        for (const [team, brief] of Object.entries(details.orchestratorBriefs)) {
          container.addChild(
            new Text(
              theme.fg("accent", team) + theme.fg("dim", `: ${brief.slice(0, 100)}${brief.length > 100 ? "…" : ""}`),
              0,
              0,
            ),
          );
        }
      }

      // Teams
      for (const tr of details.teamResults) {
        container.addChild(new Spacer(1));
        const teamLabel = tr.team.charAt(0).toUpperCase() + tr.team.slice(1);
        container.addChild(new Text(theme.fg("muted", `─── ${teamLabel} Team ───`), 0, 0));

        if (tr.lead) {
          container.addChild(new Text(renderAgentResult(tr.lead, theme, true), 0, 0));
        }
        for (const w of tr.workers) {
          container.addChild(new Text(renderAgentResult(w, theme, true), 0, 0));
        }
      }

      // Synthesis
      if (details.synthesis) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Synthesis ───"), 0, 0));
        container.addChild(new Markdown(details.synthesis.trim(), 0, 0, mdTheme));
      }

      // Total usage
      const usageStr = formatUsage(details.totalUsage);
      if (usageStr) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
      }

      return container;
    },
  });

  // ── /mt command (shorthand) ────────────────────────────────────────────────
  pi.registerCommand("mt", {
    description:
      "Shorthand for the multi_team tool. Usage: /mt <task>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /mt <task description>", "info");
        return;
      }
      ctx.ui.notify(`🚀 Launching multi-team for: ${args.slice(0, 60)}…`, "info");
      pi.sendUserMessage(
        `Use the multi_team tool with this task: ${args}`,
        { deliverAs: "followUp" },
      );
    },
  });

  // ── /mt-models command — list mental models ────────────────────────────────
  pi.registerCommand("mt-models", {
    description: "List all stored agent mental models",
    handler: async (_args, ctx) => {
      const models = listMentalModels();
      if (models.length === 0) {
        ctx.ui.notify("No mental models stored yet. They build up after each multi_team run.", "info");
      } else {
        ctx.ui.notify(`Mental models stored for: ${models.join(", ")}`, "info");
      }
    },
  });

  // ── session_start — report loaded mental models ────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const models = listMentalModels();
    if (models.length > 0) {
      ctx.ui.setStatus("multi-team", `🧠 ${models.length} mental model${models.length > 1 ? "s" : ""} active`);
    }
  });
}

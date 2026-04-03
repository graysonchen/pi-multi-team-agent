/**
 * teams.ts
 * Team topology and configuration.
 * Users can override defaults by creating `.pi/multi-team.json` in their project.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as BUILTIN from "./prompts.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentRole {
  role: string;
  /** Model override (e.g. "claude-haiku-4-5"). Omit to use pi default. */
  model?: string;
  /** Tool whitelist. Omit to use pi defaults. */
  tools?: string[];
  /** Domain-lock glob patterns (written into system prompt). Empty = no lock. */
  domain?: string[];
}

export interface TeamConfig {
  name: string;
  lead: AgentRole;
  workers: AgentRole[];
}

// ─── Default topology ────────────────────────────────────────────────────────

export const DEFAULT_TEAMS: Record<string, TeamConfig> = {
  planning: {
    name: "planning",
    lead: {
      role: "planning-lead",
      model: "claude-haiku-4-5",
      tools: ["read", "grep", "find", "ls"],
    },
    workers: [
      {
        role: "architect",
        tools: ["read", "grep", "find", "ls"],
      },
    ],
  },

  engineering: {
    name: "engineering",
    lead: {
      role: "engineering-lead",
      model: "claude-haiku-4-5",
      tools: ["read", "grep", "find", "ls"],
    },
    workers: [
      {
        role: "backend-dev",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        domain: ["backend/**/*", "src/**/*.py", "api/**/*", "*.py", "requirements*.txt", "pyproject.toml"],
      },
      {
        role: "frontend-dev",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        domain: ["frontend/**/*", "src/**/*.ts", "src/**/*.tsx", "src/**/*.vue", "src/**/*.jsx", "*.css", "*.scss"],
      },
    ],
  },

  validation: {
    name: "validation",
    lead: {
      role: "validation-lead",
      model: "claude-haiku-4-5",
      tools: ["read", "grep", "find", "ls"],
    },
    workers: [
      {
        role: "qa-engineer",
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
        domain: ["tests/**/*", "test/**/*", "spec/**/*", "**/*.test.*", "**/*.spec.*", "conftest.py"],
      },
      {
        role: "security-reviewer",
        // Read-only: no edit/write
        tools: ["read", "bash", "grep", "find", "ls"],
      },
    ],
  },
};

// ─── Builtin prompt map ───────────────────────────────────────────────────────

const BUILTIN_PROMPTS: Record<string, string> = {
  "orchestrator": BUILTIN.ORCHESTRATOR_PROMPT,
  "planning-lead": BUILTIN.PLANNING_LEAD_PROMPT,
  "engineering-lead": BUILTIN.ENGINEERING_LEAD_PROMPT,
  "validation-lead": BUILTIN.VALIDATION_LEAD_PROMPT,
  "architect": BUILTIN.ARCHITECT_PROMPT,
  "backend-dev": BUILTIN.BACKEND_DEV_PROMPT,
  "frontend-dev": BUILTIN.FRONTEND_DEV_PROMPT,
  "qa-engineer": BUILTIN.QA_ENGINEER_PROMPT,
  "security-reviewer": BUILTIN.SECURITY_REVIEWER_PROMPT,
};

// ─── System prompt loading ────────────────────────────────────────────────────

/**
 * Load a role's system prompt.
 * Priority: ~/.pi/agent/agents/mt-{role}.md  >  builtin string
 */
export function loadRolePrompt(role: string): string {
  const userFile = path.join(getAgentDir(), "agents", `mt-${role}.md`);
  try {
    const raw = fs.readFileSync(userFile, "utf-8");
    const { body } = parseFrontmatter<Record<string, string>>(raw);
    if (body.trim()) return body.trim();
  } catch {
    /* not found — fall through */
  }
  return BUILTIN_PROMPTS[role] ?? "";
}

// ─── Project config override ──────────────────────────────────────────────────

export function loadProjectTeamConfig(cwd: string): Partial<Record<string, TeamConfig>> {
  const configPath = path.join(cwd, ".pi", "multi-team.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function resolveTeams(
  cwd: string,
  activeNames: string[],
): TeamConfig[] {
  const overrides = loadProjectTeamConfig(cwd);
  return activeNames.map((name) => {
    const base = DEFAULT_TEAMS[name];
    if (!base) throw new Error(`Unknown team: "${name}"`);
    return overrides[name] ? { ...base, ...(overrides[name] as TeamConfig) } : base;
  });
}

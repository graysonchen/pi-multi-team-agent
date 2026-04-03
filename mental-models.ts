/**
 * mental-models.ts
 * Per-agent expertise persistence.
 * Each agent role gets a markdown file at ~/.pi/agent/mental-models/mt-{role}.md
 * that accumulates knowledge across sessions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export function getMentalModelsDir(): string {
  return path.join(getAgentDir(), "mental-models");
}

function modelPath(role: string): string {
  const safe = role.replace(/[^\w.-]+/g, "_");
  return path.join(getMentalModelsDir(), `mt-${safe}.md`);
}

/** Read the stored expertise for a role. Returns null if none exists yet. */
export function loadMentalModel(role: string): string | null {
  try {
    return fs.readFileSync(modelPath(role), "utf-8");
  } catch {
    return null;
  }
}

/** Append the expertise section to an existing system prompt. */
export function injectMentalModel(systemPrompt: string, role: string): string {
  const model = loadMentalModel(role);
  if (!model) return systemPrompt;
  return `${systemPrompt}\n\n---\n## Your Accumulated Expertise (Mental Model)\n\n${model}`;
}

/** Persist an updated mental model for a role. */
export async function saveMentalModel(role: string, content: string): Promise<void> {
  const dir = getMentalModelsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(modelPath(role), content.trim(), "utf-8");
}

/** List all roles that have a stored mental model. */
export function listMentalModels(): string[] {
  const dir = getMentalModelsDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("mt-") && f.endsWith(".md"))
      .map((f) => f.slice(3, -3)); // strip "mt-" prefix and ".md" suffix
  } catch {
    return [];
  }
}

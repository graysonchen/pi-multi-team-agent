# pi-multi-team-extension

> A [pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that implements the **Multi-Team Agentic Coding** architecture.
>
> Inspired by: *"Multi-Team Agentic Coding: The Next Frontier Beyond Cloud Code"*

---

## Architecture

```
┌─────────────────────┐
│     Orchestrator    │  ← Sole entry point. Decomposes tasks & synthesises results.
│  (strongest model)  │
└──────────┬──────────┘
           │  delegates briefs
     ┌─────┴──────┬──────────────┐
     ▼            ▼              ▼
┌─────────┐ ┌──────────┐ ┌────────────┐
│Planning │ │Engineering│ │ Validation │  ← Team Leads (never do hands-on work)
│  Lead   │ │   Lead   │ │    Lead    │
└────┬────┘ └─────┬────┘ └─────┬──────┘
     │            │             │
┌────┴────┐  ┌────┴──────┐ ┌───┴──────────────────┐
│Architect│  │Backend Dev│ │QA Engineer  Security  │
│         │  │Frontend   │ │            Reviewer   │
│         │  │Dev        │ │                       │
└─────────┘  └───────────┘ └───────────────────────┘
  Workers       Workers            Workers
```

### Key Innovations

| Feature | Description |
|---------|-------------|
| **Domain Locking** | Each worker only modifies files in its own domain (e.g. `backend/**`, `frontend/**`) |
| **Mental Models** | Per-role expertise files accumulated across sessions and injected at runtime |
| **Zero Micromanagement** | Leads coordinate; they never produce deliverables themselves |
| **Parallel Teams** | All teams execute simultaneously after Orchestrator decomposes the task |

---

## Installation

```bash
git clone https://github.com/graysonchen/pi-multi-team-agent
```

**Option A — symlink（推荐）**

pi 自动发现 `~/.pi/agent/extensions/` 下的所有目录：

```bash
ln -s /path/to/pi-multi-team-agent ~/.pi/agent/extensions/multi-team
```

**Option B — settings.json**

Clone 到任意路径，在 `~/.pi/agent/settings.json` 里注册：

```json
{
  "extensions": [
    "/path/to/pi-multi-team-agent"
  ]
}
```

然后在 pi 里重载：
```
/reload
```

---

## Usage

### Via the `multi_team` tool
Ask pi to use it:
```
Use the multi_team tool to add OAuth 2.0 login to this project
```

### Via the `/mt` command shorthand
```
/mt Add a rate-limiting middleware to the API
```

### Managing Mental Models
```
/mt-models   # list all stored expertise files
```

---

## Tool Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | `string` | required | The high-level task to accomplish |
| `teams` | `string[]` | all three | Which teams to activate: `"planning"`, `"engineering"`, `"validation"` |
| `model` | `string` | pi default | Orchestrator model override (e.g. `"claude-opus-4-5"`) |
| `skip_lead` | `boolean` | `false` | Skip Team Lead step, send Orchestrator briefs directly to workers |

---

## Execution Flow

```
Phase 1: DECOMPOSE  (Orchestrator)
         ↓ JSON team briefs
Phase 2: EXECUTE    (all teams in parallel)
         each team: Lead → Workers (parallel within team)
         ↓ all team outputs
Phase 3: SYNTHESISE (Orchestrator)
         ↓ unified final report
```

---

## Mental Models

Each agent role accumulates expertise across sessions:

```
~/.pi/agent/mental-models/
├── mt-architect.md
├── mt-backend-dev.md
├── mt-frontend-dev.md
├── mt-qa-engineer.md
└── mt-security-reviewer.md
```

These files are injected into every agent's system prompt automatically.  
Edit them manually to seed domain-specific knowledge for your project.

---

## Customising Agents

Override any built-in agent by creating a file at:
```
~/.pi/agent/agents/mt-{role}.md
```

Use YAML frontmatter to set the model and tools:
```markdown
---
name: mt-backend-dev
description: Custom backend dev for our Django stack
model: claude-sonnet-4-5
tools: read,bash,edit,write,grep,find,ls
---

Your custom system prompt here...
```

---

## Project-Level Configuration

Create `.pi/multi-team.json` in your project root to override team topology:

```json
{
  "engineering": {
    "workers": [
      {
        "role": "backend-dev",
        "model": "claude-opus-4-5",
        "tools": ["read", "bash", "edit", "write"],
        "domain": ["app/**/*.rb", "db/**/*", "config/**/*"]
      }
    ]
  }
}
```

---

## File Structure

```
~/.pi/agent/extensions/multi-team/
├── index.ts            Main extension entry point + multi_team tool
├── runner.ts           Low-level pi subprocess runner
├── mental-models.ts    Per-role expertise persistence
├── teams.ts            Team topology and configuration
├── prompts.ts          Built-in system prompts for all roles
└── agents/             Reference agent definition files (user-customisable)
    ├── orchestrator.md
    ├── planning-lead.md
    ├── engineering-lead.md
    ├── validation-lead.md
    ├── architect.md
    ├── backend-dev.md
    ├── frontend-dev.md
    ├── qa-engineer.md
    └── security-reviewer.md
```

---

## Default Team Models

| Role | Default Model | Rationale |
|------|--------------|-----------|
| Orchestrator | pi default | Strongest available for coordination |
| Team Leads | `claude-haiku-4-5` | Fast routing, minimal tokens |
| Workers | pi default | Full capability for implementation |

---

## Domain Lock Reference

| Worker | Can Write |
|--------|-----------|
| `backend-dev` | `backend/**`, `src/**/*.py`, `api/**`, `*.py`, `requirements*.txt` |
| `frontend-dev` | `frontend/**`, `src/**/*.ts/tsx/vue/jsx`, `*.css`, `*.scss` |
| `qa-engineer` | `tests/**`, `test/**`, `spec/**`, `**/*.test.*`, `**/*.spec.*` |
| `security-reviewer` | *Read-only* — no writes |
| `architect` | *Read-only* — recommendations only |
| Leads | *Read-only* — coordination only |

---

## Credits

Architecture inspired by the video analysis in:  
[Multi-Team Agentic Coding System Analysis](https://gist.github.com/graysonchen/dff918c42e1eeeb61570e1b2dfbbe3d7)

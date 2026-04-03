# pi-multi-team-agent

> [pi coding agent](https://github.com/mariozechner/pi-coding-agent) 的扩展插件，实现了**多团队智能体编码**架构。
>
> 灵感来源：*《多团队智能体编码：超越 Cloud Code 的下一个前沿》*

🌐 [English Documentation](README.md)

---

## 架构设计

```
┌─────────────────────┐
│      Orchestrator   │  ← 唯一入口，负责任务分解与结果综合
│     （最强模型）     │
└──────────┬──────────┘
           │  分发任务简报
     ┌─────┴──────┬──────────────┐
     ▼            ▼              ▼
┌─────────┐ ┌──────────┐ ┌────────────┐
│ 规划    │ │  工程    │ │   验证     │  ← Team Leads（只协调，不动手）
│ Lead    │ │  Lead    │ │   Lead     │
└────┬────┘ └─────┬────┘ └─────┬──────┘
     │            │             │
┌────┴────┐  ┌────┴──────┐ ┌───┴──────────────────┐
│ 架构师  │  │ 后端开发  │ │ QA 工程师   安全审查  │
│         │  │ 前端开发  │ │                       │
└─────────┘  └───────────┘ └───────────────────────┘
   Workers       Workers            Workers
```

### 核心创新点

| 特性 | 说明 |
|------|------|
| **域锁定（Domain Locking）** | 每个 Worker 只能修改自己域内的文件（如 `backend/**`、`frontend/**`） |
| **心智模型（Mental Models）** | 每个角色的专业知识跨会话积累，运行时自动注入系统提示 |
| **零微管理（Zero Micromanagement）** | Lead 只负责协调，从不亲自产出代码或文档 |
| **并行执行** | Orchestrator 分解任务后，所有团队同时并行执行 |

---

## 安装

```bash
git clone https://github.com/graysonchen/pi-multi-team-agent
```

**方式 A — symlink（推荐）**

pi 会自动发现 `~/.pi/agent/extensions/` 下的所有目录：

```bash
ln -s /path/to/pi-multi-team-agent ~/.pi/agent/extensions/multi-team
```

**方式 B — settings.json**

Clone 到任意路径，在 `~/.pi/agent/settings.json` 中注册：

```json
{
  "extensions": [
    "/path/to/pi-multi-team-agent"
  ]
}
```

然后在 pi 中重载：
```
/reload
```

---

## 使用方法

### 通过 `multi_team` 工具

让 pi 直接调用：
```
Use the multi_team tool to add OAuth 2.0 login to this project
```

### 通过 `/mt` 快捷命令
```
/mt 为 API 添加限流中间件
```

### 查看心智模型
```
/mt-models   # 列出所有已存储的专业知识文件
```

---

## 工具参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `task` | `string` | 必填 | 要完成的高层次任务描述 |
| `teams` | `string[]` | 全部三个 | 激活的团队：`"planning"`、`"engineering"`、`"validation"` |
| `model` | `string` | pi 默认 | Orchestrator 使用的模型（如 `"claude-opus-4-5"`） |
| `skip_lead` | `boolean` | `false` | 跳过 Team Lead 步骤，直接将简报发给 Workers |

---

## 执行流程

```
阶段 1：DECOMPOSE  （Orchestrator 分解任务）
         ↓ JSON 格式的团队简报
阶段 2：EXECUTE    （所有团队并行执行）
         每个团队内部：Lead → Workers（Worker 间并行）
         ↓ 所有团队输出汇总
阶段 3：SYNTHESISE （Orchestrator 综合结果）
         ↓ 统一的最终报告
```

---

## 心智模型

每个角色的专业知识跨会话持续积累，存储于：

```
~/.pi/agent/mental-models/
├── mt-architect.md
├── mt-backend-dev.md
├── mt-frontend-dev.md
├── mt-qa-engineer.md
└── mt-security-reviewer.md
```

这些文件会在每次运行时自动注入到对应角色的系统提示中。  
也可以手动编辑，预置项目专属的领域知识。

---

## 自定义 Agent

在以下路径创建文件即可覆盖任意内置角色的提示词：
```
~/.pi/agent/agents/mt-{role}.md
```

使用 YAML frontmatter 指定模型和工具：
```markdown
---
name: mt-backend-dev
description: 针对 Django 技术栈的后端开发者
model: claude-sonnet-4-5
tools: read,bash,edit,write,grep,find,ls
---

在此编写自定义系统提示...
```

---

## 项目级配置

在项目根目录创建 `.pi/multi-team.json` 可覆盖团队拓扑：

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

## 文件结构

```
pi-multi-team-agent/
├── index.ts            主扩展入口 + multi_team 工具注册
├── runner.ts           pi 子进程运行器
├── mental-models.ts    心智模型持久化
├── teams.ts            团队拓扑与配置
├── prompts.ts          所有角色的内置系统提示词
└── agents/             可自定义的 Agent 定义文件
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

## 默认模型配置

| 角色 | 默认模型 | 原因 |
|------|----------|------|
| Orchestrator | pi 默认模型 | 协调任务，使用最强可用模型 |
| Team Leads | `claude-haiku-4-5` | 仅做路由，速度快、消耗少 |
| Workers | pi 默认模型 | 实际执行，需要完整能力 |

---

## 域锁定参考

| Worker | 可写路径 |
|--------|----------|
| `backend-dev` | `backend/**`、`src/**/*.py`、`api/**`、`*.py`、`requirements*.txt` |
| `frontend-dev` | `frontend/**`、`src/**/*.ts/tsx/vue/jsx`、`*.css`、`*.scss` |
| `qa-engineer` | `tests/**`、`test/**`、`spec/**`、`**/*.test.*`、`**/*.spec.*` |
| `security-reviewer` | *只读* — 不做任何写操作 |
| `architect` | *只读* — 仅输出建议 |
| Leads | *只读* — 仅做协调 |

---

## 参考资料

架构设计来源于以下分析文档：  
[多团队智能体编码系统分析总结](https://gist.github.com/graysonchen/dff918c42e1eeeb61570e1b2dfbbe3d7)

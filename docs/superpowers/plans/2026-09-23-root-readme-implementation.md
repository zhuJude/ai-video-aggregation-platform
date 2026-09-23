# Root README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a truthful, comprehensive GitHub landing README that introduces the product and gives engineers a verified path into the repository.

**Architecture:** Keep the GitHub entry point in one root `README.md`, with stable high-level information inline and links to detailed specifications, plans, and runbooks. Derive commands, versions, module names, and delivery boundaries from the current `develop` tree rather than duplicating volatile implementation details.

**Tech Stack:** GitHub Flavored Markdown, Mermaid, Node.js 24, pnpm 11.24.0, Turborepo, Docker Compose

---

### Task 1: Author the repository landing page

**Files:**
- Create: `README.md`
- Reference: `package.json`
- Reference: `pnpm-workspace.yaml`
- Reference: `infra/local/compose.yaml`
- Reference: `infra/local/compose.services.yaml`
- Reference: `docs/superpowers/specs/2026-08-28-ai-video-aggregation-platform-design.md`
- Reference: `docs/runbooks/deployment.md`

- [ ] **Step 1: Confirm the root README does not already exist**

Run:

```powershell
Test-Path README.md
```

Expected: `False`.

- [ ] **Step 2: Create the complete README**

Create `README.md` with these concrete sections in order:

```markdown
# AI 视频聚合平台

> 面向用户与运营团队的 AI 视频生成聚合平台。

## 项目状态
## 产品能力
### 用户工作台
### 运营控制台
## 交付边界
## 系统架构
## 仓库结构
## 技术栈
## 快速开始
## 常用命令
## Git 协作
## 部署与运维
## 文档索引
## 安全说明
## License
```

The delivery-boundary table must distinguish code-complete capabilities from external account configuration. The architecture section must contain one GitHub-compatible Mermaid flowchart covering the two web apps, edge gateway, domain services, provider runtime, infrastructure, and observability. The quick-start commands must use `corepack`, `pnpm install --frozen-lockfile`, the two Compose files, and `pnpm verify`.

- [ ] **Step 3: Format the README**

Run:

```powershell
corepack pnpm exec prettier --write README.md
```

Expected: Prettier reports `README.md` without an error.

### Task 2: Validate documentation integrity

**Files:**
- Verify: `README.md`

- [ ] **Step 1: Check Markdown whitespace and repository state**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` prints no errors, and status lists only the README and implementation-plan changes expected by this task.

- [ ] **Step 2: Validate all local README links**

Extract every relative Markdown link from `README.md`, remove anchors, resolve it from the repository root, and fail if any target does not exist.

Expected: every local link resolves to an existing file or directory.

- [ ] **Step 3: Check version and command claims against source files**

Run:

```powershell
Select-String -Path README.md -Pattern 'Node.js 24','pnpm 11.24.0','pnpm verify','infra/local/compose.yaml','infra/local/compose.services.yaml'
```

Expected: all five verified setup facts occur in the README.

- [ ] **Step 4: Run the documentation-relevant repository checks**

Run:

```powershell
corepack pnpm exec prettier --check README.md docs/superpowers/specs/2026-09-23-root-readme-design.md docs/superpowers/plans/2026-09-23-root-readme-implementation.md
docker compose -f infra/local/compose.yaml config --quiet
docker compose -f infra/local/compose.yaml -f infra/local/compose.services.yaml config --quiet
```

Expected: all commands exit with code `0`.

### Task 3: Commit and publish

**Files:**
- Add: `README.md`
- Add: `docs/superpowers/plans/2026-09-23-root-readme-implementation.md`

- [ ] **Step 1: Commit the documentation**

Run:

```powershell
git add README.md docs/superpowers/plans/2026-09-23-root-readme-implementation.md
git commit -m "docs: add project README"
```

Expected: Git creates one documentation commit on `develop`.

- [ ] **Step 2: Push and verify the remote branch**

Run:

```powershell
git push origin develop
git ls-remote origin refs/heads/develop
git rev-parse develop
```

Expected: the remote and local `develop` commit SHAs are identical.

# Changelog

All notable changes and customizations made to **SuperSaiya** (OpenCode Antigravity Edition).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.18.35-custom] - 2026-10-08

### 🚀 Universal Model Provider Router (No Vendor Lock-in)
- **Dynamic Model Auto-Synthesis**:
  - Dynamically synthesizes `Model` definitions on-the-fly when querying newly released or unlisted models, eliminating `ModelNotFoundError`.
  - Heuristic detection for reasoning/thinking capabilities (`r1`, `o1`, `o3`, `reason`, `claude-3-7`, `thinking`), vision modalities (`4o`, `vl`, `vision`), tool calling, and context limits up to 1M tokens.
- **Built-in Local & Cloud Aggregators**:
  - Out-of-the-box support for **Ollama** (`http://127.0.0.1:11434/v1`), **LM Studio** (`http://127.0.0.1:1234/v1`), **LocalAI**, and **vLLM**.
  - Direct integration for **DeepSeek**, **Groq**, **OpenRouter**, **Together AI**, and arbitrary OpenAI-compatible gateways.
  - Automatically avoids pruning zero-model configured providers by injecting default synthetic endpoints.
- **Provider Management CLI**:
  - Added `opencode providers add <provider> [--url <url>] [--key <key>] [--name <name>]` to configure arbitrary providers into `opencode.json`.
  - Added `opencode providers set-key <provider> <key>` to set API keys directly without interactive wizards.

---

### 🔌 Enhanced Model Context Protocol (MCP) System
- **Profiles & Filtering**:
  - Added MCP `profiles` and `active_profile` support in V1 and V2 schemas.
  - Granular permissions: tool whitelist (`tools`), blacklist (`deny_tools` / `denyTools`), and resource permissions.
  - Core runtime filtering (`matchesPattern`, `isToolAllowed`, `isServerAllowedByProfile`) preventing unauthorized tool invocation and skipping dormant servers during boot.
- **MCP CLI Suite**:
  - Added `opencode mcp enable <name>` and `opencode mcp disable <name>`.
  - Added `opencode mcp remove <name>` (aliases: `rm`, `delete`).
  - Added `opencode mcp tools [name]` to inspect discovered tools and permissions.
  - Added `opencode mcp profile [list|use|create]` for switching active profiles.
- **TUI Bulk Actions**:
  - Added bulk `enable all` and `disable all` actions in `DialogMcp`.
  - Surface detailed server failure messages directly in the dialog UI.

---

### 🧠 Skill System & Auto-Discovery
- **Skill Engine**:
  - Extended `Skill.Info` schema with `triggers`, `version`, `author`, `dependencies` (tools and MCP servers), and `tags`.
  - Multi-path auto-discovery:
    - Global: `~/.config/supersaiya/skills`, `~/.config/opencode/skills`, `~/.skills`
    - Local project: `.skills`, `skills`, `.opencode/skills`
  - Intelligent intent matcher (`matchScore`) ranking skills by trigger phrases (+15 pts), tags, and descriptions.
- **Skill CLI Commands**:
  - Added `opencode skill list`, `show <name>`, `match <query>`, `create <name> [--global]`, and `paths`.
- **TUI Integration & Sample Skills**:
  - Display trigger badges and required MCP servers in `DialogSkill`.
  - Bundled starter skills: `web-scraping` (requiring `firecrawl` MCP) and `code-review` (requiring `read`/`grep` tools).

---

### 💬 Conversation & Session Personalization
- **Bulk Cleanup**:
  - Added `opencode session clear [--all] [--older-than <days>] [--force]` (aliases: `delete-all`, `prune`) with safety confirmation prompt.
- **Search & Discovery**:
  - Added `opencode session search <query>` (alias: `find`) for querying session history by title and content.
- **Transcript Export**:
  - Added `opencode session export <sessionID> [--format markdown|json] [--output <path>]` (alias: `dump`) to export full conversations with roles, timestamps, and tool calls.
- **Prompt Enhancements**:
  - Added interactive `confirm` helper to CLI effect prompts.

---

### 📦 Native Ubuntu / Debian Packaging (.deb)
- **Packaging Pipeline**:
  - Created `script/build-deb.ts` for automated native compilation via Bun.
  - Created `script/build-deb.sh` for Debian/Ubuntu native package generation.
  - Added `"package:deb": "bun run script/build-deb.ts"` in `package.json`.
- **System Integration**:
  - Installs executable to `/usr/bin/opencode`.
  - Generates desktop launcher at `/usr/share/applications/opencode.desktop`.
  - Includes `postinst` and `prerm` maintainer scripts with desktop database updates.

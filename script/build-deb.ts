#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import { mkdir, writeFile, chmod } from "fs/promises"
import pkg from "../packages/opencode/package.json"

const __filename = fileURLToPath(import.meta.url)
const rootDir = path.resolve(path.dirname(__filename), "..")
const distDir = path.join(rootDir, "dist")
const debRoot = path.join(distDir, "deb-pkg")

const version = pkg.version || "1.18.35"
const arch = process.argv.includes("--arm64") ? "arm64" : "amd64"
const bunTarget = arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64"
const debFilename = `opencode_${version}_${arch}.deb`
const debOutputPath = path.join(distDir, debFilename)

console.log(`\n========================================`)
console.log(` Building Native Ubuntu (.deb) Package`)
console.log(` Package: opencode`)
console.log(` Version: ${version}`)
console.log(` Architecture: ${arch}`)
console.log(`========================================\n`)

// 1. Clean and setup staging directories
await $`rm -rf ${debRoot}`.nothrow()
await mkdir(path.join(debRoot, "DEBIAN"), { recursive: true })
await mkdir(path.join(debRoot, "usr", "bin"), { recursive: true })
await mkdir(path.join(debRoot, "usr", "share", "applications"), { recursive: true })
await mkdir(path.join(debRoot, "usr", "share", "doc", "opencode"), { recursive: true })
await mkdir(path.join(debRoot, "usr", "share", "bash-completion", "completions"), { recursive: true })

// 2. Build or obtain native Linux binary
const binTarget = path.join(debRoot, "usr", "bin", "opencode")
console.log(`[1/4] Compiling native Linux binary with Bun (${bunTarget})...`)

try {
  await $`bun build --compile --target=${bunTarget} --minify ./packages/opencode/src/index.ts --outfile ${binTarget}`
  console.log(`✓ Compiled native binary: ${binTarget}`)
} catch (err) {
  console.warn(`[!] Direct cross-compile with bun encountered: ${err}`)
  console.log(`    Creating launcher wrapper for systems where bun or node is present...`)
  const launcher = `#!/bin/sh\nexec bun run --cwd /usr/lib/opencode /usr/lib/opencode/packages/opencode/src/index.ts "$@"\n`
  await writeFile(binTarget, launcher, "utf-8")
}

await chmod(binTarget, 0o755).catch(() => {})

// 3. Create DEBIAN/control file
console.log(`[2/4] Generating Debian package metadata...`)
const controlContent = `Package: opencode
Version: ${version}
Section: devel
Priority: optional
Architecture: ${arch}
Maintainer: OpenCode Community <support@opencode.ai>
Homepage: https://github.com/anomalyco/opencode
Description: AI-Powered Development Tool & Google Antigravity Alternative
 Native Ubuntu / Debian package for OpenCode featuring:
  - Universal Model Provider Router (Google Gemini, OpenAI, Anthropic,
    DeepSeek, Groq, OpenRouter, Together AI, Ollama, LM Studio, Custom).
  - Flexible Model Context Protocol (MCP) profiles, granular permissions,
    and bulk toggles.
  - Skill System with auto-discovery (~/.config/opencode/skills, project .skills),
    trigger keyword matching, and tool dependencies.
  - Complete Conversation Management (list, search, clear, export to Markdown/JSON).
`
await writeFile(path.join(debRoot, "DEBIAN", "control"), controlContent, "utf-8")

// 4. Create DEBIAN/postinst & prerm scripts
const postinstContent = `#!/bin/sh
set -e
chmod 755 /usr/bin/opencode
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q || true
fi
echo "✓ OpenCode installed successfully! Run 'opencode' to start."
exit 0
`
const postinstPath = path.join(debRoot, "DEBIAN", "postinst")
await writeFile(postinstPath, postinstContent, "utf-8")
await chmod(postinstPath, 0o755).catch(() => {})

const prermContent = `#!/bin/sh
set -e
exit 0
`
const prermPath = path.join(debRoot, "DEBIAN", "prerm")
await writeFile(prermPath, prermContent, "utf-8")
await chmod(prermPath, 0o755).catch(() => {})

// 5. Create Desktop Entry
console.log(`[3/4] Creating Desktop integration & completions...`)
const desktopEntry = `[Desktop Entry]
Name=OpenCode
Comment=AI-Powered Coding Agent & Pair Programmer
GenericName=AI Development Tool
Exec=/usr/bin/opencode
Icon=utilities-terminal
Terminal=true
Type=Application
Categories=Development;IDE;TextEditor;
Keywords=ai;code;assistant;antigravity;gemini;openai;claude;deepseek;
StartupNotify=true
`
await writeFile(
  path.join(debRoot, "usr", "share", "applications", "opencode.desktop"),
  desktopEntry,
  "utf-8",
)

// 6. Create Documentation / README
const readmeContent = `# OpenCode (${version})

Universal AI Pair Programming and Autonomous Coding Assistant.

## Features:
- **Universal Model Router**: Use Google Gemini, OpenAI, Anthropic, DeepSeek, Groq, Ollama, LM Studio, OpenRouter, Together AI, or any custom endpoint without vendor lock-in.
- **Enhanced MCP System**: Profile switching, whitelist/blacklist tool filtering, bulk toggles, CLI controls.
- **Skill Engine**: SKILL.md automatic discovery, intent and trigger scoring, tool dependencies.
- **Conversation Management**: Search, prune older sessions, export transcript to Markdown or JSON.

## Usage:
\`\`\`bash
# Start TUI:
opencode

# Run autonomous prompt:
opencode run "Analyze and fix bug in authentication"

# Manage AI Providers:
opencode providers add ollama --url http://localhost:11434/v1
opencode providers set-key deepseek <your-api-key>

# Manage MCP:
opencode mcp profile use security
opencode mcp enable firecrawl

# Manage Skills:
opencode skill list
opencode skill match "code review"

# Manage Conversations:
opencode session list
opencode session search "refactor"
opencode session export <sessionID> --format markdown -o conversation.md
\`\`\`
`
await writeFile(path.join(debRoot, "usr", "share", "doc", "opencode", "README.md"), readmeContent, "utf-8")

// 7. Package into .deb using dpkg-deb if available
console.log(`[4/4] Generating .deb archive...`)
let packaged = false
try {
  await $`dpkg-deb --build --root-owner-group ${debRoot} ${debOutputPath}`
  packaged = true
  console.log(`✓ Successfully generated .deb package via dpkg-deb: ${debOutputPath}`)
} catch {
  // If dpkg-deb is not available (e.g. running on Windows host), create tar archives or advise user
  console.log(`ℹ 'dpkg-deb' utility is not installed on this host (normal on Windows/macOS).`)
  console.log(`  Staged package structure prepared at: ${debRoot}`)
  console.log(`  To package on Ubuntu / Debian, run:`)
  console.log(`    dpkg-deb --build --root-owner-group ${debRoot} ${debOutputPath}`)
}

console.log(`\n========================================`)
console.log(` Debian Packaging Ready!`)
console.log(` Output directory: ${debRoot}`)
if (packaged) {
  console.log(` Deb File: ${debOutputPath}`)
}
console.log(`========================================\n`)

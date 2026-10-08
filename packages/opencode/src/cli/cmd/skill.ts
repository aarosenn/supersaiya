import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Effect } from "effect"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Skill } from "../../skill"
import { InstanceRef } from "@/effect/instance-ref"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import path from "path"

export const SkillListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all available skills and their triggers",
  handler: Effect.fn("Cli.skill.list")(function* () {
    UI.empty()
    prompts.intro("Installed Skills")

    const skillService = yield* Skill.Service
    const skills = yield* skillService.all()

    if (skills.length === 0) {
      prompts.log.warn("No skills found")
      prompts.log.info("Create a new skill with: opencode skill create <name>")
      prompts.outro("Done")
      return
    }

    const sorted = skills.toSorted((a, b) => a.name.localeCompare(b.name))

    for (const item of sorted) {
      const isEnabled = item.enabled !== false
      const icon = isEnabled ? "🟢" : "⚪"
      const statusText = isEnabled ? "enabled" : "disabled"

      let meta = ""
      if (item.version) meta += ` v${item.version}`
      if (item.author) meta += ` by ${item.author}`

      const desc = item.description ? `\n    ${item.description}` : ""
      const triggers = item.triggers && item.triggers.length > 0 ? `\n    ${UI.Style.TEXT_DIM}Triggers: ${item.triggers.join(", ")}` : ""
      const depsMcp = item.dependencies?.mcp?.length ? `\n    ${UI.Style.TEXT_DIM}Requires MCP: ${item.dependencies.mcp.join(", ")}` : ""
      const depsTools = item.dependencies?.tools?.length ? `\n    ${UI.Style.TEXT_DIM}Requires Tools: ${item.dependencies.tools.join(", ")}` : ""
      const loc = `\n    ${UI.Style.TEXT_DIM}Path: ${item.location}`

      prompts.log.info(
        `${icon} ${UI.Style.BOLD}${item.name}${UI.Style.RESET}${UI.Style.TEXT_DIM}${meta} (${statusText})${UI.Style.RESET}${desc}${triggers}${depsMcp}${depsTools}${loc}`,
      )
    }

    prompts.outro(`${skills.length} skill(s) registered`)
  }),
})

export const SkillShowCommand = effectCmd({
  command: "show <name>",
  describe: "show details and instructions for a specific skill",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the skill",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.skill.show")(function* (args) {
    UI.empty()
    prompts.intro(`Skill Details: ${args.name}`)

    const skillService = yield* Skill.Service
    const info = yield* skillService.get(args.name)

    if (!info) {
      prompts.log.error(`Skill "${args.name}" not found`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`${UI.Style.BOLD}Name:${UI.Style.RESET} ${info.name}`)
    if (info.version) prompts.log.info(`${UI.Style.BOLD}Version:${UI.Style.RESET} ${info.version}`)
    if (info.author) prompts.log.info(`${UI.Style.BOLD}Author:${UI.Style.RESET} ${info.author}`)
    prompts.log.info(`${UI.Style.BOLD}Status:${UI.Style.RESET} ${info.enabled !== false ? "🟢 Enabled" : "⚪ Disabled"}`)
    prompts.log.info(`${UI.Style.BOLD}Location:${UI.Style.RESET} ${info.location}`)

    if (info.description) {
      prompts.log.info(`${UI.Style.BOLD}Description:${UI.Style.RESET} ${info.description}`)
    }

    if (info.triggers && info.triggers.length > 0) {
      prompts.log.info(`${UI.Style.BOLD}Triggers:${UI.Style.RESET} ${info.triggers.join(", ")}`)
    }

    if (info.dependencies?.mcp?.length) {
      prompts.log.info(`${UI.Style.BOLD}Required MCP Servers:${UI.Style.RESET} ${info.dependencies.mcp.join(", ")}`)
    }

    if (info.dependencies?.tools?.length) {
      prompts.log.info(`${UI.Style.BOLD}Required Tools:${UI.Style.RESET} ${info.dependencies.tools.join(", ")}`)
    }

    if (info.tags && info.tags.length > 0) {
      prompts.log.info(`${UI.Style.BOLD}Tags:${UI.Style.RESET} ${info.tags.join(", ")}`)
    }

    prompts.log.info(`\n${UI.Style.BOLD}--- Instructions (SKILL.md) ---${UI.Style.RESET}\n${info.content.trim()}`)

    prompts.outro("Done")
  }),
})

export const SkillMatchCommand = effectCmd({
  command: "match <query>",
  describe: "test intent matching against installed skills",
  builder: (yargs) =>
    yargs.positional("query", {
      describe: "user prompt or query to match",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.skill.match")(function* (args) {
    UI.empty()
    prompts.intro(`Matching skills for: "${args.query}"`)

    const skillService = yield* Skill.Service
    const matches = yield* skillService.findMatching(args.query)

    if (matches.length === 0) {
      prompts.log.warn("No matching skills found for this query")
      prompts.outro("Done")
      return
    }

    for (let i = 0; i < matches.length; i++) {
      const skill = matches[i]
      const rank = `#${i + 1}`
      const triggers = skill.triggers?.length ? ` [triggers: ${skill.triggers.join(", ")}]` : ""
      prompts.log.success(
        `${rank} ${UI.Style.BOLD}${skill.name}${UI.Style.RESET}${triggers}\n   ${skill.description ?? "No description"}`,
      )
    }

    prompts.outro(`${matches.length} matching skill(s) found`)
  }),
})

export const SkillCreateCommand = effectCmd({
  command: "create <name>",
  describe: "scaffold a new skill directory with template SKILL.md",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the new skill (kebab-case)",
        type: "string",
        demandOption: true,
      })
      .option("global", {
        describe: "create as global skill in user config",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.skill.create")(function* (args) {
    UI.empty()
    prompts.intro(`Create New Skill: ${args.name}`)

    const name = args.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
    const baseDir = yield* InstanceRef.directory
    const globalService = yield* Global.Service

    const targetParent = args.global
      ? path.join(globalService.home, ".config", "supersaiya", "skills")
      : path.join(baseDir, ".opencode", "skills")

    const skillDir = path.join(targetParent, name)
    const skillFilePath = path.join(skillDir, "SKILL.md")

    const alreadyExists = yield* Effect.promise(() => Filesystem.exists(skillFilePath))
    if (alreadyExists) {
      prompts.log.error(`Skill already exists at: ${skillFilePath}`)
      prompts.outro("Failed")
      return
    }

    const templateContent = `---
name: ${name}
description: Scaffolding for ${name} skill
version: 1.0.0
triggers:
  - "${name.replace(/-/g, " ")}"
dependencies:
  mcp: []
  tools: ["bash"]
tags:
  - "custom"
---

# ${name} Skill

## Overview
Describe what this skill does and the common tasks it helps accomplish.

## Instructions
1. Step-by-step guidance for the AI assistant when this skill is invoked.
2. Best practices and rules.
3. Examples of queries and expected outputs.
`

    yield* Effect.promise(async () => {
      await Filesystem.write(skillFilePath, templateContent)
    })

    prompts.log.success(`Created skill at: ${skillFilePath}`)
    prompts.log.info("Edit the SKILL.md file to customize triggers, MCP dependencies, and instructions.")
    prompts.outro("Done")
  }),
})

export const SkillPathsCommand = effectCmd({
  command: "paths",
  describe: "show all directories scanned for skills",
  handler: Effect.fn("Cli.skill.paths")(function* () {
    UI.empty()
    prompts.intro("Skill Discovery Paths")

    const skillService = yield* Skill.Service
    const dirs = yield* skillService.dirs()

    if (dirs.length === 0) {
      prompts.log.warn("No skill directories discovered yet")
    } else {
      for (const dir of dirs) {
        prompts.log.info(`📁 ${dir}`)
      }
    }

    prompts.outro(`${dirs.length} directory path(s) found`)
  }),
})

export const SkillCommand = cmd({
  command: "skill",
  describe: "manage skills (Model Context Instructions & Workflows)",
  builder: (yargs) =>
    yargs
      .command(SkillListCommand)
      .command(SkillShowCommand)
      .command(SkillMatchCommand)
      .command(SkillCreateCommand)
      .command(SkillPathsCommand)
      .demandCommand(),
  async handler() {},
})

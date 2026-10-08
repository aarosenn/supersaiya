import type { Argv } from "yargs"
import { Effect, Option } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import * as Prompt from "../effect/prompt"

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionDeleteCommand)
      .command(SessionClearCommand)
      .command(SessionSearchCommand)
      .command(SessionExportCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

export const SessionClearCommand = effectCmd({
  command: "clear",
  aliases: ["delete-all", "prune"],
  describe: "clear or prune sessions",
  builder: (yargs) =>
    yargs
      .option("all", {
        alias: "a",
        describe: "delete all sessions without filter",
        type: "boolean",
      })
      .option("older-than", {
        describe: "delete sessions older than N days",
        type: "number",
      })
      .option("force", {
        alias: "f",
        describe: "skip confirmation prompt",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.session.clear")(function* (args) {
    const svc = yield* Session.Service
    const sessions = yield* svc.list({ roots: true })

    if (sessions.length === 0) {
      UI.println("No sessions found.")
      return
    }

    const now = Date.now()
    const targetSessions = sessions.filter((s) => {
      if (args.olderThan !== undefined) {
        const threshold = now - args.olderThan * 24 * 60 * 60 * 1000
        return s.time.updated < threshold
      }
      return true
    })

    if (targetSessions.length === 0) {
      UI.println("No matching sessions found to delete.")
      return
    }

    if (!args.force) {
      const confirmed = yield* promptValue(
        yield* Prompt.confirm({
          message: `Are you sure you want to delete ${targetSessions.length} session(s)?`,
        }),
      )
      if (!confirmed) {
        UI.println("Cancelled.")
        return
      }
    }

    let deletedCount = 0
    for (const session of targetSessions) {
      yield* svc.remove(session.id).pipe(Effect.catchAll(() => Effect.void))
      deletedCount++
    }

    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `✓ Deleted ${deletedCount} session(s).` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionSearchCommand = effectCmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search sessions by keyword",
  builder: (yargs) =>
    yargs.positional("query", {
      describe: "search query",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.search")(function* (args) {
    const svc = yield* Session.Service
    const sessions = yield* svc.list({ roots: true, search: args.query })

    if (sessions.length === 0) {
      UI.println(`No sessions matching "${args.query}".`)
      return
    }

    UI.println(formatSessionTable(sessions))
  }),
})

export const SessionExportCommand = effectCmd({
  command: "export <sessionID>",
  aliases: ["dump"],
  describe: "export a session conversation to Markdown or JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID to export",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "export format",
        type: "string",
        choices: ["markdown", "json"],
        default: "markdown",
      })
      .option("output", {
        alias: "o",
        describe: "output file path (defaults to stdout)",
        type: "string",
      }),
  handler: Effect.fn("Cli.session.export")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    const session = yield* svc
      .get(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    const messages = yield* svc
      .messages({ sessionID })
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Messages not found for: ${args.sessionID}`)))

    let output = ""
    if (args.format === "json") {
      output = JSON.stringify({ session, messages }, null, 2)
    } else {
      const lines: string[] = []
      lines.push(`# Session: ${session.title}`)
      lines.push(`- **ID**: \`${session.id}\``)
      lines.push(`- **Created**: ${new Date(session.time.created).toISOString()}`)
      lines.push(`- **Updated**: ${new Date(session.time.updated).toISOString()}`)
      if (session.agent) lines.push(`- **Agent**: ${session.agent}`)
      if (session.model) lines.push(`- **Model**: ${session.model.providerID}/${session.model.id}`)
      lines.push("")
      lines.push("---")
      lines.push("")

      for (const msg of messages) {
        const role = msg.info.role === "user" ? "User" : "Assistant"
        lines.push(`### ${role} (${new Date(msg.info.time.created).toLocaleString()})`)
        lines.push("")
        for (const part of msg.parts) {
          if (part.type === "text") {
            lines.push(part.text)
            lines.push("")
          } else if (part.type === "tool") {
            lines.push(`> **Tool Call: \`${part.tool}\`**`)
            if (part.state.status === "completed") {
              lines.push("```json")
              lines.push(JSON.stringify(part.state.output, null, 2))
              lines.push("```")
            }
            lines.push("")
          }
        }
      }
      output = lines.join(EOL)
    }

    if (args.output) {
      await Filesystem.writeText(path.resolve(args.output), output)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + `✓ Session exported to ${args.output}` + UI.Style.TEXT_NORMAL)
    } else {
      console.log(output)
    }
  }),
})

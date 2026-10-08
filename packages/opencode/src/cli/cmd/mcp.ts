import { cmd } from "./cmd"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Effect } from "effect"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

type McpConfigured = ConfigMCPV1.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: ConfigV1.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: ConfigV1.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: "manage MCP (Model Context Protocol) servers",
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpEnableCommand)
      .command(McpDisableCommand)
      .command(McpRemoveCommand)
      .command(McpToolsCommand)
      .command(McpProfileCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Add servers with: opencode mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.log.info("Remote MCP servers support OAuth by default. Add a remote server in opencode.json:")
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to authenticate",
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(`MCP server not found: ${serverName}`)
      prompts.outro("Done")
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(`MCP server ${serverName} is not an OAuth-capable remote server`)
      prompts.outro("Done")
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: `${serverName} already has valid credentials. Re-authenticate?`,
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Authorize in your browser:")
        prompts.log.info(url)
        spinner.start("Waiting for authorization...")
      }),
    ).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop("Authentication successful!")
          } else if (status.status === "needs_client_registration") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
            prompts.log.info("Add clientId to your MCP server config:")
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop("Authentication failed", 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop("Unexpected status: " + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
    )

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn("No MCP OAuth credentials stored")
      prompts.outro("Done")
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: "Select MCP server to logout",
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = "tokens + client"
            else if (hasTokens) hint = "tokens"
            else if (hasClient) hint = "client registration"
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      prompts.log.error(`No credentials found for: ${serverName}`)
      prompts.outro("Done")
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(`Removed OAuth credentials for ${serverName}`)
    prompts.outro("Done")
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .opencode/ subdirectory too)
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to opencode.json if none exist
  return candidates[0]
}

async function addMcpToConfig(name: string, mcpConfig: ConfigMCPV1.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

async function updateMcpFieldInConfig(name: string, field: string, value: any, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, ["mcp", name, field], value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

async function removeMcpFromConfig(name: string, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, ["mcp", name], undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

async function updateConfigProfile(profileName: string, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, ["mcp_profile"], profileName, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

async function addProfileToConfig(profileName: string, servers: string[], configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }
  const edits = modify(text, ["mcp_profiles", profileName], servers, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)
  await Filesystem.write(configPath, result)
  return configPath
}

export const McpEnableCommand = effectCmd({
  command: "enable <name>",
  describe: "enable an MCP server in configuration",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server to enable",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.enable")(function* (args) {
    UI.empty()
    prompts.intro("Enable MCP Server")

    const cfg = yield* Config.Service
    const config = yield* cfg.get()
    const serverName = args.name

    if (!config.mcp?.[serverName]) {
      prompts.log.error(`MCP server not found in configuration: ${serverName}`)
      prompts.outro("Done")
      return
    }

    const baseDir = yield* InstanceRef.directory
    const configPath = yield* Effect.promise(() => resolveConfigPath(baseDir))
    yield* Effect.promise(() => updateMcpFieldInConfig(serverName, "enabled", true, configPath))

    prompts.log.success(`Enabled MCP server: ${serverName}`)
    prompts.outro("Done")
  }),
})

export const McpDisableCommand = effectCmd({
  command: "disable <name>",
  describe: "disable an MCP server in configuration",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server to disable",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.disable")(function* (args) {
    UI.empty()
    prompts.intro("Disable MCP Server")

    const cfg = yield* Config.Service
    const config = yield* cfg.get()
    const serverName = args.name

    if (!config.mcp?.[serverName]) {
      prompts.log.error(`MCP server not found in configuration: ${serverName}`)
      prompts.outro("Done")
      return
    }

    const baseDir = yield* InstanceRef.directory
    const configPath = yield* Effect.promise(() => resolveConfigPath(baseDir))
    yield* Effect.promise(() => updateMcpFieldInConfig(serverName, "enabled", false, configPath))

    prompts.log.success(`Disabled MCP server: ${serverName}`)
    prompts.outro("Done")
  }),
})

export const McpRemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm", "delete"],
  describe: "remove an MCP server from configuration",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server to remove",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.remove")(function* (args) {
    UI.empty()
    prompts.intro("Remove MCP Server")

    const cfg = yield* Config.Service
    const config = yield* cfg.get()
    const serverName = args.name

    if (!config.mcp?.[serverName]) {
      prompts.log.error(`MCP server not found in configuration: ${serverName}`)
      prompts.outro("Done")
      return
    }

    const confirm = yield* Effect.promise(() =>
      prompts.confirm({
        message: `Are you sure you want to remove MCP server "${serverName}"?`,
      }),
    )
    if (prompts.isCancel(confirm) || !confirm) {
      prompts.outro("Cancelled")
      return
    }

    const baseDir = yield* InstanceRef.directory
    const configPath = yield* Effect.promise(() => resolveConfigPath(baseDir))
    yield* Effect.promise(() => removeMcpFromConfig(serverName, configPath))

    // Clear any credentials
    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName)).pipe(Effect.ignore)

    prompts.log.success(`Removed MCP server: ${serverName}`)
    prompts.outro("Done")
  }),
})

export const McpToolsCommand = effectCmd({
  command: "tools [name]",
  describe: "list all tools exposed by MCP server(s)",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "filter by specific MCP server name",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.tools")(function* (args) {
    UI.empty()
    prompts.intro("MCP Server Tools")

    const spinner = prompts.spinner()
    spinner.start("Connecting and querying tools...")

    const mcp = yield* MCP.Service
    const allTools = yield* mcp.tools()

    spinner.stop("Tools fetched")

    const target = args.name
    const toolEntries = Object.entries(allTools).filter(([toolName]) => {
      if (!target) return true
      return toolName.startsWith(`${target}_`) || toolName.startsWith(`${target}-`)
    })

    if (toolEntries.length === 0) {
      prompts.log.warn(target ? `No tools found for server: ${target}` : "No tools exposed by connected MCP servers")
      prompts.outro("Done")
      return
    }

    for (const [toolName, tool] of toolEntries) {
      const desc = tool.def.description ? `\n    ${UI.Style.TEXT_DIM}${tool.def.description}` : ""
      const props = tool.def.inputSchema?.properties
        ? `\n    ${UI.Style.TEXT_DIM}Parameters: ${Object.keys(tool.def.inputSchema.properties).join(", ")}`
        : ""
      prompts.log.info(`⚡ ${UI.Style.BOLD}${toolName}${UI.Style.RESET}${desc}${props}`)
    }

    prompts.outro(`${toolEntries.length} tool(s) available`)
  }),
})

export const McpProfileCommand = effectCmd({
  command: "profile <action> [profile]",
  describe: "manage MCP server profiles (list, use, create)",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "action to perform: list, use, create",
        type: "string",
        choices: ["list", "ls", "use", "create", "set"],
      })
      .positional("profile", {
        describe: "profile name",
        type: "string",
      })
      .option("servers", {
        describe: "comma-separated server names for create action",
        type: "string",
      }),
  handler: Effect.fn("Cli.mcp.profile")(function* (args) {
    UI.empty()
    prompts.intro("MCP Profiles")

    const cfg = yield* Config.Service
    const config = yield* cfg.get()
    const baseDir = yield* InstanceRef.directory
    const configPath = yield* Effect.promise(() => resolveConfigPath(baseDir))

    const action = args.action
    const profileName = args.profile
    const activeProfile = config.mcp_profile ?? process.env.OPENCODE_MCP_PROFILE ?? "default (all)"
    const profiles = config.mcp_profiles ?? {}

    if (action === "list" || action === "ls") {
      prompts.log.info(`Active Profile: ${UI.Style.BOLD}${activeProfile}${UI.Style.RESET}`)
      const entries = Object.entries(profiles)
      if (entries.length === 0) {
        prompts.log.warn("No named profiles configured in mcp_profiles")
        prompts.log.info("Create one with: opencode mcp profile create <name> --servers=server1,server2")
      } else {
        for (const [name, servers] of entries) {
          const isCurrent = name === config.mcp_profile ? " (active)" : ""
          prompts.log.info(`- ${UI.Style.BOLD}${name}${isCurrent}${UI.Style.RESET}: ${servers.join(", ")}`)
        }
      }
      prompts.outro("Done")
      return
    }

    if (action === "use" || action === "set") {
      if (!profileName) {
        prompts.log.error("Please provide a profile name: opencode mcp profile use <name>")
        prompts.outro("Done")
        return
      }

      yield* Effect.promise(() => updateConfigProfile(profileName, configPath))
      prompts.log.success(`Set active MCP profile to: ${profileName}`)
      prompts.outro("Done")
      return
    }

    if (action === "create") {
      if (!profileName) {
        prompts.log.error("Please provide a profile name: opencode mcp profile create <name> --servers=s1,s2")
        prompts.outro("Done")
        return
      }

      const servers = args.servers
        ? (args.servers as string).split(",").map((s) => s.trim()).filter(Boolean)
        : ["*"]

      yield* Effect.promise(() => addProfileToConfig(profileName, servers, configPath))
      prompts.log.success(`Created MCP profile "${profileName}" with servers: ${servers.join(", ")}`)
      prompts.outro("Done")
      return
    }

    prompts.log.warn(`Unknown action: ${action}`)
    prompts.outro("Done")
  }),
})

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      const command = args["--"] ?? []
      if (!args.name && (args.url || args.env?.length || args.header?.length || command.length)) {
        throw new Error("A server name is required for non-interactive MCP configuration")
      }
      if (args.name) {
        if (!!args.url === !!command.length) {
          throw new Error("Provide either --url <url> or a command after --")
        }
        if (args.url && !URL.canParse(args.url)) {
          throw new Error(`Invalid URL: ${args.url}`)
        }
        if (args.url && args.env?.length) {
          throw new Error("--env is only valid for local MCP servers")
        }
        if (command.length && args.header?.length) {
          throw new Error("--header is only valid for remote MCP servers")
        }

        const entries = (values: string[], kind: string) =>
          Object.fromEntries(
            values.map((entry) => {
              const index = entry.indexOf("=")
              if (index < 1) throw new Error(`Invalid ${kind}: ${entry}. Expected KEY=VALUE`)
              return [entry.slice(0, index), entry.slice(index + 1)]
            }),
          )
        const environment = entries(args.env ?? [], "environment variable")
        const headers = entries(args.header ?? [], "HTTP header")
        const mcpConfig: ConfigMCPV1.Info = args.url
          ? {
              type: "remote",
              url: args.url,
              ...(Object.keys(headers).length ? { headers } : {}),
            }
          : {
              type: "local",
              command,
              ...(Object.keys(environment).length ? { environment } : {}),
            }

        const configPath = await resolveConfigPath(Global.Path.config, true)
        await addMcpToConfig(args.name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${args.name}" added to ${configPath}`)
        return
      }

      UI.empty()
      prompts.intro("Add MCP server")

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(ctx.worktree),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: "Location",
          options: [
            {
              label: "Current project",
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: "Global",
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: "Enter MCP server name",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: "Select MCP server type",
        options: [
          {
            label: "Local",
            value: "local",
            hint: "Run a local command",
          },
          {
            label: "Remote",
            value: "remote",
            hint: "Connect to a remote URL",
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: "Enter command to run",
          placeholder: "e.g., opencode x @modelcontextprotocol/server-filesystem",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCPV1.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
        prompts.outro("MCP server added successfully")
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: "Enter MCP server URL",
          placeholder: "e.g., https://example.com/mcp",
          validate: (x) => {
            if (!x) return "Required"
            if (x.length === 0) return "Required"
            const isValid = URL.canParse(x)
            return isValid ? undefined : "Invalid URL"
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: "Does this server require OAuth authentication?",
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCPV1.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: "Do you have a pre-registered client ID?",
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: "Enter client ID",
              validate: (x) => (x && x.length > 0 ? undefined : "Required"),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: "Do you have a client secret?",
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: "Enter client secret",
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(`MCP server "${name}" added to ${configPath}`)
      }

      prompts.outro("MCP server added successfully")
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const serverConfig = config.mcp?.[args.name]
    const authInfo =
      serverConfig && isMcpRemote(serverConfig) && serverConfig.oauth !== false
        ? yield* Effect.all({
            authStatus: mcp.getAuthStatus(args.name),
            entry: auth.get(args.name),
          })
        : undefined
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const serverName = args.name

      if (!serverConfig) {
        prompts.log.error(`MCP server not found: ${serverName}`)
        prompts.outro("Done")
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(`MCP server ${serverName} is not a remote server`)\n        prompts.outro("Done")\n        return\n      }\n\n      if (serverConfig.oauth === false) {\n        prompts.log.warn(`MCP server ${serverName} has OAuth explicitly disabled`)\n        prompts.outro("Done")\n        return\n      }\n\n      prompts.log.info(`Server: ${serverName}`)\n      prompts.log.info(`URL: ${serverConfig.url}`)\n\n      const { authStatus, entry } = authInfo!\n      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)\n\n      if (entry?.tokens) {\n        prompts.log.info(\n          `  Access token: ${entry.tokens.accessToken.length > 8 ? `${entry.tokens.accessToken.slice(0, 4)}***${entry.tokens.accessToken.slice(-4)}` : \"***\"}`,\n        )\n        if (entry.tokens.expiresAt) {\n          const expiresDate = new Date(entry.tokens.expiresAt * 1000)\n          const isExpired = entry.tokens.expiresAt < Date.now() / 1000\n          prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? \"(EXPIRED)\" : \"\"}`)\n        }\n        if (entry.tokens.refreshToken) {\n          prompts.log.info(`  Refresh token: present`)\n        }\n      }\n      if (entry?.clientInfo) {\n        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)\n        if (entry.clientInfo.clientSecretExpiresAt) {\n          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)\n          prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)\n        }\n      }\n\n      const spinner = prompts.spinner()\n      spinner.start(\"Testing connection...\")\n\n      // Test basic HTTP connectivity first\n      try {\n        const response = await fetch(serverConfig.url, {\n          method: \"POST\",\n          headers: {\n            ...serverConfig.headers,\n            \"Content-Type\": \"application/json\",\n            Accept: \"application/json, text/event-stream\",\n          },\n          body: JSON.stringify({\n            jsonrpc: \"2.0\",\n            method: \"initialize\",\n            params: {\n              protocolVersion: LATEST_PROTOCOL_VERSION,\n              capabilities: {},\n              clientInfo: { name: \"opencode-debug\", version: InstallationVersion },\n            },\n            id: 1,\n          }),\n        })\n\n        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)\n\n        // Check for WWW-Authenticate header\n        const wwwAuth = response.headers.get(\"www-authenticate\")\n        if (wwwAuth) {\n          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)\n        }\n\n        if (response.status === 401) {\n          prompts.log.info(\"Initial unauthenticated check returned 401, so this server requires OAuth\")\n\n          // Try to discover OAuth metadata\n          const oauthConfig = typeof serverConfig.oauth === \"object\" ? serverConfig.oauth : undefined\n          const authProvider = new McpOAuthProvider(\n            serverName,\n            serverConfig.url,\n            {\n              clientId: oauthConfig?.clientId,\n              clientSecret: oauthConfig?.clientSecret,\n              scope: oauthConfig?.scope,\n              redirectUri: oauthConfig?.redirectUri,\n            },\n            {\n              onRedirect: async () => {},\n            },\n            auth,\n          )\n\n          prompts.log.info(\"Testing OAuth flow (without completing authorization)...\")\n\n          // Try creating transport with auth provider to trigger discovery\n          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {\n            authProvider,\n            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,\n          })\n\n          try {\n            const client = new Client({\n              name: \"opencode-debug\",\n              version: InstallationVersion,\n            })\n            await client.connect(transport)\n            prompts.log.success(\"Connection successful (already authenticated)\")\n            await client.close()\n          } catch (error) {\n            if (error instanceof UnauthorizedError) {\n              prompts.log.info(`OAuth flow triggered: ${error.message}`)\n\n              // Check if dynamic registration would be attempted\n              const clientInfo = await authProvider.clientInformation()\n              if (clientInfo) {\n                prompts.log.info(`Client ID available: ${clientInfo.client_id}`)\n              } else {\n                prompts.log.info(\"No client ID - dynamic registration will be attempted\")\n              }\n            } else {\n              prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)\n            }\n          }\n        } else if (response.status >= 200 && response.status < 300) {\n          prompts.log.success(\"Server responded successfully (no auth required or already authenticated)\")\n          const body = await response.text()\n          try {\n            const json = JSON.parse(body)\n            if (json.result?.serverInfo) {\n              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)\n            }\n          } catch {\n            // Not JSON, ignore\n          }\n        } else {\n          prompts.log.warn(`Unexpected status: ${response.status}`)\n          const body = await response.text().catch(() => \"\")\n          if (body) {\n            prompts.log.info(`Response body: ${body.substring(0, 500)}`)\n          }\n        }\n      } catch (error) {\n        spinner.stop(\"Connection failed\", 1)\n        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)\n      }\n\n      prompts.outro(\"Debug complete\")\n    })\n  }),\n})\n
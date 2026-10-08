import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  const seen = new Set<string>()
  return [model, ...recent]
    .filter((item) => {
      const key = `${item.providerID}/${item.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      const [agentStore, setAgentStore] = createStore({
        current: undefined as string | undefined,
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents().at(0)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]\n        },\n      }\n    }\n\n    const agent = createAgent()\n\n    function createModel() {\n      const [modelStore, setModelStore] = createStore<{\n        ready: boolean\n        model: Record<\n          string,\n          {\n            providerID: string\n            modelID: string\n          }\n        >\n        recent: {\n          providerID: string\n          modelID: string\n        }[]\n        favorite: {\n          providerID: string\n          modelID: string\n        }[]\n        variant: Record<string, string | undefined>\n      }>({\n        ready: false,\n        model: {},\n        recent: [],\n        favorite: [],\n        variant: {},\n      })\n\n      const filePath = path.join(paths.state, \"model.json\")\n      const state = {\n        pending: false,\n      }\n\n      function save() {\n        if (!modelStore.ready) {\n          state.pending = true\n          return\n        }\n        state.pending = false\n        void writeJsonAtomic(filePath, {\n          recent: modelStore.recent,\n          favorite: modelStore.favorite,\n          variant: modelStore.variant,\n        })\n      }\n\n      readJson<unknown>(filePath)\n        .then((x) => {\n          if (!x || typeof x !== \"object\") return\n          const value = x as Record<string, unknown>\n          if (Array.isArray(value.recent)) setModelStore(\"recent\", value.recent)\n          if (Array.isArray(value.favorite)) setModelStore(\"favorite\", value.favorite)\n          if (typeof value.variant === \"object\" && value.variant !== null)\n            setModelStore(\"variant\", value.variant as Record<string, string | undefined>)\n        })\n        .catch(() => {})\n        .finally(() => {\n          setModelStore(\"ready\", true)\n          if (state.pending) save()\n        })\n\n      const fallbackModel = createMemo(() => {\n        if (args.model) {\n          const { providerID, modelID } = parseModel(args.model)\n          if (isModelValid({ providerID, modelID })) {\n            return {\n              providerID,\n              modelID,\n            }\n          }\n        }\n\n        if (sync.data.config.model) {\n          const { providerID, modelID } = parseModel(sync.data.config.model)\n          if (isModelValid({ providerID, modelID })) {\n            return {\n              providerID,\n              modelID,\n            }\n          }\n        }\n\n        for (const item of modelStore.recent) {\n          if (isModelValid(item)) {\n            return item\n          }\n        }\n\n        const provider = sync.data.provider[0]\n        if (!provider) return undefined\n        const defaultModel = sync.data.provider_default[provider.id]\n        const firstModel = Object.values(provider.models)[0]\n        const model = defaultModel ?? firstModel?.id\n        if (!model) return undefined\n        return {\n          providerID: provider.id,\n          modelID: model,\n        }\n      })\n\n      const currentModel = createMemo(() => {\n        const a = agent.current()\n        return (\n          getFirstValidModel(\n            () => a && modelStore.model[a.name],\n            () => a && a.model,\n            fallbackModel,\n          ) ?? undefined\n        )\n      })\n\n      return {\n        current: currentModel,\n        get ready() {\n          return modelStore.ready\n        },\n        recent() {\n          return modelStore.recent\n        },\n        favorite() {\n          return modelStore.favorite\n        },\n        parsed: createMemo(() => {\n          const value = currentModel()\n          if (!value) {\n            return {\n              provider: \"Connect a provider\",\n              model: \"No provider selected\",\n              reasoning: false,\n            }\n          }\n          const provider = sync.data.provider.find((item) => item.id === value.providerID)\n          const info = provider?.models[value.modelID]\n          return {\n            provider: provider?.name ?? value.providerID,\n            model: info?.name ?? value.modelID,\n            reasoning: info?.capabilities?.reasoning ?? false,\n          }\n        }),\n        cycle(direction: 1 | -1) {\n          const current = currentModel()\n          if (!current) return\n          const recent = modelStore.recent\n          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)\n          if (index === -1) return\n          let next = index + direction\n          if (next < 0) next = recent.length - 1\n          if (next >= recent.length) next = 0\n          const val = recent[next]\n          if (!val) return\n          const a = agent.current()\n          if (!a) return\n          setModelStore(\"model\", a.name, { ...val })\n        },\n        cycleFavorite(direction: 1 | -1) {\n          const favorites = modelStore.favorite.filter((item) => isModelValid(item))\n          if (!favorites.length) {\n            toast.show({\n              variant: \"info\",\n              message: \"Add a favorite model to use this shortcut\",\n              duration: 3000,\n            })\n            return\n          }\n          const current = currentModel()\n          let index = -1\n          if (current) {\n            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)\n          }\n          if (index === -1) {\n            index = direction === 1 ? 0 : favorites.length - 1\n          } else {\n            index += direction\n            if (index < 0) index = favorites.length - 1\n            if (index >= favorites.length) index = 0\n          }\n          const next = favorites[index]\n          if (!next) return\n          const a = agent.current()\n          if (!a) return\n          setModelStore(\"model\", a.name, { ...next })\n          setModelStore(\"recent\", recentModels(next, modelStore.recent))\n          save()\n        },\n        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {\n          batch(() => {\n            if (!isModelValid(model)) {\n              toast.show({\n                message: `Model ${model.providerID}/${model.modelID} is not valid`,\n                variant: \"warning\",\n                duration: 3000,\n              })\n              return\n            }\n            const a = agent.current()\n            if (!a) return\n            setModelStore(\"model\", a.name, model)\n            if (options?.recent) {\n              setModelStore(\"recent\", recentModels(model, modelStore.recent))\n              save()\n            }\n          })\n        },\n        toggleFavorite(model: { providerID: string; modelID: string }) {\n          batch(() => {\n            if (!isModelValid(model)) {\n              toast.show({\n                message: `Model ${model.providerID}/${model.modelID} is not valid`,\n                variant: \"warning\",\n                duration: 3000,\n              })\n              return\n            }\n            const exists = modelStore.favorite.some(\n              (x) => x.providerID === model.providerID && x.modelID === model.modelID,\n            )\n            const next = exists\n              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)\n              : [model, ...modelStore.favorite]\n            setModelStore(\n              \"favorite\",\n              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),\n            )\n            save()\n          })\n        },\n        variant: {\n          selected() {\n            const m = currentModel()\n            if (!m) return undefined\n            const key = `${m.providerID}/${m.modelID}`\n            return modelStore.variant[key]\n          },\n          current() {\n            const v = this.selected()\n            if (!v) return undefined\n            if (!this.list().includes(v)) return undefined\n            return v\n          },\n          list() {\n            const m = currentModel()\n            if (!m) return []\n            const provider = sync.data.provider.find((item) => item.id === m.providerID)\n            const info = provider?.models[m.modelID]\n            if (!info?.variants) return []\n            return Object.keys(info.variants)\n          },\n          set(value: string | undefined) {\n            const m = currentModel()\n            if (!m) return\n            const key = `${m.providerID}/${m.modelID}`\n            setModelStore(\"variant\", key, value ?? \"default\")\n            save()\n          },\n          cycle() {\n            const variants = this.list()\n            if (variants.length === 0) return\n            const current = this.current()\n            if (!current) {\n              this.set(variants[0])\n              return\n            }\n            const index = variants.indexOf(current)\n            if (index === -1 || index === variants.length - 1) {\n              this.set(undefined)\n              return\n            }\n            this.set(variants[index + 1])\n          },\n        },\n      }\n    }\n\n    const model = createModel()\n\n    function createSession() {\n      const [sessionStore, setSessionStore] = createStore<{\n        ready: boolean\n        pinned: string[]\n      }>({\n        ready: false,\n        pinned: [],\n      })\n\n      const filePath = path.join(paths.state, \"session.json\")\n      const state = {\n        pending: false,\n      }\n\n      function save() {\n        if (!sessionStore.ready) {\n          state.pending = true\n          return\n        }\n        state.pending = false\n        void writeJsonAtomic(filePath, {\n          pinned: sessionStore.pinned,\n        })\n      }\n\n      readJson<unknown>(filePath)\n        .then((x) => {\n          if (!x || typeof x !== \"object\") return\n          const pinned = (x as Record<string, unknown>).pinned\n          if (Array.isArray(pinned))\n            setSessionStore(\n              \"pinned\",\n              pinned.filter((item): item is string => typeof item === \"string\"),\n            )\n        })\n        .catch(() => {})\n        .finally(() => {\n          setSessionStore(\"ready\", true)\n          if (state.pending) save()\n        })\n\n      const slots = createMemo(() => {\n        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))\n        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)\n      })\n\n      function prune(sessionID: string) {\n        batch(() => {\n          if (sessionStore.pinned.includes(sessionID)) {\n            setSessionStore(\n              \"pinned\",\n              sessionStore.pinned.filter((x) => x !== sessionID),\n            )\n          }\n          save()\n        })\n      }\n\n      event.on(\"session.deleted\", (evt) => {\n        prune(evt.properties.info.id)\n      })\n\n      return {\n        get ready() {\n          return sessionStore.ready\n        },\n        pinned() {\n          return sessionStore.pinned\n        },\n        slots,\n        isPinned(sessionID: string) {\n          return sessionStore.pinned.includes(sessionID)\n        },\n        togglePin(sessionID: string) {\n          batch(() => {\n            const exists = sessionStore.pinned.includes(sessionID)\n            const next = exists\n              ? sessionStore.pinned.filter((x) => x !== sessionID)\n              : [...sessionStore.pinned, sessionID]\n            setSessionStore(\"pinned\", next)\n            save()\n          })\n        },\n        quickSwitch(slot: number) {\n          const target = slots()[slot - 1]\n          if (!target) return\n          if (route.data.type === \"session\" && route.data.sessionID === target) return\n          route.navigate({ type: \"session\", sessionID: target })\n        },\n      }\n    }\n\n    const session = createSession()\n\n    const mcp = {\n      isEnabled(name: string) {\n        const status = sync.data.mcp[name]\n        return status?.status === \"connected\"\n      },\n      async toggle(name: string) {\n        const status = sync.data.mcp[name]\n        if (status?.status === \"connected\") {\n          // Disable: disconnect the MCP\n          await sdk.client.mcp.disconnect({ name })\n        } else {\n          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)\n          await sdk.client.mcp.connect({ name })\n        }\n      },\n      async enableAll() {\n        for (const [name, status] of Object.entries(sync.data.mcp)) {\n          if (status?.status !== \"connected\") {\n            try {\n              await sdk.client.mcp.connect({ name })\n            } catch {}\n          }\n        }\n      },\n      async disableAll() {\n        for (const [name, status] of Object.entries(sync.data.mcp)) {\n          if (status?.status === \"connected\") {\n            try {\n              await sdk.client.mcp.disconnect({ name })\n            } catch {}\n          }\n        }\n      },\n    }\n\n    createEffect(() => {\n      const value = agent.current()\n      if (!value?.model) return\n      if (isModelValid(value.model)) return\n      toast.show({\n        variant: \"warning\",\n        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,\n        duration: 3000,\n      })\n    })\n\n    const result = {\n      model,\n      agent,\n      mcp,\n      session,\n      permission,\n    }\n    return result\n  },\n})\n
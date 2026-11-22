import { readFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin/tui"
import { readPriority, type AccountStore } from "./accounts.js"
import { compatibility, createController } from "./controller.js"
import { discoverAccounts } from "./discovery.js"
import { createLoader } from "./loader.js"
import { createPublicData } from "./public-data.js"

/** Host adapter only: no server calls, credential reads, subprocess or custom JSX. */
export default Plugin.define({
  id: "iishko-tui",
  setup(context) {
    const [store, update] = context.storage.store<AccountStore>("iishko-tui", {
      initial: { ranks: {}, priority: readPriority(context.options) },
    })
    const configPath = typeof context.options.configPath === "string" ? context.options.configPath : undefined
    const documents = createPublicData()
    const controller = createController({
      ui: {
        size: (size) => context.ui.dialog.set({ size }),
        select: (input) => context.ui.dialog.select(input),
        confirm: (input) => context.ui.dialog.confirm(input),
        alert: (input) => context.ui.dialog.alert(input),
        toast: (input) => context.ui.toast.show(input),
        clear: () => context.ui.dialog.clear(),
      },
      state: () => store,
      save: async (next, signal) => {
        signal.throwIfAborted()
        await update((draft) => {
          // Host storage is async: guard the actual mutation, not only its caller.
          if (signal.aborted) return
          draft.ranks = next.ranks
          draft.priority = next.priority
          if (next.activeAccount === undefined) delete draft.activeAccount
          else draft.activeAccount = next.activeAccount
        })
        signal.throwIfAborted()
      },
      discover: discoverAccounts,
      read: (path, signal) => readFile(path, { encoding: "utf8", signal }),
      loader: createLoader((url, init) => fetch(url, init)),
      // Reuse bounded-TTL schema/metadata caches; expired entries never fall back on failure.
      documents,
      configPath,
      compatibility: compatibility(context.app.version, context.app.channel),
    })
    context.keymap.layer(() => ({
      mode: "global", priority: 10,
      commands: [
        { id: "iishko-tui.menu", title: "ИИШКО: локальное управление моделями", group: "Models",
          palette: true, slash: { name: "iishko-tui" }, bind: "<leader>ir", run: controller.menu },
        { id: "iishko-tui.refresh", title: "ИИШКО: обновить локальный список моделей", group: "Models",
          palette: true, slash: { name: "iishko-update" }, bind: "<leader>iu", run: controller.refresh },
        { id: "iishko-tui.catalog", title: "ИИШКО: каталог моделей сайта", group: "Models",
          palette: true, slash: { name: "iishko-catalog" }, bind: "<leader>ic", run: controller.catalog },
      ],
      bindings: ["iishko-tui.menu", "iishko-tui.refresh", "iishko-tui.catalog"],
    }))
    return controller.dispose
  },
})

import { describe, expect, test } from "bun:test"
import { DEFAULT_METADATA_CONFIG, renderModels, type MetadataConfig } from "./metadata.js"
import type { Price } from "./site.js"

const FIXTURE = {
  gateway: { models: { "glm-5.3": { name: "Gateway GLM", limit: { context: 10, output: 5 } } } },
  zai: { models: {
    "glm-5.3": { name: "GLM 5.3", limit: { context: 200_000, output: 32_000 } },
    "glm-5.3-flash": { name: "GLM 5.3 Flash", limit: { context: 200_000, output: 16_000 } },
  } },
  deepseek: { models: { "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 128_000 } } } },
  google: { models: { "gemini-3.8-flash": { name: "Gemini 3.8 Flash", limit: { context: 1_048_576, output: 65_536 } } } },
  moonshotai: { models: { "kimi-k3": { name: "Kimi K3", limit: { context: 262_144, output: 32_768 } } } },
  minimax: { models: { "minimax-m3": { name: "MiniMax M3", limit: { context: 512_000, output: 128_000 } } } },
  nvidia: { models: { "nvidia-nemotron-3-ultra-550b-a55b": { name: "Nemotron Ultra", limit: { context: 202_800, output: 65_536 } } } },
}

function row(id: string, context: number, output: number, name = id) {
  return { models: { [id]: { name, limit: { context, output } } } }
}

const SECONDARY: MetadataConfig = { ...DEFAULT_METADATA_CONFIG, preferredProviders: [], limitOverrides: {} }

describe("renderModels metadata", () => {
  test("resolves canonical names and limits across known namespaces and safe aliases", () => {
    const ids = [
      "deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash",
      "gemini-3.8-flash-tiered", "moonshotai/kimi-k3", "MiniMax-M3",
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    ]
    const result = renderModels(ids, {}, FIXTURE)
    expect(Object.values(result.models)).toEqual([
      { name: "DeepSeek V4.1 Flash", limit: { context: 1_000_000, output: 128_000 } },
      { name: "GLM 5.3", limit: { context: 200_000, output: 32_000 } },
      { name: "GLM 5.3 Flash", limit: { context: 200_000, output: 16_000 } },
      { name: "Gemini 3.8 Flash", limit: { context: 1_048_576, output: 65_536 } },
      { name: "Kimi K3", limit: { context: 262_144, output: 32_768 } },
      { name: "MiniMax M3", limit: { context: 512_000, output: 128_000 } },
      { name: "Nemotron Ultra", limit: { context: 202_800, output: 65_536 } },
    ])
    expect(result.warnings).toEqual([])
  })

  test("preserves ALL existing metadata including name and nonstandard partial fields", () => {
    const existing = {
      name: "My personal label", limit: { context: 42 }, cost: { input: 9 },
      options: { nested: ["custom", { enabled: true }] }, tool_call: false,
      modalities: { input: ["text"] }, custom: null,
    }
    const before = structuredClone(existing)
    const result = renderModels(["MiniMax-M3"], { "MiniMax-M3": existing }, FIXTURE)
    expect(result.models["MiniMax-M3"]).toEqual(before)
    expect(existing).toEqual(before)
    expect(result.models["MiniMax-M3"]).not.toBe(existing)
    expect(result.warnings).toEqual([])
  })

  test("enriches missing fields without treating null/empty fields as absent", () => {
    const result = renderModels(["glm-5.3", "MiniMax-M3"], {
      "glm-5.3": { name: "", cost: null, custom: "keep" },
      "MiniMax-M3": { name: null, limit: null },
    }, FIXTURE)
    expect(result.models["glm-5.3"]).toEqual({ name: "", cost: null, custom: "keep", limit: { context: 200_000, output: 32_000 } })
    expect(result.models["MiniMax-M3"]).toEqual({ name: null, limit: null })
  })

  test("unknown models get readable names and warnings, never invented tools or limits", () => {
    const result = renderModels(["unknown-model", "private/glm-next"], {}, FIXTURE)
    expect(result.models).toEqual({ "unknown-model": { name: "Unknown Model" }, "private/glm-next": { name: "GLM Next" } })
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain("unknown-model")
  })

  test("does not conflate nearby versions or sizes or allow aliases to erase them", () => {
    const catalog = { zai: row("glm-5.3", 100, 10), alibaba: row("qwen3.8-30b", 200, 20) }
    const config = { ...DEFAULT_METADATA_CONFIG, aliases: { "glm-5.2": "glm-5.3", "qwen3.8-32b": "qwen3.8-30b" } }
    const result = renderModels(["glm-5.2", "qwen3.8-32b"], {}, catalog, undefined, config)
    expect(result.models).toEqual({ "glm-5.2": { name: "GLM 5.2" }, "qwen3.8-32b": { name: "Qwen3.8 32b" } })
    expect(result.warnings).toHaveLength(2)
  })

  test("rejects aliases that erase the size unit even when the digits stay equal", () => {
    const config = { ...DEFAULT_METADATA_CONFIG, aliases: { "qwen3.8-30b": "qwen3.8-30" } }
    const result = renderModels(["qwen3.8-30b"], {}, { alibaba: row("qwen3.8-30", 100, 10) }, undefined, config)
    expect(result.models).toEqual({ "qwen3.8-30b": { name: "Qwen3.8 30b" } })
    expect(result.warnings).toHaveLength(1)
  })

  test("handles malformed catalog rows and limits without inventing support", () => {
    const catalog = {
      broken: null, array: { models: [] },
      zai: { models: { x: null, y: [], "glm-5.3": { name: "GLM 5.3", tool_call: true, limit: { context: Infinity, output: 20 } } } },
    }
    expect(renderModels(["glm-5.3"], {}, catalog).models).toEqual({ "glm-5.3": { name: "GLM 5.3" } })
    expect(renderModels(["m"], {}, null).models).toEqual({ m: { name: "M" } })
    expect(renderModels([], {}, catalog)).toEqual({ models: {}, warnings: [] })
  })

  test("preserves malformed existing entries rather than silently rewriting them", () => {
    const result = renderModels(["m"], { m: null }, {})
    expect(result.models).toEqual({ m: null })
    expect(result.warnings[0]).toContain("preserved unchanged")
  })

  test("uses entry.id and treats prototype-like model IDs as ordinary own keys", () => {
    const result = renderModels(["__proto__", "model-id"], {}, {
      openai: { models: { key: { id: "model-id", name: "Canonical", limit: { context: 100, output: 10 } } } },
    })
    expect(Object.hasOwn(result.models, "__proto__")).toBe(true)
    expect(result.models["model-id"]).toEqual({ name: "Canonical", limit: { context: 100, output: 10 } })
    expect(Object.getPrototypeOf(result.models)).toBe(Object.prototype)
  })
})

describe("renderModels limit resolution", () => {
  test("exact default overrides apply only to the specified release ID", () => {
    const result = renderModels(["glm-5.3-flash", "glm-5.4-flash", "qwen4-max", "qwen4.1-max", "qwen3.8-max-0902", "qwen3.8-max-0903"], {}, {})
    expect(result.models["glm-5.3-flash"]).toEqual({ name: "GLM 5.3 Flash", limit: { context: 1_000_000, output: 131_072 } })
    expect(result.models["qwen4-max"]).toEqual({ name: "Qwen4 Max", limit: { context: 1_000_000, output: 262_144 } })
    expect(result.models["qwen3.8-max-0902"]).toEqual({ name: "Qwen3.8 Max 0902", limit: { context: 1_000_000, output: 131_072 } })
    expect(result.warnings).toHaveLength(3)
  })

  test("preferred vendor exact then normalized beats reseller maxima", () => {
    const catalog = {
      reseller: row("zai-org/GLM-5.3", 9_000_000, 9_000_000),
      zai: row("glm-5.3", 200_000, 32_000),
      openai: row("glm-5.3", 100_000, 10_000),
    }
    const result = renderModels(["zai-org/GLM-5.3"], {}, catalog)
    expect(result.models["zai-org/GLM-5.3"]).toEqual({ name: "zai-org/GLM-5.3", limit: { context: 100_000, output: 10_000 } })
    expect(result.warnings).toEqual([])
  })

  test("preferred exact beats a higher-priority normalized vendor", () => {
    const result = renderModels(["glm-5.3"], {}, {
      openai: row("zai-org/GLM-5.3", 100, 10), zai: row("glm-5.3", 200, 20),
    })
    expect(result.models["glm-5.3"]).toEqual({ name: "glm-5.3", limit: { context: 200, output: 20 } })
  })

  test("secondary pair mode wins and warns about a greater than 2x spread", () => {
    const result = renderModels(["m"], {}, { a: row("m", 200, 20), b: row("m", 200, 20), c: row("m", 800, 80) }, undefined, SECONDARY)
    expect(result.models.m).toEqual({ name: "m", limit: { context: 200, output: 20 } })
    expect(result.warnings).toEqual(["m: secondary models.dev limit source (mode)", "m: limit sources spread 4.0x"])
  })

  test("without a repeated pair uses component medians and truncates halves", () => {
    const result = renderModels(["m"], {}, { a: row("m", 101, 11), b: row("m", 200, 20) }, undefined, SECONDARY)
    expect(result.models.m).toEqual({ name: "m", limit: { context: 150, output: 15 } })
    expect(result.warnings).toEqual(["m: secondary models.dev limit source (median)"])
  })

  test("ignores invalid limits, uses exact secondary rows before normalized rows", () => {
    const result = renderModels(["glm-5.3"], {}, {
      a: row("glm-5.3", 100, 10), b: row("zai-org/GLM-5.3", 800, 80),
      zai: row("glm-5.3", -1, 5), openai: row("glm-5.3", 10.5, 2),
    })
    expect(result.models["glm-5.3"]).toEqual({ name: "glm-5.3", limit: { context: 100, output: 10 } })
    expect(result.warnings).toEqual(["glm-5.3: secondary models.dev limit source (median)"])
  })

  test("ties and output are independent of catalog insertion order", () => {
    const a = { b: row("m", 200, 20), a: row("m", 100, 10), c: row("m", 100, 10), d: row("m", 200, 20) }
    const b = Object.fromEntries(Object.entries(a).reverse())
    expect(renderModels(["m"], {}, a, undefined, SECONDARY)).toEqual(renderModels(["m"], {}, b, undefined, SECONDARY))
  })
})

describe("renderModels prices", () => {
  test("adds complete token prices, preserves existing partial costs", () => {
    const prices = new Map<string, Price>([
      ["m", { input: "$0.15", output: "$1.20", perCall: null }],
      ["free", { input: "0", output: "$0", perCall: null }],
      ["large", { input: "$1,000.50", output: "2", perCall: null }],
    ])
    const result = renderModels(["m", "free", "large"], {}, {}, prices)
    expect(result.models).toEqual({
      m: { name: "M", cost: { input: 0.15, output: 1.2 } },
      free: { name: "Free", cost: { input: 0, output: 0 } },
      large: { name: "Large", cost: { input: 1000.5, output: 2 } },
    })
    expect(renderModels(["m"], { m: { cost: { input: 9 } } }, {}, prices).models.m).toEqual({ name: "M", cost: { input: 9 } })
  })

  test("does not guess incomplete, invalid, infinite, negative, or per-call media costs", () => {
    const inputs: Price[] = [
      { input: null, output: "$1", perCall: null },
      { input: "$1", output: null, perCall: null },
      { input: "Infinity", output: "1", perCall: null },
      { input: "9".repeat(400), output: "1", perCall: null },
      { input: "-1", output: "1", perCall: null },
      { input: "", output: "1", perCall: null },
      { input: "1/M tokens", output: "1", perCall: null },
      { input: null, output: null, perCall: "$0.01" },
      { input: "$1", output: "$2", perCall: "$0.01" },
    ]
    for (const price of inputs) {
      expect(renderModels(["m"], {}, {}, new Map([["m", price]])).models.m).toEqual({ name: "M" })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { candidate, DEFAULT_POLICY, metadataId } from "./policy.js"

describe("candidate", () => {
  test("matches the supported Python family/version/size fixtures", () => {
    const accepted = [
      "deepseek-v4.1-flash", "glm-5-3-flash-260828", "kimi-k3.1-pro-highspeed",
      "qwen3.8-30B-A3B-thinking-preview", "deepseek-ai/DeepSeek-V4.1-Flash",
      "zai-org/GLM-5.3", "moonshotai/Kimi-K2.7", "alibaba/qwen4-max",
    ]
    const rejected = [
      "qwen3.8-27B", "qwen3.8-0.8B", "qwen3.8_mini_code", "qwen3.8-vl-72B",
      "qwen3.7-max", "glm-5.2", "deepseek-v4-pro", "moonshotai/Kimi-K2.6",
      "GLM-CogView3-Flash", "qwen-next", "unknown-model", "",
    ]
    expect(accepted.map((id) => candidate(id))).toEqual(accepted.map(() => true))
    expect(rejected.map((id) => candidate(id))).toEqual(rejected.map(() => false))
  })

  test("keeps the explicit non-version-family allowlist, not every GPT/Claude", () => {
    expect(DEFAULT_POLICY.otherAllowlist.every((id) => candidate(id))).toBe(true)
    expect(candidate("claude-opus-5-5")).toBe(false)
    expect(candidate("gpt-unspecified")).toBe(false)
    expect(candidate("gpt-oss-20b")).toBe(false)
  })

  test("junk, small, modality, and dropped suffixes are case insensitive", () => {
    const ids = [
      "qwen4-SEARCH", "qwen4-nano", "qwen4_LITE", "qwen4.small", "qwen4/mini",
      "qwen4-VISION-72B", "qwen4-tts", "qwen4-embedding", "qwen4:FREE",
      "qwen4-free", "qwen4-OVH", "qwen4@EU",
    ]
    expect(ids.map((id) => candidate(id))).toEqual(ids.map(() => false))
    expect(candidate("MiniMax-M3")).toBe(true)
  })

  test("uses total rather than active MoE size and respects boundary sizes", () => {
    expect(candidate("qwen3.8-30B-A3B")).toBe(true)
    expect(candidate("qwen3.8-29.9B-A3B")).toBe(false)
    expect(candidate("qwen3.8-30.0B")).toBe(true)
    expect(candidate("qwen3.8/20b")).toBe(false)
  })

  test("optional exact overrides win before filters, with drop strongest", () => {
    const policy = { ...DEFAULT_POLICY, alwaysKeep: ["foreign-model", "qwen4-mini"], alwaysDrop: ["qwen4-mini"] }
    expect(candidate("foreign-model", policy)).toBe(true)
    expect(candidate("qwen4-mini", policy)).toBe(false)
    expect(candidate("Foreign-model", policy)).toBe(false)
    expect(candidate("qwen3.8-27B", { ...DEFAULT_POLICY, sizeExceptions: ["qwen3.8-27B"] })).toBe(true)
  })

  test("version tuples compare numerically and floors are configurable", () => {
    expect(candidate("qwen3.10-30B")).toBe(true)
    expect(candidate("qwen4-max")).toBe(true)
    expect(candidate("qwen3.8-max", { ...DEFAULT_POLICY, floorVersions: { qwen: [4, 0] } })).toBe(false)
    expect(candidate("qwen4-max", { ...DEFAULT_POLICY, alwaysKeep: undefined, alwaysDrop: undefined })).toBe(true)
  })
})

describe("metadataId", () => {
  test("strips repeated supported namespaces but retains versions, size and suffixes", () => {
    expect(metadataId("groq/openai/GPT-OSS-120B")).toBe("gpt-oss-120b")
    expect(metadataId("models/zai-org/GLM-5.3-Flash")).toBe("glm-5.3-flash")
    expect(metadataId("nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B")).toBe("nvidia-nemotron-3-ultra-550b-a55b")
    expect(metadataId("alibaba/Qwen3.8-30B-A3B-preview")).toBe("qwen3.8-30b-a3b-preview")
  })

  test("does not strip unknown namespaces or guess model equivalence", () => {
    expect(metadataId("private/Qwen3.8-30B")).toBe("private/qwen3.8-30b")
    expect(metadataId("qwen3.8-30B")).not.toBe(metadataId("qwen3.8-32B"))
    expect(metadataId("glm-5.2")).not.toBe(metadataId("glm-5.3"))
    expect(metadataId("")).toBe("")
  })
})

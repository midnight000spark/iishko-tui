/** Portable, non-personal candidate rules. Overrides refer to exact gateway IDs. */
export interface CandidatePolicy {
  readonly includeFamilies: readonly string[]
  readonly floorVersions: Readonly<Record<string, readonly [number, number]>>
  readonly otherAllowlist: readonly string[]
  readonly sizeMinB: number
  readonly sizeExceptions: readonly string[]
  /** JavaScript regexp sources; matching is always case-insensitive. */
  readonly junkRegex: string
  readonly smallRegex: string
  readonly modalityRegex: string
  readonly dropRegex: string
  readonly alwaysKeep?: readonly string[]
  readonly alwaysDrop?: readonly string[]
}

export const DEFAULT_POLICY: CandidatePolicy = Object.freeze({
  includeFamilies: Object.freeze([
    "deepseek", "glm", "kimi", "qwen", "claude", "gpt", "gemini", "grok",
    "minimax", "nemotron", "mistral",
  ]),
  floorVersions: Object.freeze({
    deepseek: Object.freeze([4, 1] as const),
    glm: Object.freeze([5, 3] as const),
    kimi: Object.freeze([2, 7] as const),
    qwen: Object.freeze([3, 8] as const),
  }),
  otherAllowlist: Object.freeze([
    "gpt-6-sol", "gpt-6.1-sol", "gpt-oss-120b", "openai/gpt-oss-120b",
    "groq/openai/gpt-oss-120b", "claude-haiku-5-5", "gemini-3.8-flash-tiered",
    "grok-4.7", "MiniMax-M3", "MiniMax-M3.1-Flash",
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B", "mistral-large-latest",
  ]),
  sizeMinB: 30,
  sizeExceptions: Object.freeze([]),
  junkRegex: "(?:search|rerank|whisper|seedance|seedream|cogview|cogvideo|flux|dall-e|midjourney|moderation|guard|observer|antigravity|arena|uncensored|realtime|router)",
  smallRegex: "(?:^|[-_/.])(nano|mini|lite|small)(?:$|[-_/.])",
  modalityRegex: "(?:^|[-_/.])(omni|vl|vision|image|video|tts|audio|speech|embed|embedding)(?:$|[-_/.])",
  dropRegex: "(?::free|-free|-ovh|@eu)$",
  alwaysKeep: Object.freeze([]),
  alwaysDrop: Object.freeze([]),
})

const VERSIONS: Readonly<Record<string, RegExp>> = {
  deepseek: /deepseek[-_/]?(?:v)?(\d+)(?:[.\-](\d+))?/,
  glm: /glm[-_/]?(\d+)(?:[.\-](\d+))?/,
  kimi: /kimi[-_/]?(?:k)?(\d+)(?:[.\-](\d+))?/,
  qwen: /qwen[-_/]?(\d+)(?:[.\-](\d+))?/,
}

/** Pure parity with the supported Python candidate rules; drop beats keep. */
export function candidate(model: string, policy: CandidatePolicy = DEFAULT_POLICY): boolean {
  if (policy.alwaysDrop?.includes(model)) return false
  if (policy.alwaysKeep?.includes(model)) return true
  const normalized = model.toLowerCase()
  if (!policy.includeFamilies.some((family) => normalized.includes(family))) return false
  const patterns = [policy.junkRegex, policy.smallRegex, policy.modalityRegex, policy.dropRegex]
  if (patterns.some((source) => new RegExp(source, "i").test(model))) return false
  const size = /(?:^|[-_/.])(\d+(?:\.\d+)?)b(?=$|[-_/.])/i.exec(model)
  if (size && Number(size[1]) < policy.sizeMinB && !policy.sizeExceptions.includes(model)) {
    return false
  }
  for (const [family, pattern] of Object.entries(VERSIONS)) {
    if (!normalized.includes(family)) continue
    const version = pattern.exec(normalized)
    const floor = policy.floorVersions[family]
    if (!version || !floor) return false
    const major = Number(version[1])
    const minor = Number(version[2] ?? 0)
    return major > floor[0] || (major === floor[0] && minor >= floor[1])
  }
  return policy.otherAllowlist.includes(model)
}

const NAMESPACES = new Set([
  "deepseek-ai", "deepseek", "zai-org", "z-ai", "zai", "moonshotai", "moonshot",
  "kimi", "minimaxai", "minimax", "nvidia", "qwen", "alibaba", "openai",
  "anthropic", "google", "models", "x-ai", "xai", "mistralai", "mistral",
  "groq", "openrouter",
])

/** Strip only known namespace prefixes; never erase a version, size, or suffix. */
export function metadataId(model: string): string {
  const parts = model.toLowerCase().split("/")
  while (parts.length > 1 && NAMESPACES.has(parts[0] ?? "")) parts.shift()
  return parts.join("/")
}

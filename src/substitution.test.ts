import { expect, test } from "bun:test"
import { renderModels } from "./metadata.js"
import { parseStatus } from "./parse.js"

test("public IDs cannot introduce OpenCode substitutions", () => {
  for (const id of ["qwen4-{env:FIXTURE_VALUE}", "glm-5.3-{file:/fixture}"]) {
    expect(() => parseStatus({ updated: 1, models: [{ id }], unmeasured: [] })).toThrow()
    expect(() => renderModels([id], {}, {})).toThrow()
  }
})

test("unsafe imported names use literal fallback, user-authored names remain unchanged", () => {
  const catalog = { zai: { models: { "glm-5.3": { name: "{file:/fixture-secret}", limit: { context: 100, output: 10 } } } } }
  const fresh = renderModels(["glm-5.3"], {}, catalog)
  expect(JSON.stringify(fresh.models)).not.toContain("{file:")
  const old = { "glm-5.3": { name: "{env:USER_NAME}" } }
  expect(renderModels(["glm-5.3"], old, catalog).models["glm-5.3"]).toMatchObject(old["glm-5.3"])
})

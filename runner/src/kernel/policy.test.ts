import { describe, expect, it } from "bun:test"
import { admit, batchReleased, decide, DEFAULT_POLICY, inBatchWindow, type PolicyConfig } from "./policy"

const item = (labels: string[] = [], priority: number | null = null) => ({ labels, priority })
const at = (hour: number) => new Date(2026, 10, 12, hour, 30)

describe("decide", () => {
  it("runs an ordinary ticket in the normal lane", () => {
    expect(decide(item(["bug"]))).toMatchObject({ lane: "normal", mode: "implement" })
  })

  it("treats tracker priority 1 as urgent", () => {
    expect(decide(item([], 1))).toMatchObject({ lane: "urgent", mode: "implement" })
    expect(decide(item([], 2)).lane).toBe("normal")
  })

  it("treats an urgent label as urgent, case-insensitively", () => {
    expect(decide(item(["Severity:Critical"])).lane).toBe("urgent")
  })

  it("puts batch and scoped batch labels in the batch lane", () => {
    expect(decide(item(["batch"])).lane).toBe("batch")
    expect(decide(item(["batch:ui"])).lane).toBe("batch")
    expect(decide(item(["batch/ui"])).lane).toBe("batch")
    expect(decide(item(["batchelor"])).lane).toBe("normal")
  })

  it("lets urgent win over batch", () => {
    expect(decide(item(["batch:ui", "critical"])).lane).toBe("urgent")
  })

  it("holds an untrusted ticket for human triage", () => {
    expect(decide(item(["untrusted", "bug"]))).toMatchObject({ lane: "hold" })
    expect(decide(item(["untrusted", "batch"]))).toMatchObject({ lane: "hold" })
  })

  it("never gives an untrusted ticket a code-writing agent, even when urgent", () => {
    expect(decide(item(["untrusted", "critical"]))).toMatchObject({ lane: "urgent", mode: "investigate" })
    expect(decide(item(["untrusted"], 1))).toMatchObject({ lane: "urgent", mode: "investigate" })
  })
})

describe("decide after investigation", () => {
  it("does not investigate the same untrusted ticket twice", () => {
    expect(decide(item(["untrusted", "critical", "goblin:investigated"]))).toMatchObject({ lane: "hold" })
  })

  it("implements once a human removes the untrusted label", () => {
    expect(decide(item(["critical", "goblin:investigated"]))).toMatchObject({ lane: "urgent", mode: "implement" })
  })
})

describe("inBatchWindow", () => {
  it("is true only inside a same-day window", () => {
    expect(inBatchWindow(at(1))).toBe(false)
    expect(inBatchWindow(at(2))).toBe(true)
    expect(inBatchWindow(at(4))).toBe(true)
    expect(inBatchWindow(at(5))).toBe(false)
  })

  it("handles a window that crosses midnight", () => {
    const cfg: PolicyConfig = { ...DEFAULT_POLICY, batchWindow: { startHour: 22, endHour: 3 } }
    expect(inBatchWindow(at(23), cfg)).toBe(true)
    expect(inBatchWindow(at(1), cfg)).toBe(true)
    expect(inBatchWindow(at(3), cfg)).toBe(false)
    expect(inBatchWindow(at(12), cfg)).toBe(false)
  })

  it("is disabled when start equals end", () => {
    const cfg: PolicyConfig = { ...DEFAULT_POLICY, batchWindow: { startHour: 0, endHour: 0 } }
    expect(inBatchWindow(at(0), cfg)).toBe(false)
  })
})

describe("batchReleased", () => {
  it("never releases an empty batch", () => {
    expect(batchReleased(0, at(3))).toBe(false)
  })

  it("releases early once enough tickets wait", () => {
    const cfg: PolicyConfig = { ...DEFAULT_POLICY, batchMinCount: 3 }
    expect(batchReleased(2, at(12), cfg)).toBe(false)
    expect(batchReleased(3, at(12), cfg)).toBe(true)
  })
})

describe("admit", () => {
  const items = [
    { id: "n1", ...item(["bug"]) },
    { id: "b1", ...item(["batch:ui"]) },
    { id: "u1", ...item(["critical"]) },
    { id: "h1", ...item(["untrusted"]) },
    { id: "b2", ...item(["batch:ui"]) },
  ]

  it("outside the window admits urgent then normal and keeps the batch waiting", () => {
    const r = admit(items, at(12))
    expect(r.admitted.map(a => a.item.id)).toEqual(["u1", "n1"])
    expect(r.batchWaiting.map(a => a.item.id)).toEqual(["b1", "b2"])
    expect(r.held.map(a => a.item.id)).toEqual(["h1"])
  })

  it("inside the window releases the batch after urgent and normal", () => {
    const r = admit(items, at(3))
    expect(r.admitted.map(a => a.item.id)).toEqual(["u1", "n1", "b1", "b2"])
    expect(r.batchWaiting).toEqual([])
  })

  it("caps the released batch and leaves the rest waiting", () => {
    const cfg: PolicyConfig = { ...DEFAULT_POLICY, batchMaxSize: 1 }
    const r = admit(items, at(3), cfg)
    expect(r.admitted.map(a => a.item.id)).toEqual(["u1", "n1", "b1"])
    expect(r.batchWaiting.map(a => a.item.id)).toEqual(["b2"])
  })
})

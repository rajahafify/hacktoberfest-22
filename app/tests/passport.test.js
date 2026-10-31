import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze, verify, mockBackend } from "../src/passport/index.js";
import { parseNumber, entityKey } from "../src/passport/normalize.js";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "samples");
const load = (skip = []) => readdirSync(SAMPLES).filter((f) => f.endsWith(".txt") && !skip.includes(f)).sort()
  .map((name) => ({ name, text: readFileSync(join(SAMPLES, name), "utf8") }));

describe("normalize", () => {
  it("reads locale separators", () => {
    expect(parseNumber("1,200,000.00")).toBe(1200000);
    expect(parseNumber("10.050.000.000")).toBe(10050000000);
    expect(parseNumber("95,00")).toBe(95);
    expect(parseNumber("(640,000)")).toBe(-640000);
  });
  it("matches legal suffixes across registries", () => {
    expect(entityKey("Kopi Ledger Pte. Ltd.")).toBe(entityKey("KOPI LEDGER PTE LTD"));
  });
});

describe("analysis parity with the Python reference", () => {
  it("scores 695 without the BVI extract and 797 with all nine documents", async () => {
    const without = await analyze(load(["09_bvi_lumen_ventures_ubo_declaration.txt"]), mockBackend);
    expect(without.score.total).toBe(695);
    expect(without.score.grade).toBe("B");
    const all = await analyze(load(), mockBackend);
    expect(all.score.total).toBe(797);
    expect(all.score.markets).toEqual(["ID", "MY", "SG", "TH", "VN"]);
  });

  it("resolves the holding company's owners through the chain", async () => {
    const r = await analyze(load(), mockBackend);
    const ubo = Object.fromEntries(r.graph.ubo[r.graph.subject].map((u) => [u.name, u]));
    expect(ubo["AISHA BINTI RAHMAN"].percent).toBe(40);
    expect(ubo["AISHA BINTI RAHMAN"].is_ubo).toBe(true);
    expect(r.graph.subject_resolved_percent).toBe(100);
  });

  it("flags the opaque offshore holder only when its register is missing", async () => {
    const without = await analyze(load(["09_bvi_lumen_ventures_ubo_declaration.txt"]), mockBackend);
    expect(without.findings.some((f) => f.title.startsWith("Undisclosed beneficial owners"))).toBe(true);
    const all = await analyze(load(), mockBackend);
    expect(all.findings.some((f) => f.title.startsWith("Undisclosed beneficial owners"))).toBe(false);
  });
});

describe("verifiable credential", () => {
  it("verifies an untouched credential", async () => {
    const r = await analyze(load(), mockBackend);
    expect((await verify(r.credential)).valid).toBe(true);
  });
  it("rejects a tampered score", async () => {
    const r = await analyze(load(), mockBackend);
    r.credential.credentialSubject.readinessScore.value = 990;
    expect((await verify(r.credential)).valid).toBe(false);
  });
  it("rejects an expired credential", async () => {
    const r = await analyze(load(), mockBackend);
    const later = new Date(Date.parse(r.credential.validUntil) + 1000);
    expect((await verify(r.credential, later)).reason).toMatch(/expired/);
  });
});

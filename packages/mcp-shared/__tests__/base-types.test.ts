import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_BASE_TYPES } from "../src/base-types.js";

describe("MCP_BASE_TYPES", () => {
  it("matches types.d.ts exactly", () => {
    // `base-types.ts` exists only because a Worker's Text module rule cannot resolve an import across
    // a package boundary. `types.d.ts` is the copy TypeScript actually checks, so if they diverge the
    // agents get a type surface nobody reviewed. Editing one and not the other fails here.
    const authoritative = readFileSync(join(import.meta.dirname, "../src/types.d.ts"), "utf8");
    expect(MCP_BASE_TYPES).toBe(authoritative);
  });

  it("carries the types the subscription's declaration names", () => {
    // The generated session interface declares `subscribeAppMessages(url, hook)`, so what that
    // declaration names has to be in scope in the file it is emitted into: the stub type from the
    // runtime, and the hook an agent satisfies by passing `self`.
    expect(MCP_BASE_TYPES).toContain('import type { RpcStub } from "cloudflare:workers";');
    expect(MCP_BASE_TYPES).toContain("export type McpAppMessage = {");
    expect(MCP_BASE_TYPES).toContain("export interface McpAppMessageHook {");
  });
});

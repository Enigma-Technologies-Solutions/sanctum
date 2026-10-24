// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { Commands } from "@/lib/commands";
import { cleanText } from "@/lib/text";

const RLO = "‮";
const ZWSP = "​";

describe("cleanText", () => {
  it("removes direction overrides, zero-width and control characters", () => {
    expect(cleanText(`Sh${RLO}ami${ZWSP}r\u0007\u0000`)).toBe("Shamir");
    expect(cleanText("a⁦b⁩c﻿d­e")).toBe("abcde");
  });
  it("keeps ordinary text, other scripts, line feeds and tabs", () => {
    expect(cleanText("Línea\n\tdos — 日本語 עברית")).toBe("Línea\n\tdos — 日本語 עברית");
  });
});

describe("registry text is cleaned where it enters the interface", () => {
  beforeEach(() => vi.resetAllMocks());

  it("catalogue names, summaries and publishers", async () => {
    vi.mocked(invoke).mockResolvedValue({
      registryId: "r",
      registryName: `Reg${RLO}`,
      stale: false,
      revocationsStale: false,
      apps: [{ appId: "a.b", name: `Na${ZWSP}me`, summary: `${RLO}sum`, publisherName: `Pub${RLO}`, versions: [] }],
    });
    const c = await Commands.registryCatalogue("r");
    expect(c.registryName).toBe("Reg");
    expect(c.apps[0].name).toBe("Name");
    expect(c.apps[0].summary).toBe("sum");
    expect(c.apps[0].publisherName).toBe("Pub");
  });

  it("detail description, manual, changelog and screenshot text", async () => {
    vi.mocked(invoke).mockResolvedValue({
      appId: "a.b",
      name: `N${RLO}`,
      description: `d${ZWSP}`,
      license: `L${RLO}`,
      homepage: null,
      source: null,
      manual: `# T${RLO}\n\nbody`,
      manualError: null,
      changelog: [{ version: "1", date: "2026-01-01", changes: [{ type: "fixed", text: `x${RLO}` }] }],
      screenshots: [{ alt: `a${ZWSP}lt`, width: 1, height: 1, dataUrl: null, error: null }],
      icon: null,
      iconError: null,
    });
    const d = await Commands.registryAppDetail("r", "a.b");
    expect(d.name).toBe("N");
    expect(d.description).toBe("d");
    expect(d.license).toBe("L");
    expect(d.manual).toBe("# T\n\nbody");
    expect(d.changelog[0].changes[0].text).toBe("x");
    expect(d.screenshots[0].alt).toBe("alt");
  });

  it("the list of added registries", async () => {
    vi.mocked(invoke).mockResolvedValue([{ id: "r", name: `R${RLO}`, publisher: `P${ZWSP}` }]);
    const [r] = await Commands.listRegistries();
    expect(r.name).toBe("R");
    expect(r.publisher).toBe("P");
  });
  it("the agent's account, from sign-in, status and sign-out", async () => {
    const dirty = { signedIn: true, email: `me${ZWSP}@example.com`, plan: `Pro${RLO}` };
    vi.mocked(invoke).mockResolvedValue(dirty);
    for (const call of [Commands.agentAccount, Commands.agentSignIn, Commands.agentSignOut]) {
      const a = await call();
      expect(a.email).toBe("me@example.com");
      expect(a.plan).toBe("Pro");
    }
    vi.mocked(invoke).mockResolvedValue({ signedIn: false, email: null, plan: null });
    expect(await Commands.agentAccount()).toEqual({ signedIn: false, email: null, plan: null });
  });
  it("what Codex says when a session opens, and how a turn ended", async () => {
    vi.mocked(invoke).mockResolvedValue({ model: `gpt${ZWSP}-x`, version: `0.1${RLO}`, directory: `~/a${ZWSP}b`, sources: [] });
    expect(await Commands.agentChatStart()).toEqual({ model: "gpt-x", version: "0.1", directory: "~/ab", sources: [] });
    vi.mocked(invoke).mockResolvedValue({ model: null, version: null, directory: "~/w", sources: [] });
    expect(await Commands.agentChatStart()).toEqual({ model: null, version: null, directory: "~/w", sources: [] });
    // The name of a library app is text somebody else wrote.
    vi.mocked(invoke).mockResolvedValue({
      model: null, version: null, directory: "~/w",
      sources: [{ kind: "app", title: `Ti${RLO}mer${ZWSP}`, detail: `Ver${ZWSP}sion 2`, toolId: "t" }],
    });
    const st = await Commands.agentChatStart("t");
    expect([st.sources[0].title, st.sources[0].detail, st.sources[0].toolId]).toEqual(["Timer", "Version 2", "t"]);
    expect(vi.mocked(invoke)).toHaveBeenLastCalledWith("agent_chat_start", { source: "t" });
    vi.mocked(invoke).mockResolvedValue([{ sha: "a", number: 1, size: 1, at: 0, loaded: false, current: true, name: `Ti${ZWSP}mer` }]);
    expect((await Commands.agentDraftHistory())[0].name).toBe("Timer");
    vi.mocked(invoke).mockResolvedValue({ status: "failed", error: `no${ZWSP}pe`, refused: 0, draft: null });
    expect((await Commands.agentChatSend("x")).error).toBe("nope");
  });
  it("a draft's own title and description, and the name of what was added", async () => {
    vi.mocked(invoke).mockResolvedValue({
      name: `Ti${RLO}mer`, description: `Cou${ZWSP}nts`, size: 1, capabilities: [], savesAs: "version", toolName: `Ti${ZWSP}mer`,
    });
    const r = await Commands.agentScanDraft();
    expect([r.name, r.description, r.toolName]).toEqual(["Timer", "Counts", "Timer"]);
    vi.mocked(invoke).mockResolvedValue({
      name: "x", description: "", size: 1, capabilities: [], savesAs: "new", toolName: null,
    });
    expect((await Commands.agentScanDraft()).toolName).toBeNull();
    vi.mocked(invoke).mockResolvedValue({ outcome: "added", versionNum: 1, tool: { id: "t", name: `Ti${ZWSP}mer`, origin: "agent" } });
    const a = await Commands.agentAddDraft();
    expect(a.tool.name).toBe("Timer");
    expect(a.tool.origin).toBe("agent");
  });
});

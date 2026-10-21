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
});

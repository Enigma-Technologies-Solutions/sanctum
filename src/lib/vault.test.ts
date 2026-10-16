// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it } from "vitest";
import type { ProvenanceRecord, ToolWithVersion } from "./types";
import { UNKNOWN_TITLE, UNSIGNED_TITLE, groupByPublisher } from "./vault";

const prov = (over: Partial<ProvenanceRecord>): ProvenanceRecord => ({
  versionId: "v", appId: "sh.x.a", publisherKey: "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAA", publisherName: "Enigma Technologies Solutions",
  trust: "verified", name: "A", version: "1.0.0", issuedAt: 0, installedAt: 0, ...over,
});
const tool = (id: string, provenance: ProvenanceRecord | null) =>
  ({ tool: { id, name: id }, current_version: null, all_versions: [], provenance }) as unknown as ToolWithVersion;

describe("groupByPublisher", () => {
  it("is empty for an empty library", () => {
    expect(groupByPublisher([])).toEqual([]);
  });

  it("puts tools from one verified publisher together, in their original order", () => {
    const g = groupByPublisher([tool("otp", prov({})), tool("sss", prov({}))]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ title: "Enigma Technologies Solutions", kind: "verified" });
    expect(g[0].tools.map((t) => t.tool.id)).toEqual(["otp", "sss"]);
  });

  it("orders verified, then unknown signers, then unsigned", () => {
    const g = groupByPublisher([
      tool("loose", null),
      tool("odd", prov({ trust: "unknown_signer", publisherKey: "ed25519:ZZZZZZZZZZZZZZZZZZZZZZ", publisherName: null })),
      tool("ok", prov({})),
    ]);
    expect(g.map((x) => x.kind)).toEqual(["verified", "unknown", "unsigned"]);
    expect(g[2].title).toBe(UNSIGNED_TITLE);
    expect(g[1].title.startsWith(UNKNOWN_TITLE)).toBe(true);
  });

  it("never gives an unknown signer a name, even if the record carries one", () => {
    const g = groupByPublisher([tool("odd", prov({ trust: "unknown_signer", publisherName: "Enigma Technologies Solutions" }))]);
    expect(g[0].kind).toBe("unknown");
    expect(g[0].title).not.toBe("Enigma Technologies Solutions");
    expect(g[0].title).toContain("ed25519:AAAAAAAA");
  });

  it("keeps two different unknown keys apart", () => {
    const mk = (k: string) => tool(k, prov({ trust: "unknown_signer", publisherKey: `ed25519:${k.repeat(20)}`, publisherName: null }));
    expect(groupByPublisher([mk("A"), mk("B")])).toHaveLength(2);
  });

  it("sorts verified publishers by name", () => {
    const g = groupByPublisher([
      tool("z", prov({ publisherKey: "ed25519:k2", publisherName: "Zeta" })),
      tool("a", prov({ publisherKey: "ed25519:k1", publisherName: "Alpha" })),
    ]);
    expect(g.map((x) => x.title)).toEqual(["Alpha", "Zeta"]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it } from "vitest";
import { actionFor, asRegistryError, errorHint, latestScope, shortKey, trustLabel } from "./registry";
import { app, registry } from "@/test/fixtures";

describe("asRegistryError", () => {
  it("keeps a serialised command error", () => {
    const e = asRegistryError({ code: "untrusted_signer", message: "m", signer: "k", registryId: "r", registryName: "n" });
    expect(e).toEqual({ code: "untrusted_signer", message: "m", signer: "k", registryId: "r", registryName: "n" });
  });
  it("fills missing optional fields", () => {
    expect(asRegistryError({ code: "x", message: "y" })).toEqual({ code: "x", message: "y", signer: null, registryId: null, registryName: null });
  });
  it("wraps strings and errors", () => {
    expect(asRegistryError("boom")).toMatchObject({ code: "unknown", message: "boom" });
    expect(asRegistryError(new Error("bang"))).toMatchObject({ code: "unknown", message: "bang" });
    expect(asRegistryError(null)).toMatchObject({ code: "unknown" });
    expect(asRegistryError(42).message).toBeTruthy();
  });
});

describe("errorHint", () => {
  it("helps where a next step exists and stays quiet otherwise", () => {
    expect(errorHint("fetch_failed")).toMatch(/connection/);
    expect(errorHint("insecure_url")).toMatch(/https/);
    expect(errorHint("rollback")).toMatch(/backwards/);
    expect(errorHint("bad_signature")).toMatch(/refused/);
    expect(errorHint("revoked")).toBeNull();
    expect(errorHint("anything_else")).toBeNull();
  });
});

describe("actionFor", () => {
  it("installs what is new, updates what is older, and explains the rest", () => {
    expect(actionFor(app({ state: "notInstalled" }))).toEqual({ kind: "install", label: "Install" });
    expect(actionFor(app({ state: "updateAvailable", latest: "2.0.0" }))).toEqual({ kind: "update", label: "Update to 2.0.0" });
    expect(actionFor(app({ state: "installed", installedVersion: "1.0.2" }))).toMatchObject({ kind: "none", label: "Installed" });
    expect(actionFor(app({ state: "licensed" }))).toMatchObject({ kind: "none", label: "Not available yet" });
  });
  it("never offers a withdrawn version, whatever its install state", () => {
    for (const state of ["notInstalled", "updateAvailable", "installed"] as const) {
      expect(actionFor(app({ state, latestRevoked: true })).kind === "none" || state === "installed").toBe(true);
    }
    expect(actionFor(app({ state: "notInstalled", latestRevoked: true }))).toMatchObject({ kind: "none", label: "Withdrawn" });
    expect(actionFor(app({ state: "updateAvailable", latestRevoked: true }))).toMatchObject({ kind: "none", label: "Withdrawn" });
  });
  it("licensed wins over everything", () => {
    expect(actionFor(app({ state: "licensed", latestRevoked: true })).kind).toBe("none");
  });
});

describe("labels", () => {
  it("says a pinned key is the user's choice and an anchored one is verified", () => {
    expect(trustLabel(registry())).toBe("Verified: Enigma Technologies Solutions");
    expect(trustLabel(registry({ trust: "pinned" }))).toBe("Key pinned by you");
  });
  it("shortens long keys and leaves short ones", () => {
    expect(shortKey("ed25519:2daedA0n4NSI2p2McCqLBfGiKRmR5XCm8lypbQTT6hg")).toBe("ed25519:2daedA0n…QTT6hg");
    expect(shortKey("short")).toBe("short");
  });
  it("reads the scope of the latest version", () => {
    expect(latestScope(app())).toEqual(["storage", { smartcard: ["a0000005272101"] }]);
    expect(latestScope(app({ latest: "9.9.9" }))).toEqual([]);
  });
});

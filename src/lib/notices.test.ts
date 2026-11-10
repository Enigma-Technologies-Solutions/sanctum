// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it } from "vitest";
import { EVERY_MS, failureSummary, isDue } from "./notices";
import type { RegistryCheckReport } from "./types";

describe("when a timed check is due", () => {
  const now = 2_000_000_000_000;
  it("is due when there has never been a check", () => expect(isDue(null, now)).toBe(true));
  it("is not due within a day", () => expect(isDue(now - EVERY_MS + 1, now)).toBe(false));
  it("is due after a day", () => expect(isDue(now - EVERY_MS, now)).toBe(true));
  it("is due when the saved time is in the future, as after a clock change", () =>
    expect(isDue(now + 1000, now)).toBe(true));
});

const fail = (name: string) =>
  ({ registryId: name, registryName: name, state: "failed", code: "fetch_failed", message: "x" }) as const;
const ok = (name: string) =>
  ({
    registryId: name,
    registryName: name,
    state: "checked",
    report: {} as never,
  }) as const;
const report = (items: RegistryCheckReport["items"]): RegistryCheckReport => ({
  items,
  notices: { updates: [], revoked: [] },
});

describe("the line about a check that could not finish", () => {
  it("says nothing when every registry answered", () => expect(failureSummary(report([ok("a")]))).toBeNull());
  it("names the registry that did not answer", () =>
    expect(failureSummary(report([ok("a"), fail("b")]))).toContain("b"));
  it("says the saved lists are still used when none answered", () =>
    expect(failureSummary(report([fail("a")]))).toContain("saved lists are still in use"));
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_KEY, applyTheme, readTheme, resolveTheme, saveTheme } from "./theme";

function mockSystem(dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: dark && q.includes("dark"),
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme", () => {
  it("defaults to the system choice", () => {
    expect(readTheme()).toBe("system");
  });

  it("ignores a stored value it does not know", () => {
    localStorage.setItem(THEME_KEY, "purple");
    expect(readTheme()).toBe("system");
  });

  it("system follows the operating system", () => {
    mockSystem(true);
    expect(resolveTheme("system")).toBe("dark");
    mockSystem(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("an explicit choice beats the system", () => {
    mockSystem(true);
    expect(resolveTheme("light")).toBe("light");
    mockSystem(false);
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("falls back to light when matchMedia is missing", () => {
    expect(resolveTheme("system")).toBe("light");
  });

  it("saving applies to the page and persists, system clears the key", () => {
    saveTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readTheme()).toBe("dark");
    saveTheme("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("still applies when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    saveTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    vi.restoreAllMocks();
  });

  it("applyTheme writes the resolved theme", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

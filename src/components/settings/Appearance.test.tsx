// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Commands } from "@/lib/commands";
import { THEME_KEY } from "@/lib/theme";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: { checkForUpdate: vi.fn(), installUpdate: vi.fn(), getPolicyStatus: vi.fn(), getTrustAnchors: vi.fn(), agentSetup: vi.fn() },
}));

const C = vi.mocked(Commands) as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  for (const k of Object.keys(C)) C[k].mockResolvedValue(k === "getPolicyStatus" ? { managed: false, error: null, pinnedCount: null } : []);
  C.agentSetup.mockResolvedValue({ supported: false, enabled: true, installed: false, downloadMb: 0 });
});
afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("Appearance setting", () => {
  it("offers System, Light and Dark, with System chosen by default", () => {
    render(<SettingsView version="0.1.0" />);
    const group = screen.getByRole("radiogroup", { name: /theme/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "false");
  });

  it("choosing Dark applies it to the page and remembers it", async () => {
    const user = userEvent.setup();
    render(<SettingsView version="0.1.0" />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("has no automated accessibility violations", async () => {
    const { container } = render(<SettingsView version="0.1.0" />);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations).toEqual([]);
  });
});

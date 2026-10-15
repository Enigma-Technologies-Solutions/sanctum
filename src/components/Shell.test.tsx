// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { AppHeader } from "./AppHeader";
import { Library } from "./Library";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: { listTools: vi.fn(), getPolicyStatus: vi.fn(), getTool: vi.fn() },
}));

const C = vi.mocked(Commands);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  C.listTools.mockResolvedValue([]);
  C.getPolicyStatus.mockResolvedValue({ managed: false, error: null, pinnedCount: null } as never);
});

describe("the main navigation", () => {
  it("has a Catalogue tab between Tool Vault and Settings, and marks the current one", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerender } = render(<AppHeader view="vault" onNavigate={onNavigate} version="0.1.0" />);
    const tabs = screen.getAllByRole("button").map((b) => b.textContent);
    expect(tabs).toEqual(["Tool Vault", "Catalogue", "Settings"]);
    expect(screen.getByRole("button", { name: "Tool Vault" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: "Catalogue" }));
    expect(onNavigate).toHaveBeenCalledWith("catalogue");
    rerender(<AppHeader view="catalogue" onNavigate={onNavigate} version="0.1.0" />);
    expect(screen.getByRole("button", { name: "Catalogue" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Tool Vault" })).not.toHaveAttribute("aria-current");
  });
});

describe("the Tool Vault after an install elsewhere", () => {
  it("reloads its list when told something was installed, and not otherwise", async () => {
    const { rerender } = render(
      <TooltipProvider>
        <Library refreshKey={0} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(C.listTools).toHaveBeenCalledTimes(1));
    rerender(
      <TooltipProvider>
        <Library refreshKey={0} />
      </TooltipProvider>,
    );
    expect(C.listTools).toHaveBeenCalledTimes(1);
    rerender(
      <TooltipProvider>
        <Library refreshKey={1} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(C.listTools).toHaveBeenCalledTimes(2));
  });
});

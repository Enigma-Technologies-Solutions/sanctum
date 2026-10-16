// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { ENIGMA_REGISTRY_URL } from "@/lib/registry";
import { commandError, registry } from "@/test/fixtures";
import { Library } from "./Library";
import { WelcomePanel } from "./WelcomePanel";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: { listTools: vi.fn(), getPolicyStatus: vi.fn(), getTool: vi.fn(), listRegistries: vi.fn(), addRegistry: vi.fn() },
}));

const C = vi.mocked(Commands);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  C.listTools.mockResolvedValue([]);
  C.getPolicyStatus.mockResolvedValue({ managed: false, error: null, pinnedCount: null } as never);
});

describe("the welcome panel", () => {
  it("says what Sanctum is, offers one obvious first step, and makes no request until it is clicked", () => {
    render(<WelcomePanel onOpenCatalogue={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Welcome to Sanctum" })).toBeInTheDocument();
    expect(screen.getByText(/starts with no access/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse signed tools" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "How it works" }).children).toHaveLength(3);
    expect(C.listRegistries).not.toHaveBeenCalled();
    expect(C.addRegistry).not.toHaveBeenCalled();
  });

  it("adds the Enigma registry once, then opens the Catalogue, and installs nothing", async () => {
    C.listRegistries.mockResolvedValue([]);
    C.addRegistry.mockResolvedValue(registry());
    const open = vi.fn();
    const user = userEvent.setup();
    render(<WelcomePanel onOpenCatalogue={open} />);
    await user.click(screen.getByRole("button", { name: "Browse signed tools" }));
    expect(C.addRegistry).toHaveBeenCalledTimes(1);
    expect(C.addRegistry).toHaveBeenCalledWith(ENIGMA_REGISTRY_URL);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not add the registry twice when it is already there", async () => {
    C.listRegistries.mockResolvedValue([registry()]);
    const open = vi.fn();
    const user = userEvent.setup();
    render(<WelcomePanel onOpenCatalogue={open} />);
    await user.click(screen.getByRole("button", { name: "Browse signed tools" }));
    expect(C.addRegistry).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a registry with a look-alike address does not count as Enigma's", async () => {
    C.listRegistries.mockResolvedValue([registry({ baseUrl: "https://sanctum.enigma.sh.evil.example/registry/v1/" })]);
    C.addRegistry.mockResolvedValue(registry());
    const user = userEvent.setup();
    render(<WelcomePanel onOpenCatalogue={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Browse signed tools" }));
    expect(C.addRegistry).toHaveBeenCalledWith(ENIGMA_REGISTRY_URL);
  });

  it("stays put and explains when the registry cannot be reached", async () => {
    C.listRegistries.mockResolvedValue([]);
    C.addRegistry.mockRejectedValue(commandError("network", "Could not reach the registry."));
    const open = vi.fn();
    const user = userEvent.setup();
    render(<WelcomePanel onOpenCatalogue={open} />);
    await user.click(screen.getByRole("button", { name: "Browse signed tools" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the registry.");
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Browse signed tools" })).toBeEnabled();
  });

  it("has no automated accessibility violations", async () => {
    const { container } = render(<WelcomePanel onOpenCatalogue={vi.fn()} />);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the Tool Vault", () => {
  const withTool = {
    tool: { id: "a", name: "A", description: "", tags: [], icon_data: null, current_ver: "v", approvals: [], created_at: 0, updated_at: 0 },
    current_version: { id: "v", tool_id: "a", version_num: 1, file_size: 1, checksum: "ab".repeat(32), manifest: { name: "A", version: "1", checksum: "ab".repeat(32), detected: [], signature: null }, quarantined: false, created_at: 0 },
    all_versions: [],
    provenance: null,
  } as never;

  it("greets a new person, and the paste and open buttons are still right there", async () => {
    render(
      <TooltipProvider>
        <Library onOpenCatalogue={vi.fn()} />
      </TooltipProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Welcome to Sanctum" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /paste from clipboard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open file/i })).toBeInTheDocument();
  });

  it("stops greeting once there is a tool", async () => {
    C.listTools.mockResolvedValue([withTool]);
    render(
      <TooltipProvider>
        <Library onOpenCatalogue={vi.fn()} />
      </TooltipProvider>,
    );
    await screen.findByRole("heading", { level: 2, name: "Your tools" });
    expect(screen.queryByRole("heading", { name: "Welcome to Sanctum" })).toBeNull();
  });
});

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
  Commands: { listTools: vi.fn(), getPolicyStatus: vi.fn(), getTool: vi.fn(), agentSetup: vi.fn(), agentAccount: vi.fn() },
}));

const C = vi.mocked(Commands);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  C.listTools.mockResolvedValue([]);
  C.getPolicyStatus.mockResolvedValue({ managed: false, error: null, pinnedCount: null } as never);
  C.agentSetup.mockResolvedValue({ supported: false, enabled: true, installed: false, downloadMb: 0 });
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

describe("page headers", () => {
  it("Tool Vault has the shared header and keeps its controls below it", async () => {
    render(
      <TooltipProvider>
        <Library />
      </TooltipProvider>,
    );
    const h1 = await screen.findByRole("heading", { level: 1, name: "Installed tools" });
    const header = h1.closest("header")!;
    expect(header).toBeInTheDocument();
    expect(header.querySelector("p")).toHaveStyle({ minHeight: "57px" });
    // Paste and Open are in the page body, not in the header.
    expect(header).not.toContainElement(screen.getByRole("button", { name: /paste from clipboard/i }));
    expect(header).not.toContainElement(screen.getByRole("button", { name: /open file/i }));
  });
});

describe("the Tool Vault grouped by publisher", () => {
  const mk = (id: string, name: string, prov: unknown) =>
    ({
      tool: { id, name, description: "", tags: [], icon_data: null, current_ver: `${id}-v`, approvals: [], created_at: 0, updated_at: 0 },
      current_version: { id: `${id}-v`, tool_id: id, version_num: 1, file_size: 10, checksum: "ab".repeat(32), manifest: { name, version: "1", checksum: "ab".repeat(32), detected: [], signature: null }, quarantined: false, created_at: 0 },
      all_versions: [],
      provenance: prov,
    }) as never;
  const verified = { versionId: "x", appId: "sh.enigma.otp-vault", publisherKey: "ed25519:K", publisherName: "Enigma Technologies Solutions", trust: "verified", name: "OTP", version: "1.0.2", issuedAt: 0, installedAt: 0 };

  it("shows one section per publisher, with the tool count", async () => {
    C.listTools.mockResolvedValue([mk("a", "OTP Vault", verified), mk("b", "Shamir", verified), mk("c", "My own tool", null)]);
    render(
      <TooltipProvider>
        <Library />
      </TooltipProvider>,
    );
    const enigma = await screen.findByRole("heading", { level: 2, name: "Enigma Technologies Solutions" });
    const section = enigma.closest("section")!;
    expect(section).toHaveTextContent("Verified publisher");
    expect(section).toHaveTextContent("2 tools");
    expect(section).toHaveTextContent("OTP Vault");
    expect(section).not.toHaveTextContent("My own tool");
    const own = screen.getByRole("heading", { level: 2, name: "Your tools" }).closest("section")!;
    expect(own).toHaveTextContent("not signed");
    expect(own).toHaveTextContent("My own tool");
    // with a tool of their own there is no empty card, and no publisher group has one
    expect(own).not.toHaveTextContent("will appear here");
    expect(section).not.toHaveTextContent("will appear here");
  });

  it("shows the empty card in Your tools when only signed tools exist", async () => {
    C.listTools.mockResolvedValue([mk("a", "OTP Vault", verified)]);
    render(
      <TooltipProvider>
        <Library />
      </TooltipProvider>,
    );
    const own = (await screen.findByRole("heading", { level: 2, name: "Your tools" })).closest("section")!;
    expect(own).toHaveTextContent("0 tools");
    expect(own).toHaveTextContent("Your first tool will appear here");
    // the signed tool is a different group, under its publisher
    expect(own).not.toHaveTextContent("OTP Vault");
    expect(screen.getByRole("heading", { level: 2, name: "Enigma Technologies Solutions" }).closest("section")).toHaveTextContent("OTP Vault");
  });

  it("shows only Your tools, with the empty card, when the vault is empty", async () => {
    render(
      <TooltipProvider>
        <Library />
      </TooltipProvider>,
    );
    const own = (await screen.findByRole("heading", { level: 2, name: "Your tools" })).closest("section")!;
    expect(own).toContainElement(screen.getByTestId("empty-slot"));
    expect(screen.getByTestId("empty-slot")).toHaveTextContent("Your first tool will appear here");
    // no publisher groups when nothing is signed
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });
});

describe("tools an agent wrote", () => {
  const tool = (id: string, origin: string | null) =>
    ({
      tool: { id, name: `Tool ${id}`, description: "", tags: [], icon_data: null, current_ver: "v", approvals: [], created_at: 0, updated_at: 0, origin },
      current_version: { id: "v", tool_id: id, version_num: 1, file_size: 1, checksum: "ab".repeat(32), manifest: { name: "A", version: "1", checksum: "ab".repeat(32), detected: [], signature: null }, quarantined: false, created_at: 0 },
      all_versions: [],
      provenance: null,
    }) as never;

  const renderLibrary = () =>
    render(
      <TooltipProvider>
        <Library />
      </TooltipProvider>,
    );

  it("are marked as made with Codex, and a tool the person added is not", async () => {
    C.listTools.mockResolvedValue([tool("a", "agent"), tool("b", null)]);
    renderLibrary();
    await screen.findByText("Tool a");
    const badges = screen.getAllByTestId("origin-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAccessibleName(/Made with Codex\. Written by an AI agent from your instructions\. Nobody has reviewed or signed it/);
    // The mark is a source, not a seal: nothing in it says safe, verified or trusted.
    expect(badges[0].getAttribute("aria-label")).not.toMatch(/safe|verified|trusted/i);
  });

  it("show the origin in the card's tooltip on focus", async () => {
    C.listTools.mockResolvedValue([tool("a", "agent")]);
    const user = userEvent.setup();
    renderLibrary();
    await screen.findByText("Tool a");
    await user.tab();
    screen.getByTestId("origin-badge").focus();
    expect(await screen.findAllByText("Made with Codex")).not.toHaveLength(0);
  });

  it("appear in the Tool Vault as soon as the Create window adds one", async () => {
    let fire!: () => void;
    vi.mocked(listen).mockImplementation((async (name: string, cb: () => void) => {
      if (name === "library-changed") fire = cb;
      return () => {};
    }) as never);
    renderLibrary();
    await waitFor(() => expect(C.listTools).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fire).toBeDefined());
    C.listTools.mockResolvedValue([tool("n", "agent")]);
    fire();
    expect(await screen.findByText("Tool n")).toBeInTheDocument();
    expect(C.listTools).toHaveBeenCalledTimes(2);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Commands } from "@/lib/commands";
import { commandError } from "@/test/fixtures";
import { InspectView } from "./InspectView";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: { getProvenance: vi.fn(), agentOpenCreateWindow: vi.fn() },
}));

const C = vi.mocked(Commands);

const item = (origin: string | null) =>
  ({
    tool: { id: "tool-1", name: "Timer", description: "", tags: [], icon_data: null, current_ver: "v", approvals: [], created_at: 0, updated_at: 0, origin },
    current_version: { id: "v", tool_id: "tool-1", version_num: 1, file_size: 1, checksum: "ab".repeat(32), manifest: { name: "Timer", version: "1", checksum: "ab".repeat(32), detected: [], signature: null }, quarantined: false, created_at: 0 },
    all_versions: [],
    provenance: null,
  }) as never;

function show(origin: string | null) {
  return render(
    <TooltipProvider>
      <InspectView item={item(origin)} onBack={vi.fn()} onRun={vi.fn()} onRefresh={vi.fn()} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  C.getProvenance.mockResolvedValue(null as never);
  C.agentOpenCreateWindow.mockResolvedValue(undefined);
});

describe("changing a tool with Codex", () => {
  it("is offered under Update for a tool Codex made, and opens the Create window with that tool", async () => {
    const user = userEvent.setup();
    show("agent");
    expect(screen.queryByRole("button", { name: /Modify with Codex/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Update/ }));
    await user.click(screen.getByRole("button", { name: /Modify with Codex/ }));
    expect(C.agentOpenCreateWindow).toHaveBeenCalledWith("tool-1");
    // The panel closes once the window is on its way.
    expect(screen.queryByRole("button", { name: /Modify with Codex/ })).toBeNull();
  });

  it("is not offered for a tool the person added themselves", async () => {
    const user = userEvent.setup();
    show(null);
    await user.click(screen.getByRole("button", { name: /Update/ }));
    expect(screen.getByRole("button", { name: /Paste Clipboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Modify with Codex/ })).toBeNull();
  });

  it("says why when the window cannot open, and keeps the panel", async () => {
    C.agentOpenCreateWindow.mockRejectedValue(commandError("unsupported", "Building apps is not available on this computer yet."));
    const user = userEvent.setup();
    show("agent");
    await user.click(screen.getByRole("button", { name: /Update/ }));
    await user.click(screen.getByRole("button", { name: /Modify with Codex/ }));
    expect(await screen.findByText("Building apps is not available on this computer yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Modify with Codex/ })).toBeInTheDocument();
  });
});

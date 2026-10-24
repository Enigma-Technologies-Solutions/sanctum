// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Commands } from "@/lib/commands";
import { CreateAppCard } from "./CreateAppCard";

vi.mock("@/lib/commands", () => ({
  Commands: {
    agentSetup: vi.fn(),
    agentAccount: vi.fn(),
    agentSignIn: vi.fn(),
    agentChatStart: vi.fn(),
    agentOpenCreateWindow: vi.fn(),
  },
}));

const C = vi.mocked(Commands);
const NONE = { supported: false, installed: false, downloadMb: 0 };
const READY = { supported: true, installed: true, downloadMb: 100 };
const FIRST = { supported: true, installed: false, downloadMb: 100 };
const START = { name: /start building/i };

beforeEach(() => {
  vi.resetAllMocks();
  C.agentSetup.mockResolvedValue(NONE);
});

describe("the Create your own app card", () => {
  it("is not shown on a computer Sanctum has no Codex build for", async () => {
    render(<CreateAppCard />);
    await vi.waitFor(() => expect(C.agentSetup).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("create-app-card")).toBeNull();
  });

  it("is shown when Codex can be set up, and looking starts and downloads nothing", async () => {
    C.agentSetup.mockResolvedValue(READY);
    render(<CreateAppCard />);
    expect(await screen.findByRole("button", START)).toBeInTheDocument();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(C.agentSignIn).not.toHaveBeenCalled();
    expect(C.agentChatStart).not.toHaveBeenCalled();
  });

  it("says up front that the first use downloads Codex, and how big it is", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    render(<CreateAppCard />);
    await screen.findByRole("button", START);
    expect(screen.getByText(/downloads Codex \(about 100 MB\) from OpenAI's GitHub releases/)).toBeInTheDocument();
  });

  it("does not mention a download once Codex is there", async () => {
    C.agentSetup.mockResolvedValue(READY);
    render(<CreateAppCard />);
    await screen.findByRole("button", START);
    expect(screen.queryByText(/downloads Codex/)).toBeNull();
  });

  it("opens the Create window on click and does nothing else", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    C.agentOpenCreateWindow.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", START));
    expect(C.agentOpenCreateWindow).toHaveBeenCalledTimes(1);
    expect(C.agentSignIn).not.toHaveBeenCalled();
    expect(C.agentAccount).not.toHaveBeenCalled();
  });

  it("says so when the window cannot be opened", async () => {
    C.agentSetup.mockResolvedValue(READY);
    C.agentOpenCreateWindow.mockRejectedValue({ code: "window", message: "no window\u202E for you" });
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", START));
    expect((await screen.findByRole("alert")).textContent).toBe("no window for you");
  });

  it("has no automated accessibility violations", async () => {
    C.agentSetup.mockResolvedValue(READY);
    const { container } = render(<CreateAppCard />);
    await screen.findByRole("button", START);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

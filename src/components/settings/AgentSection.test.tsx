// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Commands } from "@/lib/commands";
import { commandError } from "@/test/fixtures";
import { listen } from "@tauri-apps/api/event";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: {
    checkForUpdate: vi.fn(),
    installUpdate: vi.fn(),
    getPolicyStatus: vi.fn(),
    getTrustAnchors: vi.fn(),
    agentSetup: vi.fn(),
    agentAccount: vi.fn(),
    agentSignIn: vi.fn(),
    agentCancelSignIn: vi.fn(),
    agentSignOut: vi.fn(),
    agentSetEnabled: vi.fn(),
  },
}));

const C = vi.mocked(Commands);
const pro = { signedIn: true, email: "me@example.com", plan: "Pro" };
const out = { signedIn: false, email: null, plan: null };
const READY = { supported: true, enabled: true, installed: true, downloadMb: 100 };
const FIRST = { supported: true, enabled: true, installed: false, downloadMb: 100 };

beforeEach(() => {
  vi.resetAllMocks();
  C.getPolicyStatus.mockResolvedValue({ managed: false, error: null, pinnedCount: null } as never);
  C.getTrustAnchors.mockResolvedValue([]);
  C.agentSetup.mockResolvedValue(READY);
  vi.mocked(listen).mockResolvedValue(() => {});
});

describe("Settings, Agent", () => {
  it("says so on a computer Sanctum has no Codex build for, and never starts anything", async () => {
    C.agentSetup.mockResolvedValue({ supported: false, enabled: true, installed: false, downloadMb: 0 });
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByText(/not available on this kind of computer/)).toBeInTheDocument();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /sign in with chatgpt/i })).toBeNull();
  });

  it("before the first download, offers sign-in, states the size, and does not start Codex or download", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    expect(screen.getByText(/downloads Codex \(about 100 MB\)/)).toBeInTheDocument();
    expect(screen.getByText("Not signed in.")).toBeInTheDocument();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(C.agentSignIn).not.toHaveBeenCalled();
  });

  it("shows who is signed in, with the plan, and offers Sign out", async () => {
    C.agentAccount.mockResolvedValue(pro);
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByText("Signed in to ChatGPT as me@example.com (Pro).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in with chatgpt/i })).toBeNull();
  });

  it("offers sign-in when nobody is signed in, and signing in updates the card", async () => {
    C.agentAccount.mockResolvedValue(out);
    C.agentSignIn.mockResolvedValue(pro);
    const user = userEvent.setup();
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByText("Not signed in.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    expect(await screen.findByText(/Signed in to ChatGPT as me@example.com/)).toBeInTheDocument();
  });

  it("is off until turned on: it says what turning on means, and starts and downloads nothing", async () => {
    C.agentSetup.mockResolvedValue({ ...READY, enabled: false });
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeInTheDocument();
    expect(screen.getByText(/sent to OpenAI/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in with chatgpt/i })).toBeNull();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(C.agentSignIn).not.toHaveBeenCalled();
  });

  it("turns on, then shows the sign-in, and turns off again", async () => {
    C.agentSetup.mockResolvedValue({ ...FIRST, enabled: false });
    C.agentSetEnabled.mockResolvedValueOnce(FIRST).mockResolvedValueOnce({ ...FIRST, enabled: false });
    const user = userEvent.setup();
    render(<SettingsView version="0.2.0" />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(C.agentSetEnabled).toHaveBeenLastCalledWith(true);
    expect(await screen.findByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    expect(C.agentSignIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(C.agentSetEnabled).toHaveBeenLastCalledWith(false);
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("signs out and returns to the signed-out state", async () => {
    C.agentAccount.mockResolvedValue(pro);
    C.agentSignOut.mockResolvedValue(out);
    const user = userEvent.setup();
    render(<SettingsView version="0.2.0" />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(C.agentSignOut).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Not signed in.")).toBeInTheDocument();
  });

  it("lets the person retry when the account could not be read", async () => {
    C.agentAccount.mockRejectedValue(commandError("process", "cannot start the agent: nope"));
    render(<SettingsView version="0.2.0" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot start the agent: nope");
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
  });

  it("has no automated accessibility violations", async () => {
    C.agentAccount.mockResolvedValue(pro);
    const { container } = render(<SettingsView version="0.2.0" />);
    await screen.findByText(/Signed in to ChatGPT/);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

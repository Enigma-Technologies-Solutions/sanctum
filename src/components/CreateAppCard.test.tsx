// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { commandError } from "@/test/fixtures";
import { CreateAppCard } from "./CreateAppCard";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/commands", () => ({
  Commands: {
    agentSetup: vi.fn(),
    agentAccount: vi.fn(),
    agentSignIn: vi.fn(),
    agentCancelSignIn: vi.fn(),
    agentSignOut: vi.fn(),
  },
}));

const C = vi.mocked(Commands);
const NONE = { supported: false, installed: false, downloadMb: 0 };
const READY = { supported: true, installed: true, downloadMb: 100 };
const FIRST = { supported: true, installed: false, downloadMb: 100 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockResolvedValue(() => {});
  C.agentSetup.mockResolvedValue(NONE);
});

describe("the Create your own app card", () => {
  const SIGN_IN = { name: "Sign in with ChatGPT" };
  const pro = { signedIn: true, email: "me@example.com", plan: "Pro" };

  it("is not offered on a computer Sanctum has no Codex build for", async () => {
    render(<CreateAppCard />);
    await vi.waitFor(() => expect(C.agentSetup).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("create-app-card")).toBeNull();
    expect(screen.queryByRole("button", SIGN_IN)).toBeNull();
  });

  it("is offered when Codex can be set up, and looking starts and downloads nothing", async () => {
    C.agentSetup.mockResolvedValue(READY);
    render(<CreateAppCard />);
    expect(await screen.findByRole("button", SIGN_IN)).toBeInTheDocument();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(C.agentSignIn).not.toHaveBeenCalled();
    expect(screen.getByText(/never sees your password or sign-in token/i)).toBeInTheDocument();
  });

  it("says up front that the first sign-in downloads Codex, and how big it is", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    render(<CreateAppCard />);
    await screen.findByRole("button", SIGN_IN);
    expect(screen.getByText(/downloads Codex \(about 100 MB\) from OpenAI's GitHub releases/)).toBeInTheDocument();
    expect(C.agentSignIn).not.toHaveBeenCalled();
  });

  it("does not mention a download once Codex is there", async () => {
    C.agentSetup.mockResolvedValue(READY);
    render(<CreateAppCard />);
    await screen.findByRole("button", SIGN_IN);
    expect(screen.queryByText(/downloads Codex/)).toBeNull();
  });

  it("shows the download's progress, then the wait for the browser", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    let emit!: (p: { done: number; total: number }) => void;
    vi.mocked(listen).mockImplementation((async (_e: string, cb: (e: { payload: { done: number; total: number } }) => void) => {
      emit = (payload) => cb({ payload });
      return () => {};
    }) as never);
    C.agentSignIn.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect(await screen.findByText("Getting ready…")).toBeInTheDocument();
    act(() => emit({ done: 42, total: 100 }));
    expect(await screen.findByText("Downloading Codex… 42%")).toBeInTheDocument();
    act(() => emit({ done: 100, total: 100 }));
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
  });

  it("signs in on click and then shows who is signed in", async () => {
    C.agentSetup.mockResolvedValue(READY);
    C.agentSignIn.mockResolvedValue(pro);
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect(C.agentSignIn).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Signed in to ChatGPT as me@example.com \(Pro\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", SIGN_IN)).toBeNull();
  });

  it("shows a waiting state with Cancel, and cancelling is not an error", async () => {
    C.agentSetup.mockResolvedValue(READY);
    let reject!: (e: unknown) => void;
    C.agentSignIn.mockReturnValue(new Promise((_, r) => (reject = r)));
    C.agentCancelSignIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(C.agentCancelSignIn).toHaveBeenCalledTimes(1);
    reject(commandError("cancelled", "Sign-in was cancelled."));
    expect(await screen.findByRole("button", SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a failed sign-in, with hidden characters removed, and lets the person retry", async () => {
    C.agentSetup.mockResolvedValue(READY);
    C.agentSignIn.mockRejectedValue(commandError("login_failed", "sign-in failed: de\u202Enied"));
    const user = userEvent.setup();
    render(<CreateAppCard />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("sign-in failed: denied");
    expect(screen.getByRole("button", SIGN_IN)).toBeEnabled();
  });

  it("has no automated accessibility violations with the sign-in showing", async () => {
    C.agentSetup.mockResolvedValue(READY);
    const { container } = render(<CreateAppCard />);
    await screen.findByRole("button", SIGN_IN);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

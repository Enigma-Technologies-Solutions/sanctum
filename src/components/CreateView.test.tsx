// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { commandError } from "@/test/fixtures";
import type { DraftReport } from "@/lib/types";
import { CreateView } from "./CreateView";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@/lib/commands", () => ({
  Commands: {
    agentSetup: vi.fn(),
    agentAccount: vi.fn(),
    agentSignIn: vi.fn(),
    agentCancelSignIn: vi.fn(),
    agentChatStart: vi.fn(),
    agentChatSend: vi.fn(),
    agentChatStop: vi.fn(),
    agentChatClose: vi.fn(),
    agentPreviewDraft: vi.fn(),
    agentScanDraft: vi.fn(),
    agentAddDraft: vi.fn(),
    agentDraftHistory: vi.fn(),
    agentRestoreDraft: vi.fn(),
    agentGetInstructions: vi.fn(),
    agentSetInstructions: vi.fn(),
  },
}));

const C = vi.mocked(Commands);
const NONE = { supported: false, installed: false, downloadMb: 0 };
const READY = { supported: true, installed: true, downloadMb: 100 };
const FIRST = { supported: true, installed: false, downloadMb: 100 };
const pro = { signedIn: true, email: "me@example.com", plan: "Pro" };
const out = { signedIn: false, email: null, plan: null };
const SIGN_IN = { name: "Sign in with ChatGPT" };
const GUIDE_SRC = { kind: "guide" as const, title: "Sanctum guide", detail: "The rules and what a tool can do.", toolId: null };
const INS_SRC = { kind: "instructions" as const, title: "Your instructions", detail: "None set.", toolId: null };
const STARTED = { model: "gpt-x", version: "0.163.0", directory: "~/Library/sessions/abc", sources: [GUIDE_SRC, INS_SRC] };
const REPORT: DraftReport = { name: "Timer", description: "Counts down.", size: 2048, capabilities: [], savesAs: "new", toolName: null };
const DRAFT = { size: 2048, tooLarge: false };
const DONE = { status: "completed" as "completed" | "interrupted" | "failed", error: null, refused: 0, draft: null };

type Handler = (e: { payload: unknown }) => void;
let handlers: Record<string, Handler> = {};

beforeEach(() => {
  vi.resetAllMocks();
  handlers = {};
  vi.mocked(listen).mockImplementation((async (name: string, cb: Handler) => {
    handlers[name] = cb;
    return () => {
      delete handlers[name];
    };
  }) as never);
  C.agentSetup.mockResolvedValue(READY);
  C.agentAccount.mockResolvedValue(pro);
  C.agentChatStart.mockResolvedValue(STARTED);
  C.agentChatClose.mockResolvedValue(undefined);
  C.agentScanDraft.mockResolvedValue(REPORT);
  C.agentChatStop.mockResolvedValue(undefined);
  C.agentDraftHistory.mockResolvedValue([]);
  C.agentGetInstructions.mockResolvedValue("");
});

const emit = (event: string, payload: unknown) => act(() => handlers[event]({ payload }));
const composer = () => screen.getByRole("textbox", { name: "Message to Codex" });

describe("the Create view: before signing in", () => {
  it("explains when Sanctum has no Codex for this computer", async () => {
    C.agentSetup.mockResolvedValue(NONE);
    render(<CreateView onBack={vi.fn()} />);
    expect(await screen.findByText(/not available on this kind of computer/)).toBeInTheDocument();
    expect(C.agentChatStart).not.toHaveBeenCalled();
  });

  it("asks for a sign-in, and says the first one downloads Codex", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    render(<CreateView onBack={vi.fn()} />);
    expect(await screen.findByRole("button", SIGN_IN)).toBeInTheDocument();
    expect(screen.getByText(/downloads Codex \(about 100 MB\)/)).toBeInTheDocument();
    expect(C.agentAccount).not.toHaveBeenCalled();
    expect(C.agentSignIn).not.toHaveBeenCalled();
    expect(C.agentChatStart).not.toHaveBeenCalled();
  });

  it("asks for a sign-in when Codex is there but nobody is signed in", async () => {
    C.agentAccount.mockResolvedValue(out);
    render(<CreateView onBack={vi.fn()} />);
    expect(await screen.findByRole("button", SIGN_IN)).toBeInTheDocument();
    expect(C.agentChatStart).not.toHaveBeenCalled();
  });

  it("shows the download's progress, then the wait for the browser", async () => {
    C.agentSetup.mockResolvedValue(FIRST);
    C.agentSignIn.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect(await screen.findByText("Getting ready…")).toBeInTheDocument();
    emit("agent-download", { done: 42, total: 100 });
    expect(await screen.findByText("Downloading Codex… 42%")).toBeInTheDocument();
    emit("agent-download", { done: 100, total: 100 });
    expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();
  });

  it("goes on to the chat after signing in", async () => {
    C.agentAccount.mockResolvedValue(out);
    C.agentSignIn.mockResolvedValue(pro);
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect(await screen.findByRole("textbox", { name: "Message to Codex" })).toBeInTheDocument();
    expect(C.agentChatStart).toHaveBeenCalledTimes(1);
  });

  it("cancelling the sign-in is not an error", async () => {
    C.agentAccount.mockResolvedValue(out);
    let reject!: (e: unknown) => void;
    C.agentSignIn.mockReturnValue(new Promise((_, r) => (reject = r)));
    C.agentCancelSignIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(C.agentCancelSignIn).toHaveBeenCalledTimes(1);
    reject(commandError("cancelled", "Sign-in was cancelled."));
    expect(await screen.findByRole("button", SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a failed sign-in, with hidden characters removed", async () => {
    C.agentAccount.mockResolvedValue(out);
    C.agentSignIn.mockRejectedValue(commandError("login_failed", "sign-in failed: de\u202Enied"));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await user.click(await screen.findByRole("button", SIGN_IN));
    expect((await screen.findByRole("alert")).textContent).toBe("sign-in failed: denied");
    expect(screen.getByRole("button", SIGN_IN)).toBeEnabled();
  });

  it("has no Tool Vault button when it is the whole window", async () => {
    C.agentSetup.mockResolvedValue(NONE);
    render(<CreateView />);
    await screen.findByText(/not available on this kind of computer/);
    expect(screen.queryByRole("button", { name: /Tool Vault/ })).toBeNull();
  });

  it("goes back to the Tool Vault", async () => {
    C.agentSetup.mockResolvedValue(NONE);
    const back = vi.fn();
    const user = userEvent.setup();
    render(<CreateView onBack={back} />);
    await user.click(await screen.findByRole("button", { name: /Tool Vault/ }));
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("the Create view: chatting", () => {
  it("opens a session when signed in, and sends nothing until a message is sent", async () => {
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(C.agentChatStart).toHaveBeenCalledTimes(1);
    expect(C.agentChatSend).not.toHaveBeenCalled();
    expect(screen.getByText(/Signed in as me@example.com \(Pro\)/)).toBeInTheDocument();
    expect(screen.getByText(/go to OpenAI through your ChatGPT account/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("opens with a box like the one Codex prints: its name, version, model and folder", async () => {
    render(<CreateView onBack={vi.fn()} />);
    const box = await screen.findByTestId("codex-banner");
    expect(box).toHaveTextContent("OpenAI Codex (v0.163.0)");
    expect(box).toHaveTextContent("model:gpt-x");
    expect(box).toHaveTextContent("directory:~/Library/sessions/abc");
  });

  it("leaves out the model and version when Codex does not say them", async () => {
    C.agentChatStart.mockResolvedValue({ model: null, version: null, directory: "~/w", sources: [] });
    render(<CreateView onBack={vi.fn()} />);
    const box = await screen.findByTestId("codex-banner");
    expect(box).toHaveTextContent("OpenAI Codex");
    expect(box).not.toHaveTextContent("model:");
    expect(box).not.toHaveTextContent("(v");
  });

  it("hides the box once the conversation starts", async () => {
    C.agentChatSend.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await screen.findByTestId("codex-banner");
    await user.type(composer(), "go{Enter}");
    await waitFor(() => expect(screen.queryByTestId("codex-banner")).toBeNull());
  });

  it("sends the message and shows the reply as it streams", async () => {
    let finish!: (o: typeof DONE) => void;
    C.agentChatSend.mockReturnValue(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "a timer");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(C.agentChatSend).toHaveBeenCalledWith("a timer");
    expect(composer()).toHaveValue("");
    expect(await screen.findByText(/Codex is working…/)).toBeInTheDocument();
    await waitFor(() => expect(handlers["agent-chat"]).toBeDefined());
    emit("agent-chat", { itemId: "m1", text: "Making " });
    emit("agent-chat", { itemId: "m1", text: "it now" });
    expect(await screen.findByText("Making it now")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    finish(DONE);
    await waitFor(() => expect(screen.queryByText(/Codex is working…/)).toBeNull());
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(handlers["agent-chat"]).toBeUndefined();
  });

  const step = (over: Partial<import("@/lib/types").ChatActivity> = {}) => ({
    itemId: "c1", kind: "command" as const, state: "running" as const, label: "ls -la",
    durationMs: null, exitCode: null, outputLines: null, ...over,
  });

  async function working() {
    C.agentChatSend.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await waitFor(() => expect(handlers["agent-activity"]).toBeDefined());
  }

  it("shows what Codex is doing while it works, and it replaces the plain spinner", async () => {
    await working();
    expect(screen.getByText(/Codex is working…/)).toBeInTheDocument();
    emit("agent-activity", step());
    const row = await screen.findByTestId("codex-step");
    expect(row).toHaveTextContent("$ ls -la");
    expect(row).toHaveAttribute("data-state", "running");
    expect(row).toHaveTextContent(/\d+s/);
    expect(screen.queryByText(/Codex is working…/)).toBeNull();
  });

  it("shows how long Codex has been working, and says when it has gone quiet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await working();
      expect(screen.getByText(/Codex is working… 0s/)).toBeInTheDocument();
      expect(screen.queryByTestId("quiet-note")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(50_000);
      });
      expect(screen.getByText(/Codex is working… 5\ds/)).toBeInTheDocument();
      expect(screen.getByTestId("quiet-note")).toHaveTextContent(/No update from Codex for 5\ds/);
      // Any news from Codex resets the quiet note.
      emit("agent-chat", { itemId: "m1", text: "Still here." });
      expect(screen.queryByTestId("quiet-note")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(70_000);
      });
      expect(screen.getByText(/Codex is working… 2m 0\ds/)).toBeInTheDocument();
      expect(screen.getByTestId("quiet-note")).toHaveTextContent(/No update from Codex for 1m \d\ds/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates the same step when it finishes, with time and output size", async () => {
    await working();
    emit("agent-activity", step());
    emit("agent-activity", step({ state: "done", durationMs: 2100, exitCode: 0, outputLines: 8 }));
    const rows = await screen.findAllByTestId("codex-step");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-state", "done");
    expect(rows[0]).toHaveTextContent("2.1s · 8 lines");
  });

  it("shows a failed command's exit code, and a blocked one as blocked", async () => {
    await working();
    emit("agent-activity", step({ state: "failed", durationMs: 40, exitCode: 2 }));
    emit("agent-activity", step({ itemId: "c2", state: "declined", label: "curl example.com" }));
    const rows = await screen.findAllByTestId("codex-step");
    expect(rows[0]).toHaveTextContent("exit 2");
    expect(rows[0]).toHaveTextContent("40 ms");
    expect(rows[1]).toHaveTextContent("blocked by the sandbox");
  });

  it("keeps steps and replies in the order they happened, and cleans the words", async () => {
    await working();
    emit("agent-chat", { itemId: "m1", text: "Looking." });
    emit("agent-activity", step({ itemId: "f1", kind: "files", state: "done", label: `Created app\u202E.html` }));
    emit("agent-chat", { itemId: "m2", text: "Done." });
    const row = await screen.findByTestId("codex-step");
    expect(row).toHaveTextContent("Created app.html");
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Looking.")).toBeLessThan(text.indexOf("Created app.html"));
    expect(text.indexOf("Created app.html")).toBeLessThan(text.indexOf("Done."));
  });

  it("a step that was cut short does not keep spinning after the turn ends", async () => {
    let finish!: (o: typeof DONE) => void;
    C.agentChatSend.mockReturnValue(new Promise((r) => (finish = r)));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await waitFor(() => expect(handlers["agent-activity"]).toBeDefined());
    emit("agent-activity", step());
    finish({ ...DONE, status: "interrupted" });
    await waitFor(() => expect(screen.getByTestId("codex-step")).toHaveAttribute("data-state", "done"));
  });

  it("cleans hidden characters out of the reply", async () => {
    C.agentChatSend.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "hi{Enter}");
    await waitFor(() => expect(handlers["agent-chat"]).toBeDefined());
    emit("agent-chat", { itemId: "m1", text: "he\u202Ello" });
    expect(await screen.findByText("hello")).toBeInTheDocument();
  });

  it("Enter sends and Shift+Enter adds a line", async () => {
    C.agentChatSend.mockResolvedValue(DONE);
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "one{Shift>}{Enter}{/Shift}two");
    expect(C.agentChatSend).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("one\ntwo");
    await user.type(composer(), "{Enter}");
    expect(C.agentChatSend).toHaveBeenCalledWith("one\ntwo");
  });

  it("Stop interrupts the turn", async () => {
    C.agentChatSend.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(C.agentChatStop).toHaveBeenCalledTimes(1);
  });

  async function withDraft(report = REPORT) {
    C.agentScanDraft.mockResolvedValue(report);
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: DRAFT });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await screen.findByTestId("draft-card");
    return user;
  }

  it("reads the draft after a turn and shows its name, size and what it asks for", async () => {
    await withDraft({ ...REPORT, capabilities: ["camera", { net: ["api.example.com"] }] });
    expect(await screen.findByText("Timer")).toBeInTheDocument();
    expect(screen.getByText("Counts down.")).toBeInTheDocument();
    expect(screen.getByText("app.html, 2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("It would ask to:")).toBeInTheDocument();
    expect(screen.getByText("use your camera")).toBeInTheDocument();
    expect(screen.getByText(/api\.example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/can miss things/)).toBeInTheDocument();
    expect(screen.getByText(/Adding it grants nothing/)).toBeInTheDocument();
    expect(C.agentAddDraft).not.toHaveBeenCalled();
  });

  it("says plainly when the draft asks for nothing", async () => {
    await withDraft();
    expect(await screen.findByText(/does not ask for the network, your devices or storage/)).toBeInTheDocument();
  });

  it("adds it to the library when Add to library is clicked, and says it starts with no access", async () => {
    C.agentAddDraft.mockResolvedValue({ outcome: "added", tool: { id: "t", name: "Timer" } as never, versionNum: 1 });
    const user = await withDraft();
    await user.click(await screen.findByRole("button", { name: "Add to library" }));
    expect(C.agentAddDraft).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Added to your library as "Timer"\. It starts with no access/)).toBeInTheDocument();
  });

  it("offers Save as new version when the session already added the tool", async () => {
    C.agentAddDraft.mockResolvedValue({ outcome: "newVersion", tool: { id: "t", name: "Timer" } as never, versionNum: 2 });
    const user = await withDraft({ ...REPORT, savesAs: "version", toolName: "Timer" });
    expect(screen.queryByRole("button", { name: "Add to library" })).toBeNull();
    expect(screen.getByText(/Adds a version to "Timer"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save as new version" }));
    expect(await screen.findByText(/Saved as version 2 of "Timer"\. Its approvals are unchanged/)).toBeInTheDocument();
  });

  it("says when nothing was added", async () => {
    C.agentAddDraft.mockResolvedValue({ outcome: "alreadyInLibrary", tool: { id: "t", name: "Mine" } as never, versionNum: 1 });
    const user = await withDraft();
    await user.click(await screen.findByRole("button", { name: "Add to library" }));
    expect(await screen.findByText(/already in your library as "Mine", so nothing was added/)).toBeInTheDocument();
  });

  it("says why adding failed, and lets the person try again", async () => {
    C.agentAddDraft.mockRejectedValueOnce(commandError("library", "Could not save\u202E it."));
    const user = await withDraft();
    await user.click(await screen.findByRole("button", { name: "Add to library" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save it.");
    expect(screen.getByRole("button", { name: "Add to library" })).toBeEnabled();
  });

  it("opens the draft in a preview window when Preview is clicked", async () => {
    C.agentPreviewDraft.mockResolvedValue(undefined);
    const user = await withDraft();
    expect(C.agentPreviewDraft).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    expect(C.agentPreviewDraft).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no access to the network, your files or Sanctum/)).toBeInTheDocument();
  });

  it("says why a preview could not open, with hidden characters removed", async () => {
    C.agentPreviewDraft.mockRejectedValue(commandError("policy", "Not\u202E allowed by your organisation."));
    const user = await withDraft();
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not allowed by your organisation.");
    C.agentPreviewDraft.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("still lets the person preview when the scan failed", async () => {
    C.agentScanDraft.mockRejectedValue(commandError("draft_not_text", "app.html is not text."));
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: DRAFT });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByText("app.html is not text.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to library" })).toBeNull();
  });

  it("clears the card when the next message is sent", async () => {
    C.agentAddDraft.mockResolvedValue({ outcome: "added", tool: { id: "t", name: "Timer" } as never, versionNum: 1 });
    const user = await withDraft();
    await user.click(await screen.findByRole("button", { name: "Add to library" }));
    await screen.findByText(/Added to your library/);
    C.agentChatSend.mockReturnValue(new Promise(() => {}));
    await user.type(composer(), "more{Enter}");
    await waitFor(() => expect(screen.queryByTestId("draft-card")).toBeNull());
  });

  it("offers no Preview for a draft that is too large", async () => {
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: { size: 5_000_000, tooLarge: true } });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await screen.findByText(/more than Sanctum accepts/);
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("does not offer a draft that is too large", async () => {
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: { size: 5_000_000, tooLarge: true } });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByText(/more than Sanctum accepts/)).toBeInTheDocument();
    expect(screen.queryByText(/A draft is ready/)).toBeNull();
  });

  it("says when Sanctum refused something Codex asked for", async () => {
    C.agentChatSend.mockResolvedValue({ ...DONE, refused: 2 });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByText(/asked for 2 things outside its work folder/)).toBeInTheDocument();
  });

  it("shows why a turn failed", async () => {
    C.agentChatSend.mockResolvedValue({ ...DONE, status: "failed", error: "usage limit reached" });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("usage limit reached");
  });

  it("offers a new session when the old one is gone", async () => {
    C.agentChatSend.mockRejectedValue(commandError("process", "the agent process stopped"));
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await user.click(await screen.findByRole("button", { name: /Start a new session/ }));
    expect(C.agentChatClose).toHaveBeenCalled();
    await waitFor(() => expect(C.agentChatStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("explains when a session cannot start", async () => {
    C.agentChatStart.mockRejectedValue(commandError("not_signed_in", "Sign in with ChatGPT first."));
    render(<CreateView onBack={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in with ChatGPT first.");
    expect(composer()).toBeDisabled();
  });

  it("ends the session when the view is left", async () => {
    const { unmount } = render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    // An earlier session is closed before the new one starts, never the other way round.
    expect(C.agentChatClose).toHaveBeenCalledTimes(1);
    expect(C.agentChatClose.mock.invocationCallOrder[0]).toBeLessThan(C.agentChatStart.mock.invocationCallOrder[0]);
    unmount();
    expect(C.agentChatClose).toHaveBeenCalledTimes(2);
  });

  it("has no automated accessibility violations", async () => {
    const { container } = render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});

const V = (n: number, current: boolean, extra: Partial<import("@/lib/types").DraftVersion> = {}) => ({
  sha: `sha${n}`, number: n, size: 1024 * n, at: 1_700_000_000 + n, loaded: false, current, name: "Timer", ...extra,
});

describe("the Create view: going back to an earlier draft", () => {
  async function twoDrafts() {
    C.agentScanDraft.mockResolvedValue(REPORT);
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: DRAFT });
    C.agentDraftHistory.mockResolvedValue([V(2, true), V(1, false)]);
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await screen.findByTestId("draft-card");
    return user;
  }

  it("lists every draft of the conversation, newest first, with the current one marked", async () => {
    await twoDrafts();
    const list = await screen.findByTestId("draft-versions");
    expect(list).toHaveTextContent("Drafts in this conversation (2)");
    const rows = list.querySelectorAll("li");
    expect(rows[0]).toHaveTextContent("Draft 2");
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[1]).toHaveTextContent("Draft 1");
    // The draft in front of you is named in the card.
    expect(screen.getByText(/Draft 2, app\.html/)).toBeInTheDocument();
    // The current draft cannot be "gone back to"; an earlier one can.
    expect(screen.queryByRole("button", { name: "Go back to Draft 2" })).toBeNull();
    expect(screen.getByRole("button", { name: "Go back to Draft 1" })).toBeEnabled();
  });

  it("shows no list when there is only one draft", async () => {
    C.agentDraftHistory.mockResolvedValue([V(1, true)]);
    C.agentScanDraft.mockResolvedValue(REPORT);
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: DRAFT });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    await screen.findByTestId("draft-card");
    expect(screen.queryByTestId("draft-versions")).toBeNull();
  });

  it("previews an earlier draft without putting it back", async () => {
    const user = await twoDrafts();
    await user.click(await screen.findByRole("button", { name: "Preview Draft 1" }));
    expect(C.agentPreviewDraft).toHaveBeenCalledWith("sha1");
    expect(C.agentRestoreDraft).not.toHaveBeenCalled();
    // The card's own Preview is still the current file.
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(C.agentPreviewDraft).toHaveBeenLastCalledWith(undefined);
  });

  it("puts an earlier draft back, says so, and reads it again", async () => {
    const user = await twoDrafts();
    C.agentRestoreDraft.mockResolvedValue({ size: 1024, tooLarge: false });
    C.agentDraftHistory.mockResolvedValue([V(2, false), V(1, true)]);
    C.agentScanDraft.mockClear();
    await user.click(await screen.findByRole("button", { name: "Go back to Draft 1" }));
    expect(C.agentRestoreDraft).toHaveBeenCalledWith("sha1");
    expect(await screen.findByText("Went back to draft 1.")).toBeInTheDocument();
    await waitFor(() => expect(C.agentScanDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Draft 1, app\.html, 1\.0 KB/)).toBeInTheDocument());
    // It can be added or saved again, as it is a different file from what was saved before.
    expect(screen.getByRole("button", { name: "Add to library" })).toBeEnabled();
  });

  it("calls the library app's file the starting point", async () => {
    C.agentDraftHistory.mockResolvedValue([V(2, true), V(1, false, { loaded: true })]);
    C.agentScanDraft.mockResolvedValue(REPORT);
    C.agentChatSend.mockResolvedValue({ ...DONE, draft: DRAFT });
    const user = userEvent.setup();
    render(<CreateView onBack={vi.fn()} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "go{Enter}");
    expect(await screen.findByRole("button", { name: "Go back to Starting point" })).toBeInTheDocument();
  });

  it("says why when going back fails", async () => {
    const user = await twoDrafts();
    C.agentRestoreDraft.mockRejectedValue(commandError("busy", "Codex is still working. Stop it first."));
    await user.click(await screen.findByRole("button", { name: "Go back to Draft 1" }));
    expect(await screen.findByText("Codex is still working. Stop it first.")).toBeInTheDocument();
    expect(screen.queryByText(/Went back to/)).toBeNull();
  });
});

describe("the Create view: changing an app from the library", () => {
  const APP_SRC = { kind: "app" as const, title: "Timer", detail: "Version 2, 3 KB.", toolId: "11111111-1111-4111-8111-111111111111" };
  const FROM_APP = { ...STARTED, sources: [APP_SRC, GUIDE_SRC, INS_SRC] };

  it("starts the conversation from the app named in the window's address, and lists it under Sources", async () => {
    C.agentChatStart.mockResolvedValue(FROM_APP);
    render(<CreateView initialSource={APP_SRC.toolId} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(C.agentChatStart).toHaveBeenCalledWith(APP_SRC.toolId);
    const side = screen.getByRole("complementary", { name: "Sources" });
    expect(side).toHaveTextContent("Timer");
    expect(side).toHaveTextContent("You are changing this app.");
    expect(side).toHaveTextContent("Sanctum guide");
    expect(side).toHaveTextContent("Your instructions");
    expect(screen.getByText(/Codex has "Timer" open as app\.html/)).toBeInTheDocument();
  });

  it("shows only the guide and instructions when starting from nothing", async () => {
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    expect(C.agentChatStart).toHaveBeenCalledWith(null);
    expect(screen.queryByTestId("source-app")).toBeNull();
    expect(screen.getByTestId("source-guide")).toBeInTheDocument();
    expect(screen.getByText(/Say what you want, for example/)).toBeInTheDocument();
  });

  it("switches at once to an app asked for while the conversation is still empty", async () => {
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    C.agentChatStart.mockResolvedValue(FROM_APP);
    await waitFor(() => expect(handlers["agent-source"]).toBeDefined());
    emit("agent-source", { toolId: APP_SRC.toolId, name: "Timer" });
    await waitFor(() => expect(C.agentChatStart).toHaveBeenLastCalledWith(APP_SRC.toolId));
    expect(screen.queryByTestId("incoming-source")).toBeNull();
    expect(await screen.findByTestId("source-app")).toBeInTheDocument();
  });

  it("asks before it ends a conversation that has begun, and keeps it if told to", async () => {
    const user = userEvent.setup();
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "make a timer{Enter}");
    await waitFor(() => expect(C.agentChatSend).toHaveBeenCalled());
    await waitFor(() => expect(handlers["agent-source"]).toBeDefined());
    emit("agent-source", { toolId: APP_SRC.toolId, name: "Timer" });
    const ask = await screen.findByTestId("incoming-source");
    expect(ask).toHaveTextContent('Change "Timer" instead?');
    expect(ask).toHaveTextContent("deletes its work folder");
    expect(C.agentChatStart).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Keep this one" }));
    expect(screen.queryByTestId("incoming-source")).toBeNull();
    expect(C.agentChatStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText("make a timer")).toBeInTheDocument();
  });

  it("changes to the other app when told to", async () => {
    const user = userEvent.setup();
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "make a timer{Enter}");
    await waitFor(() => expect(C.agentChatSend).toHaveBeenCalled());
    await waitFor(() => expect(handlers["agent-source"]).toBeDefined());
    C.agentChatStart.mockResolvedValue(FROM_APP);
    emit("agent-source", { toolId: APP_SRC.toolId, name: "Timer" });
    await user.click(await screen.findByRole("button", { name: "Change it instead" }));
    await waitFor(() => expect(C.agentChatStart).toHaveBeenLastCalledWith(APP_SRC.toolId));
    expect(screen.queryByText("make a timer")).toBeNull();
    expect(await screen.findByTestId("source-app")).toBeInTheDocument();
  });

  it("starts the conversation over when the same app is asked for again", async () => {
    C.agentChatStart.mockResolvedValue(FROM_APP);
    const user = userEvent.setup();
    render(<CreateView initialSource={APP_SRC.toolId} />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "bigger buttons{Enter}");
    await waitFor(() => expect(C.agentChatSend).toHaveBeenCalled());
    await waitFor(() => expect(handlers["agent-source"]).toBeDefined());
    emit("agent-source", { toolId: APP_SRC.toolId, name: "Timer" });
    await user.click(await screen.findByRole("button", { name: "Change it instead" }));
    await waitFor(() => expect(C.agentChatStart).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("bigger buttons")).toBeNull();
  });

  it("cleans the name of an app before showing it", async () => {
    const user = userEvent.setup();
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.type(composer(), "hi{Enter}");
    await waitFor(() => expect(handlers["agent-source"]).toBeDefined());
    emit("agent-source", { toolId: APP_SRC.toolId, name: "Ti‮mer​" });
    expect(await screen.findByTestId("incoming-source")).toHaveTextContent('Change "Timer" instead?');
  });
});

describe("the Create view: standing instructions", () => {
  it("lets the person write instructions for every app and saves them", async () => {
    C.agentGetInstructions.mockResolvedValue("");
    C.agentSetInstructions.mockImplementation(async (t: string) => t);
    const user = userEvent.setup();
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Add your instructions" }));
    const box = screen.getByRole("textbox", { name: "Your instructions for every app" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(box, "Save files to Downloads.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(C.agentSetInstructions).toHaveBeenCalledWith("Save files to Downloads.");
    expect(await screen.findByText(/applies to conversations you start from now on/)).toBeInTheDocument();
    expect(screen.getByText(/Sanctum's rules come first and always win/)).toBeInTheDocument();
  });

  it("shows what is saved, and why a save failed", async () => {
    C.agentGetInstructions.mockResolvedValue("Be brief.");
    C.agentSetInstructions.mockRejectedValue(commandError("bad_instructions", "Instructions can be at most 4000 characters."));
    const user = userEvent.setup();
    render(<CreateView />);
    await waitFor(() => expect(composer()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Edit your instructions" }));
    const box = screen.getByRole("textbox", { name: "Your instructions for every app" });
    await waitFor(() => expect(box).toHaveValue("Be brief."));
    await user.type(box, " More.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 4000 characters");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { cleanText } from "@/lib/text";
import type { AgentAccount, AgentCommandError, AgentDownload, AddedDraft, AgentSetup, ChatActivity, ChatDraft, ChatStarted, ChatText, DraftReport, DraftVersion } from "@/lib/types";

/** Event the Rust side emits while Codex downloads (src-tauri/src/agent/commands.rs). */
export const DOWNLOAD_EVENT = "agent-download";

/** Event the Rust side emits with the agent's reply while a turn runs. */
export const CHAT_EVENT = "agent-chat";
/** Event the Rust side emits for each step Codex takes. */
export const ACTIVITY_EVENT = "agent-activity";
/** Event the Rust side sends to the Create window when the person asks to change an app while it is open. */
export const SOURCE_EVENT = "agent-source";
/** Event the Rust side sends to the main window when a draft was added to the library. */
export const LIBRARY_EVENT = "library-changed";

/** Turn whatever a rejected agent command threw into a message that is safe to show. */
export function asAgentError(e: unknown): AgentCommandError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as Partial<AgentCommandError>;
    return { code: String(o.code), message: cleanText(String(o.message)) };
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
  return { code: "unknown", message: cleanText(message) };
}

/** The first-use sentence, or nothing once Codex is on the computer. */
export function downloadNote(setup: AgentSetup): string {
  return setup.installed
    ? ""
    : `The first time, Sanctum downloads Codex (about ${setup.downloadMb} MB) from OpenAI's GitHub releases and checks it before it runs.`;
}

/**
 * What the sign-in controls say. The first time, Codex is not on the computer yet, and the
 * sentence says so before anything happens: nothing is downloaded until the button is clicked.
 */
export function signInNote(setup: AgentSetup): string {
  const first = downloadNote(setup);
  return `${first ? `${first} ` : ""}Then it opens your browser to sign in to ChatGPT. Sanctum never sees your password or sign-in token.`;
}

/** "Downloading Codex… 42%" */
export function downloadLabel(d: AgentDownload | null): string {
  if (!d || d.total <= 0) return "Getting ready…";
  return `Downloading Codex… ${Math.min(100, Math.floor((d.done / d.total) * 100))}%`;
}

/**
 * State and actions for the ChatGPT sign-in, shared by the Welcome panel and Settings.
 *
 * Looking at the setup reads files only. `readAccount` also asks the local Codex process who
 * is signed in, which starts that process (it never downloads), so only a screen the person
 * opened on purpose (Settings) sets it. Nothing here makes a request by itself.
 */
export function useAgent({ readAccount }: { readAccount: boolean }) {
  const [setup, setSetup] = useState<AgentSetup | null>(null);
  const [account, setAccount] = useState<AgentAccount | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [download, setDownload] = useState<AgentDownload | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    Commands.agentSetup()
      .then((s) => {
        if (!live.current) return;
        setSetup(s);
        if (s.supported && s.installed && readAccount) {
          Commands.agentAccount()
            .then((a) => live.current && setAccount(a))
            .catch((e: unknown) => live.current && setError(asAgentError(e).message));
        }
      })
      .catch(() => live.current && setSetup({ supported: false, installed: false, downloadMb: 0 }));
    return () => {
      live.current = false;
    };
  }, [readAccount]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setError(null);
    setDownload(null);
    let stop: (() => void) | undefined;
    try {
      stop = await listen<AgentDownload>(DOWNLOAD_EVENT, (e) => live.current && setDownload(e.payload));
    } catch {
      // Without progress events the download still works; the label just stays general.
    }
    try {
      const a = await Commands.agentSignIn();
      if (live.current) setAccount(a);
    } catch (e) {
      const err = asAgentError(e);
      // Cancelling is the person's own choice, not a failure.
      if (live.current && err.code !== "cancelled") setError(err.message);
    } finally {
      stop?.();
      if (live.current) {
        setSigningIn(false);
        setDownload(null);
        // Codex may be downloaded now.
        Commands.agentSetup()
          .then((s) => live.current && setSetup(s))
          .catch(() => {});
      }
    }
  }, []);

  const cancel = useCallback(() => {
    Commands.agentCancelSignIn().catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    setWorking(true);
    setError(null);
    try {
      const a = await Commands.agentSignOut();
      if (live.current) setAccount(a);
    } catch (e) {
      if (live.current) setError(asAgentError(e).message);
    } finally {
      if (live.current) setWorking(false);
    }
  }, []);

  // Downloading until the last byte has arrived; after that the browser is what is being waited for.
  const downloading = !!setup && !setup.installed && !(download && download.total > 0 && download.done >= download.total);
  const phase: "idle" | "downloading" | "browser" = !signingIn ? "idle" : downloading ? "downloading" : "browser";

  // Still finding out who is signed in: Codex is on the computer and the answer has not come yet.
  const checking = !setup || (readAccount && setup.supported && setup.installed && account === null && error === null);

  return { setup, account, signingIn, phase, download, working, error, checking, signIn, cancel, signOut };
}

/** One line of the conversation: something said, or a step Codex took. */
export type ChatEntry =
  | { kind: "message"; id: string; role: "you" | "codex"; text: string }
  | { kind: "activity"; id: string; activity: ChatActivity; startedAt: number }
  /** Something Sanctum did, not Codex: for example putting an earlier draft back. */
  | { kind: "note"; id: string; text: string };

/**
 * One build session. Opens it on mount (a work folder and a Codex thread, all on this
 * computer), closes it on unmount, and follows the conversation. Nothing is sent to OpenAI
 * until a message is sent. Every piece of reply text is cleaned before it is kept.
 *
 * With `source` (the id of an app in the library) the conversation is about changing that app.
 * A different `source` ends this conversation and starts another.
 */
export function useChat(source: string | null = null) {
  const [state, setState] = useState<"starting" | "ready" | "failed">("starting");
  const [info, setInfo] = useState<ChatStarted | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [running, setRunning] = useState(false);
  // When the turn began and when Codex last said anything, so the screen can show how long it has been quiet.
  const [clock, setClock] = useState<{ startedAt: number; lastUpdate: number } | null>(null);
  const [error, setError] = useState<AgentCommandError | null>(null);
  const [draft, setDraft] = useState<ChatDraft | null>(null);
  const [refused, setRefused] = useState(0);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [report, setReport] = useState<DraftReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [added, setAdded] = useState<AddedDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [restoring, setRestoring] = useState(false);
  const live = useRef(true);
  const seq = useRef(0);
  // Which opening is current, so a slow answer to an old one is dropped.
  const generation = useRef(0);

  const refreshVersions = useCallback(async () => {
    const gen = generation.current;
    try {
      const v = await Commands.agentDraftHistory();
      if (live.current && gen === generation.current) setVersions(v);
    } catch {
      // The list is a convenience; the draft card still works without it.
    }
  }, []);

  const reset = useCallback(() => {
    setEntries([]);
    setDraft(null);
    setRefused(0);
    setPreviewError(null);
    setReport(null);
    setReportError(null);
    setAdded(null);
    setAddError(null);
    setVersions([]);
    setError(null);
  }, []);

  const open = useCallback(async () => {
    const gen = ++generation.current;
    setState("starting");
    setError(null);
    try {
      // An earlier session is closed first, so closing can never land on the new one.
      await Commands.agentChatClose().catch(() => {});
      const started = await Commands.agentChatStart(source);
      if (live.current && gen === generation.current) {
        setInfo(started);
        setState("ready");
        void refreshVersions();
      }
    } catch (e) {
      if (live.current && gen === generation.current) {
        setError(asAgentError(e));
        setState("failed");
      }
    }
  }, [source, refreshVersions]);

  // Opens on mount, and again when the app to change is a different one.
  useEffect(() => {
    live.current = true;
    reset();
    void open();
  }, [open, reset]);

  // Leaving ends the session and deletes its work folder.
  useEffect(() => {
    return () => {
      live.current = false;
      generation.current++;
      Commands.agentChatClose().catch(() => {});
    };
  }, []);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    setRunning(true);
    setClock({ startedAt: Date.now(), lastUpdate: Date.now() });
    setDraft(null);
    setReport(null);
    setReportError(null);
    setAdded(null);
    setAddError(null);
    setEntries((m) => [...m, { kind: "message", id: `you-${seq.current++}`, role: "you", text: t }]);
    const stops: Array<() => void> = [];
    try {
      stops.push(
        await listen<ChatText>(CHAT_EVENT, (e) => {
          if (!live.current) return;
          setClock((c) => (c ? { ...c, lastUpdate: Date.now() } : c));
          const id = `codex-${e.payload.itemId}`;
          const piece = cleanText(e.payload.text);
          setEntries((m) =>
            m.some((x) => x.id === id)
              ? m.map((x) => (x.id === id && x.kind === "message" ? { ...x, text: x.text + piece } : x))
              : [...m, { kind: "message", id, role: "codex", text: piece }],
          );
        }),
      );
      stops.push(
        await listen<ChatActivity>(ACTIVITY_EVENT, (e) => {
          if (!live.current) return;
          setClock((c) => (c ? { ...c, lastUpdate: Date.now() } : c));
          const id = `act-${e.payload.itemId}`;
          // The words come from Codex, so they are cleaned like everything else it sends.
          const activity = { ...e.payload, label: cleanText(e.payload.label) };
          setEntries((m) =>
            m.some((x) => x.id === id)
              ? m.map((x) => (x.id === id && x.kind === "activity" ? { ...x, activity } : x))
              : [...m, { kind: "activity", id, activity, startedAt: Date.now() }],
          );
        }),
      );
    } catch {
      // Without the streams nothing is shown as it happens, but the turn still runs.
    }
    try {
      const o = await Commands.agentChatSend(t);
      if (!live.current) return;
      setDraft(o.draft);
      setRefused(o.refused);
      if (o.draft && !o.draft.tooLarge) {
        // What the draft is and what it asks for, so the person can decide before adding it.
        Commands.agentScanDraft()
          .then((r) => live.current && setReport(r))
          .catch((e: unknown) => live.current && setReportError(asAgentError(e).message));
      }
      if (o.status === "failed") setError({ code: "failed", message: o.error ?? "Codex could not finish." });
      void refreshVersions();
    } catch (e) {
      if (live.current) setError(asAgentError(e));
    } finally {
      stops.forEach((stop) => stop());
      if (live.current) {
        setRunning(false);
        setClock(null);
        // A step still marked as running when the turn is over was cut short (stopped, or the
        // process ended). It must not keep spinning.
        setEntries((m) =>
          m.map((x) => (x.kind === "activity" && x.activity.state === "running" ? { ...x, activity: { ...x.activity, state: "done" } } : x)),
        );
      }
    }
  }, [refreshVersions]);

  const stopTurn = useCallback(() => {
    Commands.agentChatStop().catch(() => {});
  }, []);

  /**
   * Opens the draft in a preview window (an earlier draft, with `sha`). A copy is shown, so later
   * edits by Codex do not change it.
   */
  const preview = useCallback(async (sha?: string) => {
    setPreviewError(null);
    try {
      await Commands.agentPreviewDraft(sha);
    } catch (e) {
      if (live.current) setPreviewError(asAgentError(e).message);
    }
  }, []);

  /** Adds the draft to the library with nothing approved. */
  const add = useCallback(async () => {
    setAdding(true);
    setAddError(null);
    try {
      const a = await Commands.agentAddDraft();
      if (live.current) setAdded(a);
    } catch (e) {
      if (live.current) setAddError(asAgentError(e).message);
    } finally {
      if (live.current) setAdding(false);
    }
  }, []);

  /** Puts an earlier draft back as the current one. Codex is told with the next message. */
  const restore = useCallback(
    async (version: DraftVersion) => {
      setRestoring(true);
      setAddError(null);
      setPreviewError(null);
      try {
        const d = await Commands.agentRestoreDraft(version.sha);
        if (!live.current) return;
        setDraft(d);
        setAdded(null);
        setReport(null);
        setReportError(null);
        const label = version.loaded ? "the starting point" : `draft ${version.number}`;
        setEntries((m) => [...m, { kind: "note", id: `note-${seq.current++}`, text: `Went back to ${label}.` }]);
        Commands.agentScanDraft()
          .then((r) => live.current && setReport(r))
          .catch((e: unknown) => live.current && setReportError(asAgentError(e).message));
        void refreshVersions();
      } catch (e) {
        if (live.current) setAddError(asAgentError(e).message);
      } finally {
        if (live.current) setRestoring(false);
      }
    },
    [refreshVersions],
  );

  /** A fresh session: the old work folder is deleted and the conversation starts over. */
  const restart = useCallback(async () => {
    reset();
    await open();
  }, [open, reset]);

  return { state, info, entries, running, clock, error, draft, refused, previewError, preview, report, reportError, added, adding, addError, add, send, stop: stopTurn, restart, versions, restore, restoring };
}

/**
 * The person's standing instructions for every app. They are written to the rules file of each
 * new conversation, below the rules, so they shape what Codex makes but cannot loosen the sandbox.
 */
export function useInstructions() {
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    Commands.agentGetInstructions()
      .then((t) => live.current && setText(t))
      .catch((e: unknown) => live.current && setError(asAgentError(e).message));
    return () => {
      live.current = false;
    };
  }, []);

  const save = useCallback(async (next: string) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const t = await Commands.agentSetInstructions(next);
      if (live.current) {
        setText(t);
        setSaved(true);
      }
    } catch (e) {
      if (live.current) setError(asAgentError(e).message);
    } finally {
      if (live.current) setSaving(false);
    }
  }, []);

  return { text, saving, saved, error, save };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import { cleanText } from "@/lib/text";
import type { AgentAccount, AgentCommandError, AgentDownload, AgentSetup } from "@/lib/types";

/** Event the Rust side emits while Codex downloads (src-tauri/src/agent/commands.rs). */
export const DOWNLOAD_EVENT = "agent-download";

/** Turn whatever a rejected agent command threw into a message that is safe to show. */
export function asAgentError(e: unknown): AgentCommandError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as Partial<AgentCommandError>;
    return { code: String(o.code), message: cleanText(String(o.message)) };
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
  return { code: "unknown", message: cleanText(message) };
}

/**
 * What the sign-in controls say. The first time, Codex is not on the computer yet, and the
 * sentence says so before anything happens: nothing is downloaded until the button is clicked.
 */
export function signInNote(setup: AgentSetup): string {
  const first = setup.installed
    ? ""
    : `The first time, Sanctum downloads Codex (about ${setup.downloadMb} MB) from OpenAI's GitHub releases and checks it before it runs. `;
  return `${first}Then it opens your browser to sign in to ChatGPT. Sanctum never sees your password or sign-in token.`;
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

  return { setup, account, signingIn, phase, download, working, error, signIn, cancel, signOut };
}

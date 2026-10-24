// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowUp, Ban, Check, CircleAlert, ExternalLink, FilePen, Lightbulb, Loader2, LogIn, RotateCcw, Square, Terminal, Wrench } from "lucide-react";
import { downloadLabel, signInNote, SOURCE_EVENT, useAgent, useChat } from "@/lib/agent";
import { listen } from "@tauri-apps/api/event";
import { cleanSourceRequest } from "@/lib/text";
import { CreateSources } from "@/components/CreateSources";
import { DraftVersions, versionLabel } from "@/components/DraftVersions";
import { capabilityToPlain, formatBytes, type AddedDraft, type ChatActivity, type ChatDraft, type ChatStarted, type DraftReport, type SourceRequest } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { Markdown } from "@/components/catalogue/Markdown";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

const PRIVACY =
  "Your messages and Codex's replies go to OpenAI through your ChatGPT account. Sanctum never sees your sign-in token. " +
  "Codex can write only in a private work folder that is deleted when you close this window, and its commands have no network access.";

const mono = "'Space Mono', ui-monospace, monospace";

/** The same box Codex prints when it starts: its name and version, the model, and where it works. */
function Banner({ info }: { info: ChatStarted }) {
  const row = (label: string, value: string) => (
    <>
      <span style={{ color: "var(--app-mute)" }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{value}</span>
    </>
  );
  return (
    <div
      data-testid="codex-banner"
      style={{
        display: "inline-block", maxWidth: "100%", marginBottom: 14,
        border: "1px solid var(--app-border-2)", borderRadius: 6, padding: "10px 16px 12px",
        fontFamily: mono, fontSize: 12.5, lineHeight: 1.6, color: "var(--app-ink)",
      }}
    >
      <div>
        <span aria-hidden="true" style={{ color: "var(--app-mute)" }}>{">_ "}</span>
        <strong>OpenAI Codex</strong>
        {info.version && <span style={{ color: "var(--app-mute)" }}>{` (v${info.version})`}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 12, marginTop: 8 }}>
        {info.model && row("model:", info.model)}
        {row("directory:", info.directory)}
      </div>
    </div>
  );
}

const ICONS = { command: Terminal, files: FilePen, thinking: Lightbulb, tool: Wrench } as const;

/** Seconds since `since`, ticking while the step runs. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{Math.max(0, Math.floor((now - since) / 1000))}s</>;
}

/** "74s", or "2m 05s" once it is long. */
function span(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}

/** After this long without news, say so: a big file can take minutes, but so can a dead connection. */
const QUIET_AFTER_MS = 45_000;

/** The line shown while Codex works and no step is running: how long, and how long it has been quiet. */
function Waiting({ startedAt, lastUpdate }: { startedAt: number; lastUpdate: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const quiet = now - lastUpdate;
  return (
    <div role="status" style={{ ...note, display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Codex is working… {span(now - startedAt)}
      </span>
      {quiet >= QUIET_AFTER_MS && (
        <span data-testid="quiet-note" style={{ fontSize: 12, marginLeft: 24 }}>
          No update from Codex for {span(quiet)}. It may be writing a large file or waiting on the network. You can stop it and try again.
        </span>
      )}
    </div>
  );
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** One step Codex took, like the lines Codex prints in a terminal. Shows what it did, never its output. */
function Step({ activity: a, startedAt }: { activity: ChatActivity; startedAt: number }) {
  const Icon = ICONS[a.kind];
  const bad = a.state === "failed" || a.state === "declined";
  const meta: string[] = [];
  if (a.durationMs !== null && a.state !== "running") meta.push(seconds(a.durationMs));
  if (a.kind === "command" && a.outputLines && a.state !== "running") meta.push(`${a.outputLines} ${a.outputLines === 1 ? "line" : "lines"}`);
  if (a.state === "failed" && a.exitCode !== null && a.exitCode !== 0) meta.push(`exit ${a.exitCode}`);
  return (
    <div
      data-testid="codex-step"
      data-state={a.state}
      style={{ display: "flex", alignItems: "flex-start", gap: 8, fontFamily: mono, fontSize: 12, lineHeight: 1.5, color: bad ? "var(--danger-ink)" : "var(--app-ink-2)" }}
    >
      <span aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
        {a.state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : bad ? <CircleAlert className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {a.kind === "command" ? <span aria-hidden="true" style={{ color: "var(--app-mute)" }}>{"$ "}</span> : null}
        {a.label}
        <span style={{ color: "var(--app-mute)" }}>
          {a.state === "running" ? <>{" · "}<Elapsed since={startedAt} /></> : null}
          {meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
        </span>
        {a.state === "declined" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
            <Ban className="h-3 w-3" aria-hidden="true" />
            blocked by the sandbox
          </span>
        )}
      </span>
    </div>
  );
}

/** What adding did, in a sentence. Nothing here says the tool is safe. */
function addedSentence(a: AddedDraft): string {
  const name = `"${a.tool.name}"`;
  switch (a.outcome) {
    case "added":
      return `Added to your library as ${name}. It starts with no access: open it in the Tool Vault to see what it asks for and approve only what you want.`;
    case "newVersion":
      return `Saved as version ${a.versionNum} of ${name}. Its approvals are unchanged, so check what the new version asks for.`;
    case "unchanged":
      return `${name} is already up to date with this draft.`;
    case "alreadyInLibrary":
      return `This exact file is already in your library as ${name}, so nothing was added.`;
  }
}

/**
 * The draft, before anything is added: its name, what the scan found it asking for, and the
 * choices. The list comes from a scan of the file. It is a guide, it can miss things, and it
 * grants nothing: an added tool starts with no approvals and runs in the sandbox like any other.
 */
function DraftCard({ chat, draft }: { chat: ReturnType<typeof useChat>; draft: ChatDraft }) {
  const r: DraftReport | null = chat.report;
  const added = chat.added;
  return (
    <div
      data-testid="draft-card"
      style={{ marginTop: 16, maxWidth: "80ch", border: "1px solid var(--app-border)", borderRadius: 8, padding: "14px 16px", fontFamily: font, fontSize: 13, display: "flex", flexDirection: "column", gap: 10 }}
    >
      {!r && !chat.reportError && (
        <span role="status" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Reading the draft…
        </span>
      )}
      {r && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontFamily: "Poppins, system-ui, sans-serif", fontSize: 15 }}>{r.name}</strong>
            <span style={{ ...note, fontSize: 12 }}>
              {`${chat.versions.find((v) => v.current) ? `${versionLabel(chat.versions.find((v) => v.current)!)}, ` : ""}app.html, ${formatBytes(draft.size)}`}
            </span>
          </div>
          {r.description && <p style={{ ...note, margin: 0 }}>{r.description}</p>}
          <div>
            {r.capabilities.length === 0 ? (
              <span>It does not ask for the network, your devices or storage.</span>
            ) : (
              <>
                <span>It would ask to:</span>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {r.capabilities.map((c, i) => (
                    <li key={i}>{capabilityToPlain(c)}</li>
                  ))}
                </ul>
              </>
            )}
            <p style={{ ...note, fontSize: 11.5, margin: "6px 0 0" }}>
              This list comes from scanning the file, so it can miss things. Adding it grants nothing: it starts with no access, and you approve each one yourself.
            </p>
          </div>
        </>
      )}
      {chat.reportError && (
        <span role="alert" style={{ color: "var(--danger-ink)", fontSize: 12 }}>
          {chat.reportError}
        </span>
      )}
      {(r || chat.reportError) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Button variant="outline" size="sm" onClick={() => void chat.preview(undefined)}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </Button>
          {r && (
            <Button variant="volt" size="sm" onClick={() => void chat.add()} disabled={chat.adding}>
              {chat.adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {r.savesAs === "version" ? "Save as new version" : "Add to library"}
            </Button>
          )}
          <span style={{ ...note, fontSize: 12 }}>
            {r?.savesAs === "version" && r.toolName ? `Adds a version to "${r.toolName}". ` : ""}
            Preview opens it with no access to the network, your files or Sanctum.
          </span>
        </div>
      )}
      <DraftVersions
        versions={chat.versions}
        busy={chat.running}
        restoring={chat.restoring}
        onPreview={(sha) => void chat.preview(sha)}
        onRestore={(v) => void chat.restore(v)}
      />
      {added && (
        <p role="status" style={{ margin: 0, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <Check className="h-4 w-4" style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
          <span>{addedSentence(added)}</span>
        </p>
      )}
      {(chat.previewError || chat.addError) && (
        <span role="alert" style={{ fontSize: 12, color: "var(--danger-ink)" }}>
          {chat.addError ?? chat.previewError}
        </span>
      )}
    </div>
  );
}

const note = { margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", lineHeight: 1.5 } as const;

function SignIn({ agent }: { agent: ReturnType<typeof useAgent> }) {
  const setup = agent.setup!;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: "62ch" }}>
      <p style={note}>Sign in with ChatGPT to build an app. {signInNote(setup)}</p>
      {agent.signingIn ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font, fontSize: 13 }}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {agent.phase === "downloading" ? downloadLabel(agent.download) : "Finish signing in in your browser…"}
          </span>
          <Button variant="ghost" size="sm" onClick={agent.cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="outline" onClick={() => void agent.signIn()}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Sign in with ChatGPT
          </Button>
        </div>
      )}
      {agent.error && (
        <div role="alert" style={{ fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
          {agent.error}
        </div>
      )}
    </div>
  );
}

function Chat({
  account,
  source,
  incoming,
  onSwitch,
  onDismiss,
}: {
  account: string;
  /** The app from the library this conversation is about changing, if any. */
  source: string | null;
  /** Another app the person just asked to change. */
  incoming: SourceRequest | null;
  onSwitch: () => void;
  onDismiss: () => void;
}) {
  const chat = useChat(source);
  const [text, setText] = useState("");
  const changing = chat.info?.sources.find((s) => s.kind === "app") ?? null;
  // Nothing to lose yet: go straight to the other app. Otherwise ask.
  const fresh = chat.entries.length === 0 && !chat.draft && !chat.running;
  useEffect(() => {
    if (incoming && fresh && chat.state !== "starting") onSwitch();
  }, [incoming, fresh, chat.state, onSwitch]);
  const switchNow = () => {
    // The same app again starts the conversation over; a different one is picked up by the hook.
    if (incoming && incoming.toolId === source) void chat.restart();
    onSwitch();
  };
  const end = useRef<HTMLDivElement>(null);
  const ready = chat.state === "ready";

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [chat.entries, chat.running]);

  const submit = () => {
    if (!ready || chat.running || !text.trim()) return;
    const t = text;
    setText("");
    void chat.send(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0 }}>
      {incoming && !fresh && (
        <div
          role="alert"
          data-testid="incoming-source"
          style={{ margin: "12px 24px 0", border: "1px solid var(--app-border-2)", borderRadius: 8, padding: "10px 14px", fontFamily: font, fontSize: 13, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <span style={{ flex: 1, minWidth: 200 }}>{`Change "${incoming.name}" instead? This ends the conversation you have open and deletes its work folder.`}</span>
          <Button size="sm" variant="outline" onClick={switchNow} disabled={chat.running}>
            Change it instead
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Keep this one
          </Button>
        </div>
      )}
      <div role="log" aria-label="Conversation" aria-live="polite" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 24px" }}>
        {chat.state === "starting" && (
          <p role="status" style={{ ...note, display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Getting ready…
          </p>
        )}
        {chat.state === "ready" && chat.entries.length === 0 && (
          <>
            {chat.info && <Banner info={chat.info} />}
            {changing ? (
              <p style={{ ...note, maxWidth: "62ch" }}>
                Signed in as {account}. Codex has "{changing.title}" open as app.html. Say what to change, for example: make the
                buttons bigger, or add a button that saves the result to a file. A change you like becomes a new version of the app.
              </p>
            ) : (
              <p style={{ ...note, maxWidth: "62ch" }}>
                Signed in as {account}. Say what you want, for example: a countdown timer that I can start and pause, or a tool that
                turns pasted text into a clean checklist.
              </p>
            )}
          </>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: "80ch" }}>
          {chat.entries.map((m) =>
            m.kind === "activity" ? (
              <Step key={m.id} activity={m.activity} startedAt={m.startedAt} />
            ) : m.kind === "note" ? (
              <p key={m.id} role="status" style={{ ...note, fontSize: 12.5, fontStyle: "italic" }}>
                {m.text}
              </p>
            ) : m.role === "you" ? (
              <div key={m.id} style={{ alignSelf: "flex-end", maxWidth: "85%", background: "var(--app-raised)", border: "1px solid var(--app-border)", borderRadius: 10, padding: "8px 12px", fontFamily: font, fontSize: 13.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {m.text}
              </div>
            ) : (
              <div key={m.id} style={{ fontFamily: font, fontSize: 13.5, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                <Markdown source={m.text} />
              </div>
            ),
          )}
          {chat.running && chat.clock && !chat.entries.some((e) => e.kind === "activity" && e.activity.state === "running") && (
            <Waiting startedAt={chat.clock.startedAt} lastUpdate={chat.clock.lastUpdate} />
          )}
        </div>
        {chat.draft &&
          (chat.draft.tooLarge ? (
            <div role="status" style={{ marginTop: 16, maxWidth: "80ch", border: "1px solid var(--app-border)", borderRadius: 8, padding: "12px 14px", fontFamily: font, fontSize: 13 }}>
              {`Codex made a file of ${formatBytes(chat.draft.size)}, which is more than Sanctum accepts. Ask it to make the tool smaller.`}
            </div>
          ) : (
            <DraftCard chat={chat} draft={chat.draft} />
          ))}
        {chat.refused > 0 && !chat.running && (
          <p style={{ ...note, marginTop: 10, fontSize: 12 }}>
            Codex asked for {chat.refused} {chat.refused === 1 ? "thing" : "things"} outside its work folder. Sanctum refused.
          </p>
        )}
        {chat.error && (
          <div role="alert" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontFamily: font, fontSize: 12.5, color: "var(--danger-ink)" }}>
            <span>{chat.error.message}</span>
            {(chat.state === "failed" || chat.error.code === "no_session" || chat.error.code === "process") && (
              <Button variant="outline" size="sm" onClick={() => void chat.restart()}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Start a new session
              </Button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>

      <div style={{ flexShrink: 0, borderTop: "1px solid var(--app-border)", padding: "12px 24px 14px", background: "var(--app-bg)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", maxWidth: "80ch" }}>
          <textarea
            aria-label="Message to Codex"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={!ready}
            rows={2}
            maxLength={8000}
            placeholder="Describe the app you want"
            style={{ flex: 1, resize: "vertical", minHeight: 44, maxHeight: 200, fontFamily: font, fontSize: 13.5, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--app-border-2)", background: "var(--app-surface)", color: "var(--app-ink)" }}
          />
          {chat.running ? (
            <Button variant="outline" onClick={chat.stop}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button variant="volt" onClick={submit} disabled={!ready || !text.trim()}>
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
              Send
            </Button>
          )}
        </div>
        <p style={{ ...note, fontSize: 11.5, marginTop: 8, maxWidth: "80ch" }}>{PRIVACY}</p>
      </div>
    </div>
    <CreateSources sources={chat.info?.sources ?? []} />
    </div>
  );
}

/**
 * Build an app with Codex: sign in if needed, then chat. It fills the Create window; closing the
 * window ends the session and deletes its work folder.
 */
export function CreateView({ onBack, initialSource }: { onBack?: () => void; initialSource?: string | null }) {
  const agent = useAgent({ readAccount: true });
  // The app to change: from the address of the window when it was opened for one, and from an
  // event when the person asks for another while it is open.
  const [source, setSource] = useState<string | null>(initialSource ?? null);
  const [incoming, setIncoming] = useState<SourceRequest | null>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    listen<SourceRequest>(SOURCE_EVENT, (e) => live && setIncoming(cleanSourceRequest(e.payload)))
      .then((un) => (live ? (stop = un) : un()))
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  const signedIn = !!agent.account?.signedIn;
  // With no conversation open (still signing in) there is nothing to lose.
  useEffect(() => {
    if (incoming && !signedIn) {
      setSource(incoming.toolId);
      setIncoming(null);
    }
  }, [incoming, signedIn]);
  const email = agent.account?.email ?? "ChatGPT";
  const plan = agent.account?.plan ? ` (${agent.account.plan})` : "";

  let body;
  if (!agent.setup || agent.checking) {
    body = (
      <p role="status" style={{ ...note, padding: "16px 24px" }}>
        Checking your sign-in…
      </p>
    );
  } else if (!agent.setup.supported) {
    body = <p style={{ ...note, padding: "16px 24px" }}>Building apps is not available on this kind of computer yet.</p>;
  } else if (!agent.setup.enabled) {
    body = (
      <p role="status" style={{ ...note, padding: "16px 24px" }}>
        Building apps is turned off. To use it, open Settings in the main Sanctum window and turn on Build apps with Codex.
      </p>
    );
  } else if (!agent.account?.signedIn) {
    body = (
      <div style={{ padding: "16px 24px" }}>
        <SignIn agent={agent} />
      </div>
    );
  } else {
    body = (
      <Chat
        account={`${email}${plan}`}
        source={source}
        incoming={incoming}
        onSwitch={() => {
          if (incoming) setSource(incoming.toolId);
          setIncoming(null);
        }}
        onDismiss={() => setIncoming(null)}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-surface)" }}>
      <PageHeader title="Create your own app">
        Describe a tool in plain words. Codex writes it in a private work folder, and nothing is added to your library unless you choose.
      </PageHeader>
      {onBack && (
        <div style={{ padding: "10px 24px 0" }}>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Tool Vault
          </Button>
        </div>
      )}
      {body}
    </div>
  );
}

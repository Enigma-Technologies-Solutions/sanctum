// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Boxes,
  ShieldCheck,
  Fingerprint,
  EyeOff,
  RefreshCw,
  Copy,
  Check,
  Loader2,
  Monitor,
  Sun,
  Moon,
  LogIn,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { Commands } from "@/lib/commands";
import { downloadLabel, signInNote, useAgent } from "@/lib/agent";
import type { PolicyStatus, TrustAnchorInfo, UpdateInfo } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { readTheme, saveTheme, type ThemeChoice } from "@/lib/theme";
import type { RegistryChecks } from "@/lib/notices";
import { ABOUT, HOW_IT_WORKS, LINKS, LINKS_NOTE, type HowItem } from "@/lib/content";

const ICONS: Record<HowItem["icon"], LucideIcon> = {
  origin: Boxes,
  permissions: ShieldCheck,
  hash: Fingerprint,
  privacy: EyeOff,
  update: RefreshCw,
};

const font = "'Inter', system-ui, sans-serif";
const mono = "'Space Mono', ui-monospace, monospace";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ marginBottom: "32px" }}>
      <h2
        id={id}
        style={{
          margin: "0 0 12px",
          fontFamily: mono,
          fontSize: "11px",
          fontWeight: 400,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--app-ink-2)",
        }}
      >
        {title}
      </h2>
      <div style={{ background: "var(--app-bg)", border: "1px solid var(--app-border)", borderRadius: "10px", overflow: "hidden" }}>
        {children}
      </div>
    </section>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "12px 16px",
  fontFamily: font,
  fontSize: "13px",
  color: "var(--app-ink)",
  borderTop: "1px solid var(--app-border)",
} as const;

function Row({ first, children }: { first?: boolean; children: ReactNode }) {
  return <div style={{ ...rowStyle, borderTop: first ? "none" : rowStyle.borderTop }}>{children}</div>;
}

const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 12px",
  background: "var(--app-bg)",
  color: "var(--app-ink)",
  border: "1px solid var(--app-border)",
  borderRadius: "6px",
  fontFamily: font,
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
  flexShrink: 0,
} as const;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" style={buttonStyle} onClick={copy} aria-label={`Copy ${label} link`}>
      {state === "done" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "error"; message: string; info?: UpdateInfo };

function UpdatesSection({ version }: { version: string | null }) {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  const check = useCallback(() => {
    setState({ kind: "checking" });
    Commands.checkForUpdate()
      .then((info) => setState(info ? { kind: "available", info } : { kind: "current" }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  }, []);

  const install = (info: UpdateInfo) => {
    setState({ kind: "installing", info });
    // On success the app restarts, so only the failure path returns.
    Commands.installUpdate().catch((e: unknown) => setState({ kind: "error", message: String(e), info }));
  };

  const busy = state.kind === "checking" || state.kind === "installing";

  let status: ReactNode = null;
  if (state.kind === "checking") status = "Checking…";
  else if (state.kind === "current") status = "Sanctum is up to date.";
  else if (state.kind === "available" || state.kind === "installing")
    status = `Sanctum ${state.info.version} is available.`;
  else if (state.kind === "error") status = `Update check failed: ${state.message.replace(/^update check failed:\s*/i, "")}`;

  const pending = state.kind === "available" ? state.info : state.kind === "error" ? state.info : undefined;

  return (
    <Section id="s-updates" title="Updates">
      <Row first>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>Current version: {version ? <span style={{ fontFamily: mono, fontSize: "12px" }}>{version}</span> : "unknown"}</div>
          {status && (
            <div
              role="status"
              style={{ marginTop: "4px", fontSize: "12px", color: state.kind === "error" ? "var(--danger-ink)" : "var(--app-ink-2)", overflowWrap: "anywhere" }}
            >
              {status}
            </div>
          )}
        </div>
        {pending && (
          <button
            type="button"
           
            onClick={() => install(pending)}
            style={{ ...buttonStyle, background: "var(--app-ink)", color: "var(--on-ink)", borderColor: "var(--app-ink)" }}
          >
            Install and restart
          </button>
        )}
        {state.kind === "installing" && <Loader2 size={14} className="animate-spin" aria-label="Installing" />}
        <button
          type="button"
         
          onClick={check}
          disabled={busy}
          style={{ ...buttonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
        >
          {state.kind === "checking" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          Check for updates
        </button>
      </Row>
      <Row>
        <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>
          Checking contacts the Sanctum releases on GitHub. Updates are checked against a key built into the app and install only when you click.
        </span>
      </Row>
    </Section>
  );
}

const THEMES: { id: ThemeChoice; label: string; Icon: LucideIcon }[] = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
];

function AppearanceSection() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const pick = (c: ThemeChoice) => {
    setChoice(c);
    saveTheme(c);
  };
  return (
    <Section id="s-appearance" title="Appearance">
      <Row first>
        <span id="theme-label" style={{ flex: 1 }}>
          Theme
          <span style={{ display: "block", color: "var(--app-ink-2)", fontSize: "12px", marginTop: "2px" }}>
            System follows your operating system. Tools you open keep their own look.
          </span>
        </span>
        <div role="radiogroup" aria-labelledby="theme-label" style={{ display: "inline-flex", gap: "6px" }}>
          {THEMES.map(({ id, label, Icon }) => {
            const on = choice === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => pick(id)}
                style={{
                  ...buttonStyle,
                  background: on ? "var(--app-ink)" : "var(--app-bg)",
                  color: on ? "var(--on-ink)" : "var(--app-ink)",
                  borderColor: on ? "var(--app-ink)" : "var(--app-border)",
                }}
              >
                <Icon size={13} aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </Row>
    </Section>
  );
}

function AgentSection() {
  const agent = useAgent({ readAccount: true });
  if (agent.setup && !agent.setup.supported) {
    return (
      <Section id="s-agent" title="Agent">
        <Row first>
          <span style={{ color: "var(--app-ink-2)" }}>Building apps is not available on this kind of computer yet.</span>
        </Row>
      </Section>
    );
  }

  if (agent.setup && !agent.setup.enabled) {
    return (
      <Section id="s-agent" title="Build apps with Codex">
        <Row first>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div role="status">Off.</div>
            {agent.error && (
              <div role="alert" style={{ marginTop: "4px", fontSize: "12px", color: "var(--danger-ink)", overflowWrap: "anywhere" }}>
                {agent.error}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void agent.setEnabled(true)}
            disabled={agent.working}
            style={{ ...buttonStyle, opacity: agent.working ? 0.6 : 1, cursor: agent.working ? "default" : "pointer" }}
          >
            Turn on
          </button>
        </Row>
        <Row>
          <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>
            An experiment, off until you turn it on. You describe a tool in plain words and OpenAI's Codex writes it, using your
            ChatGPT account. Turning it on lets Sanctum download Codex to this computer; nothing is downloaded or started until you
            sign in. Your messages and the drafts Codex writes are sent to OpenAI. Sanctum never sees your password or sign-in token.
          </span>
        </Row>
      </Section>
    );
  }

  let status: ReactNode = "Checking…";
  if (agent.signingIn) status = agent.phase === "downloading" ? downloadLabel(agent.download) : "Finish signing in in your browser…";
  else if (agent.setup && !agent.setup.installed) status = "Not signed in.";
  else if (agent.account) {
    status = agent.account.signedIn
      ? `Signed in to ChatGPT as ${agent.account.email ?? "your account"}${agent.account.plan ? ` (${agent.account.plan})` : ""}.`
      : "Not signed in.";
  } else if (agent.error) status = "Could not read the account.";

  return (
    <Section id="s-agent" title="Build apps with Codex">
      <Row first>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div role="status" style={{ overflowWrap: "anywhere" }}>{status}</div>
          {agent.error && (
            <div role="alert" style={{ marginTop: "4px", fontSize: "12px", color: "var(--danger-ink)", overflowWrap: "anywhere" }}>
              {agent.error}
            </div>
          )}
        </div>
        {agent.signingIn && (
          <button type="button" onClick={agent.cancel} style={buttonStyle}>
            Cancel
          </button>
        )}
        {!agent.signingIn && agent.setup && (!agent.setup.installed || (agent.account && !agent.account.signedIn) || (!agent.account && agent.error)) && (
          <button type="button" onClick={() => void agent.signIn()} style={buttonStyle}>
            <LogIn size={13} aria-hidden="true" />
            Sign in with ChatGPT
          </button>
        )}
        {!agent.signingIn && agent.account?.signedIn && (
          <button
            type="button"
            onClick={() => void agent.signOut()}
            disabled={agent.working}
            style={{ ...buttonStyle, opacity: agent.working ? 0.6 : 1, cursor: agent.working ? "default" : "pointer" }}
          >
            {agent.working ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <LogOut size={13} aria-hidden="true" />}
            Sign out
          </button>
        )}
      </Row>
      <Row>
        <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>
          {agent.setup ? signInNote(agent.setup) : null} Codex runs on this computer and starts only when you use it.
          Your messages and the drafts Codex writes are sent to OpenAI. Apps you make can save files to your Downloads folder without asking.
        </span>
      </Row>
      <Row>
        <span style={{ flex: 1, fontSize: "12px", color: "var(--app-ink-2)" }}>
          Turning this off stops Codex and closes any open session. Your sign-in and the downloaded program stay where they are.
        </span>
        <button
          type="button"
          onClick={() => void agent.setEnabled(false)}
          disabled={agent.working || agent.signingIn}
          style={{ ...buttonStyle, opacity: agent.working || agent.signingIn ? 0.6 : 1, cursor: agent.working || agent.signingIn ? "default" : "pointer" }}
        >
          Turn off
        </button>
      </Row>
    </Section>
  );
}

function PolicySection() {
  const [policy, setPolicy] = useState<PolicyStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    Commands.getPolicyStatus().then(setPolicy).catch((e: unknown) => setFailed(String(e)));
  }, []);

  let text: string;
  let isError = false;
  if (failed) {
    text = `Could not read the policy status: ${failed}`;
    isError = true;
  } else if (!policy) {
    text = "Checking…";
  } else if (policy.error) {
    text = `Your organisation's policy could not be applied, so tools are blocked. ${policy.error}`;
    isError = true;
  } else if (!policy.managed) {
    text = "This installation is not managed by an organisation.";
  } else if (policy.pinnedCount !== null) {
    text = `Your organisation limits which tools can run. ${policy.pinnedCount} approved ${policy.pinnedCount === 1 ? "version" : "versions"}. Other tools can be added but will not open.`;
  } else {
    text = "Your organisation manages this installation.";
  }

  return (
    <Section id="s-policy" title="Organisation policy">
      <Row first>
        <span role="status" style={{ color: isError ? "var(--danger-ink)" : "var(--app-ink)", overflowWrap: "anywhere" }}>{text}</span>
      </Row>
    </Section>
  );
}

function TrustSection() {
  const [anchors, setAnchors] = useState<TrustAnchorInfo[] | null>(null);
  useEffect(() => {
    Commands.getTrustAnchors().then(setAnchors).catch(() => setAnchors([]));
  }, []);
  if (anchors === null) return null;

  return (
    <Section id="s-trust" title="Publisher keys">
      {anchors.length === 0 ? (
        <Row first>
          <span style={{ color: "var(--app-ink-2)" }}>This build recognises no publisher keys, so signed tools show as coming from an unknown publisher.</span>
        </Row>
      ) : (
        anchors.map((a, i) => (
          <Row key={a.keyId} first={i === 0}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{a.name}</div>
              <div style={{ fontFamily: mono, fontSize: "11px", color: "var(--app-ink-2)", overflowWrap: "anywhere", userSelect: "text" }}>{a.keyId}</div>
            </div>
            <CopyButton text={a.keyId} label={`${a.name} key`} />
          </Row>
        ))
      )}
      <Row>
        <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>
          A tool signed under one of these keys shows a verified publisher. That names who published it. It never approves anything.
        </span>
      </Row>
    </Section>
  );
}


/** The optional timer and the manual check for the registries the user added. */
function RegistryChecksSection({ checks }: { checks: RegistryChecks }) {
  const last = checks.lastChecked ? new Date(checks.lastChecked).toLocaleString() : null;
  return (
    <Section id="s-registries" title="Registries">
      <Row first>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>Check for updates and withdrawn tools</div>
          <div role="status" style={{ marginTop: "4px", fontSize: "12px", color: checks.problem ? "var(--danger-ink)" : "var(--app-ink-2)" }}>
            {checks.checking ? "Checking…" : (checks.problem ?? (last ? `Last checked ${last}.` : "Not checked yet."))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void checks.checkNow()}
          disabled={checks.checking}
          style={{ ...buttonStyle, opacity: checks.checking ? 0.6 : 1, cursor: checks.checking ? "default" : "pointer" }}
        >
          {checks.checking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          Check now
        </button>
      </Row>
      <Row>
        <label style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={checks.auto}
            onChange={(e) => checks.setAuto(e.target.checked)}
          />
          <span>
            Check once a day while Sanctum is open
            <span style={{ display: "block", color: "var(--app-ink-2)", fontSize: "12px", marginTop: "2px" }}>
              Off by default. Turning it on lets Sanctum contact the registries you added about once a day. It sends no
              identifier and installs nothing.
            </span>
          </span>
        </label>
      </Row>
      <Row>
        <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>
          A registry built into Sanctum can stop a withdrawn version from opening. A registry you pinned can only warn you. Neither one
          changes what a tool is approved to do.
        </span>
      </Row>
    </Section>
  );
}

export function SettingsView({ version, registryChecks }: { version: string | null; registryChecks?: RegistryChecks }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader title="Settings">Appearance, registries, updates, publisher keys and how Sanctum works.</PageHeader>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--app-surface)" }}>
      <div style={{ maxWidth: "720px", margin: "0 auto", padding: "24px 24px 48px" }}>
        <AppearanceSection />
        {registryChecks && <RegistryChecksSection checks={registryChecks} />}

        <Section id="s-about" title="About">
          <Row first>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "Poppins, system-ui, sans-serif", fontWeight: 600, fontSize: "15px" }}>{ABOUT.name}</div>
              <div style={{ marginTop: "2px", color: "var(--app-ink-2)" }}>{ABOUT.summary}</div>
            </div>
          </Row>
          <Row>
            <span style={{ width: "96px", color: "var(--app-ink-2)" }}>Version</span>
            <span style={{ fontFamily: mono, fontSize: "12px" }}>{version ?? "unknown"}</span>
          </Row>
          <Row>
            <span style={{ width: "96px", color: "var(--app-ink-2)" }}>Licence</span>
            <span style={{ fontFamily: mono, fontSize: "12px" }}>{ABOUT.licence}</span>
          </Row>
          <Row>
            <span style={{ width: "96px", color: "var(--app-ink-2)" }}>Publisher</span>
            <span>{ABOUT.publisher}</span>
          </Row>
        </Section>

        <Section id="s-how" title="How it works">
          {HOW_IT_WORKS.map((item, i) => {
            const Icon = ICONS[item.icon];
            return (
              <Row key={item.text} first={i === 0}>
                <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, color: "var(--app-ink)" }} />
                <span>{item.text}</span>
              </Row>
            );
          })}
        </Section>

        <UpdatesSection version={version} />
        <AgentSection />
        <PolicySection />
        <TrustSection />

        <Section id="s-links" title="Links">
          {LINKS.map((l, i) => (
            <Row key={l.url} first={i === 0}>
              <span style={{ width: "120px", flexShrink: 0, color: "var(--app-ink-2)" }}>{l.label}</span>
              <span style={{ flex: 1, minWidth: 0, fontFamily: mono, fontSize: "11px", overflowWrap: "anywhere", userSelect: "text" }}>{l.url}</span>
              <CopyButton text={l.url} label={l.label} />
            </Row>
          ))}
          <Row>
            <span style={{ fontSize: "12px", color: "var(--app-ink-2)" }}>{LINKS_NOTE}</span>
          </Row>
        </Section>
      </div>
      </div>
    </div>
  );
}

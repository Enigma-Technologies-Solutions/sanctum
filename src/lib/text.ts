// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type {
  AgentAccount,
  ChatOutcome,
  AddedDraft,
  ChatStarted,
  DraftReport,
  DraftVersion,
  SourceRequest,
  RegistryAppDetail,
  RegistryCatalogue,
  RegistryCheckReport,
  RegistryNotices,
  RegistrySummary,
} from "@/lib/types";

/**
 * Text that comes from a registry is signed, but the signer can be anyone the user pinned.
 * Characters that change how text is drawn (right-to-left overrides, zero-width characters,
 * control codes) can make one name look like another or hide part of it, so they are removed
 * before anything is shown. Line feeds and tabs stay, for the manual and descriptions.
 */
const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

export function cleanText(s: string): string {
  return s.replace(HIDDEN, "");
}

/** The agent's account text comes from Codex, so it is cleaned like registry text. */
export function cleanAccount(a: AgentAccount): AgentAccount {
  return { ...a, email: a.email === null ? null : cleanText(a.email), plan: a.plan === null ? null : cleanText(a.plan) };
}

/** The page's own title and description come from the agent, so they are cleaned like its replies. */
export function cleanReport(r: DraftReport): DraftReport {
  return { ...r, name: cleanText(r.name), description: cleanText(r.description), toolName: opt(r.toolName) };
}

export function cleanAdded(a: AddedDraft): AddedDraft {
  return { ...a, tool: { ...a.tool, name: cleanText(a.tool.name) } };
}

/** The model and version names come from Codex, so they are cleaned like registry text. */
export function cleanStarted(c: ChatStarted): ChatStarted {
  return {
    model: opt(c.model),
    version: opt(c.version),
    directory: cleanText(c.directory),
    // The title of a library app is text somebody else wrote.
    sources: c.sources.map((s) => ({ ...s, title: cleanText(s.title), detail: cleanText(s.detail) })),
  };
}

export function cleanVersions(v: DraftVersion[]): DraftVersion[] {
  return v.map((e) => ({ ...e, name: cleanText(e.name) }));
}

export function cleanSourceRequest(r: SourceRequest): SourceRequest {
  return { ...r, name: cleanText(r.name) };
}

/** How a turn ended: its error text comes from Codex, so it is cleaned like registry text. */
export function cleanOutcome(o: ChatOutcome): ChatOutcome {
  return { ...o, error: o.error === null ? null : cleanText(o.error) };
}

const opt = (s: string | null): string | null => (s === null ? null : cleanText(s));

export function cleanRegistry(r: RegistrySummary): RegistrySummary {
  return { ...r, name: cleanText(r.name), publisher: cleanText(r.publisher) };
}

export function cleanCatalogue(c: RegistryCatalogue): RegistryCatalogue {
  return {
    ...c,
    registryName: cleanText(c.registryName),
    apps: c.apps.map((a) => ({
      ...a,
      name: cleanText(a.name),
      summary: cleanText(a.summary),
      publisherName: cleanText(a.publisherName),
    })),
  };
}

export function cleanDetail(d: RegistryAppDetail): RegistryAppDetail {
  return {
    ...d,
    name: cleanText(d.name),
    description: cleanText(d.description),
    license: opt(d.license),
    manual: opt(d.manual),
    changelog: d.changelog.map((e) => ({
      ...e,
      changes: e.changes.map((c) => ({ ...c, text: cleanText(c.text) })),
    })),
    screenshots: d.screenshots.map((s) => ({ ...s, alt: cleanText(s.alt) })),
  };
}

/** Names and reasons in a notice come from a registry, so they are cleaned like its catalogue. */
export function cleanNotices(n: RegistryNotices): RegistryNotices {
  return {
    updates: n.updates.map((u) => ({
      ...u,
      registryName: cleanText(u.registryName),
      name: cleanText(u.name),
      installedVersion: cleanText(u.installedVersion),
      latest: cleanText(u.latest),
    })),
    revoked: n.revoked.map((r) => ({
      ...r,
      registryName: cleanText(r.registryName),
      name: cleanText(r.name),
      version: cleanText(r.version),
      reason: cleanText(r.reason),
    })),
  };
}

export function cleanCheckReport(r: RegistryCheckReport): RegistryCheckReport {
  return {
    notices: cleanNotices(r.notices),
    items: r.items.map((i) => ({
      ...i,
      registryName: cleanText(i.registryName),
      ...(i.state === "failed" ? { message: cleanText(i.message) } : {}),
    })) as RegistryCheckReport["items"],
  };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type {
  RegistryAppDetail,
  RegistryCatalogue,
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

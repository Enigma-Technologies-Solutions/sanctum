// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type {
  DetectedCapability,
  RegistryCatalogApp,
  RegistryCatalogVersion,
  RegistryCommandError,
  RegistrySummary,
} from "./types";

/** The Enigma registry. Its signing key chains to a root compiled into Sanctum. */
/** Event the Rust side emits when a sanctum:// link arrives (src-tauri/src/deeplink.rs). */
export const LINK_EVENT = "registry-link";

export const ENIGMA_REGISTRY_URL = "https://sanctum.enigma.sh/registry/v1/";

/** What the interface says wherever a registry or an install is shown. */
export const REGISTRY_MEANING =
  "A registry lists tools. Installing one adds it with no access at all; you approve each " +
  "permission yourself afterwards. A signature says who published a tool and that it is unchanged. " +
  "It does not mean the tool is safe.";

/** Turn whatever a rejected command threw into the error shape the interface understands. */
export function asRegistryError(e: unknown): RegistryCommandError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const o = e as Partial<RegistryCommandError>;
    return {
      code: String(o.code),
      message: String(o.message),
      signer: o.signer ?? null,
      registryId: o.registryId ?? null,
      registryName: o.registryName ?? null,
    };
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Something went wrong.";
  return { code: "unknown", message, signer: null, registryId: null, registryName: null };
}

/** A short next step for errors where one helps. */
export function errorHint(code: string): string | null {
  switch (code) {
    case "fetch_failed":
      return "Check your connection and the address, then try again. Nothing was changed.";
    case "insecure_url":
      return "Registries must use an address that starts with https://.";
    case "invalid_url":
      return "Enter the full address of the registry, starting with https://.";
    case "bad_signature":
    case "hash_mismatch":
    case "size_mismatch":
      return "The registry's files do not match their signatures, so Sanctum refused them. Nothing was changed.";
    case "rollback":
    case "serial_replay":
      return "The registry went backwards, which can mean someone is serving an old copy. Nothing was changed.";
    default:
      return null;
  }
}

export function trustLabel(r: RegistrySummary): string {
  return r.trust === "pinned" ? "Key pinned by you" : `Verified: ${r.publisher}`;
}

export function shortKey(key: string): string {
  return key.length > 24 ? `${key.slice(0, 16)}…${key.slice(-6)}` : key;
}

export function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function latestVersion(app: RegistryCatalogApp): RegistryCatalogVersion | undefined {
  return app.versions.find((v) => v.version === app.latest);
}

/** The declared capabilities of an app's latest version. */
export function latestScope(app: RegistryCatalogApp): DetectedCapability[] {
  return latestVersion(app)?.declared ?? [];
}

/** Whether the main action for an app is available, and why not if it is not. */
export type AppAction =
  | { kind: "install"; label: string }
  | { kind: "update"; label: string }
  | { kind: "none"; label: string; reason: string };

export function actionFor(app: RegistryCatalogApp): AppAction {
  if (app.state === "licensed") {
    return {
      kind: "none",
      label: "Not available yet",
      reason: "This is a licensed app. This version of Sanctum lists licensed apps but cannot install them.",
    };
  }
  if (app.latestRevoked) {
    return {
      kind: "none",
      label: "Withdrawn",
      reason: "The registry withdrew this version, so it will not be installed.",
    };
  }
  if (app.state === "installed") {
    return { kind: "none", label: "Installed", reason: `Version ${app.installedVersion ?? app.latest} is installed.` };
  }
  if (app.state === "updateAvailable") return { kind: "update", label: `Update to ${app.latest}` };
  return { kind: "install", label: "Install" };
}

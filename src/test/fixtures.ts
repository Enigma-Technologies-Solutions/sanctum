// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type {
  RegistryAppDetail,
  RegistryCatalogApp,
  RegistryCatalogue,
  RegistrySummary,
} from "@/lib/types";

export const SIGNER = "ed25519:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";

export function registry(over: Partial<RegistrySummary> = {}): RegistrySummary {
  return {
    id: "registry:sh.enigma.public",
    name: "Enigma Technologies Solutions",
    kind: "public",
    baseUrl: "https://sanctum.enigma.sh/registry/v1/",
    trust: "anchored",
    publisher: "Enigma Technologies Solutions",
    signer: "ed25519:2daedA0n4NSI2p2McCqLBfGiKRmR5XCm8lypbQTT6hg",
    appCount: 2,
    serial: 7,
    issuedAt: 1_790_000_000,
    expires: 4_000_000_000,
    stale: false,
    revocations: { serial: 3, expires: 4_000_000_000, stale: false },
    addedAt: 1_790_000_100,
    lastCheckedAt: 1_790_000_200,
    lastError: null,
    ...over,
  };
}

export function app(over: Partial<RegistryCatalogApp> = {}): RegistryCatalogApp {
  return {
    appId: "sh.enigma.otp-vault",
    name: "OTP Vault",
    summary: "Time-based one-time codes kept in Sanctum storage.",
    publisherKey: "ed25519:2daedA0n4NSI2p2McCqLBfGiKRmR5XCm8lypbQTT6hg",
    publisherName: "Enigma Technologies Solutions",
    latest: "1.0.2",
    versions: [
      { version: "1.0.2", publishedAt: 1_790_000_000, declared: ["storage", { smartcard: ["a0000005272101"] }], size: 78787, revoked: false },
    ],
    installedVersion: null,
    state: "notInstalled",
    latestRevoked: false,
    ...over,
  };
}

export const shamir = (over: Partial<RegistryCatalogApp> = {}) =>
  app({
    appId: "sh.enigma.shamir",
    name: "Shamir Secret Sharing",
    summary: "Split a secret into shares and combine them back.",
    versions: [{ version: "1.0.2", publishedAt: 1_790_000_000, declared: [], size: 95000, revoked: false }],
    ...over,
  });

export function catalogue(apps: RegistryCatalogApp[], over: Partial<RegistryCatalogue> = {}): RegistryCatalogue {
  return {
    registryId: "registry:sh.enigma.public",
    registryName: "Enigma Technologies Solutions",
    stale: false,
    revocationsStale: false,
    apps,
    ...over,
  };
}

export function detail(over: Partial<RegistryAppDetail> = {}): RegistryAppDetail {
  return {
    appId: "sh.enigma.otp-vault",
    name: "OTP Vault",
    description: "A two-factor code generator in a single file.",
    homepage: "https://sanctum.enigma.sh/apps/sh.enigma.otp-vault/",
    source: "https://github.com/Enigma-Technologies-Solutions/sanctum",
    license: "AGPL-3.0-only",
    changelog: [
      { version: "1.0.2", date: "2026-10-02", changes: [{ type: "added", text: "First release signed by Enigma." }] },
    ],
    manual: "## Create a vault\n\nChoose a username and press **Create vault**.\n\n- one\n- two\n",
    manualError: null,
    screenshots: [],
    icon: null,
    iconError: null,
    ...over,
  };
}

/** What a rejected command throws: the serialised CommandError. */
export function commandError(code: string, message: string, extra: Record<string, string | null> = {}) {
  return { code, message, signer: null, registryId: null, registryName: null, ...extra };
}

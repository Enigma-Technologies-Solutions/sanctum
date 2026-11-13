// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

// Copy for the Settings screen. Keep it consistent with README.md, SECURITY.md and
// web/index.html. Every line here must describe something the app does today.

export const ABOUT = {
  name: "Sanctum",
  summary: "A desktop app for running single-file HTML tools, including ones an AI model wrote.",
  licence: "AGPL-3.0-only",
  publisher: "Enigma Technologies Solutions",
} as const;

export type HowItem = { icon: "origin" | "permissions" | "hash" | "privacy" | "update"; text: string };

export const HOW_IT_WORKS: HowItem[] = [
  { icon: "origin", text: "Every tool runs on its own origin, so two tools can never read each other's storage." },
  { icon: "permissions", text: "Tools start with no permissions. You approve each one." },
  { icon: "hash", text: "Each time you open a tool, Sanctum hashes the stored file again. A tool that has changed is quarantined and does not run." },
  { icon: "privacy", text: "There is no account and no telemetry." },
  {
    icon: "update",
    text: "The only requests Sanctum makes by itself are an update check against its GitHub releases and, if you turn it on in Settings, a daily check of your registries.",
  },
];

export const LINKS: { label: string; url: string }[] = [
  { label: "Website", url: "https://sanctum.enigma.sh" },
  { label: "Source code", url: "https://github.com/Enigma-Technologies-Solutions/sanctum" },
  { label: "Security policy", url: "https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/SECURITY.md" },
  { label: "README", url: "https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/README.md" },
];

export const LINKS_NOTE = "Sanctum does not open links itself. Copy one into your browser.";

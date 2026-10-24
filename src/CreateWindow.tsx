// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { CreateView } from "@/components/CreateView";

/** The Create window's whole content (opened by the Create your own app card). */
export function CreateWindow() {
  // Opened to change an app from the library: its id is in the address.
  const source = new URLSearchParams(window.location.search).get("source");
  return (
    <div style={{ height: "100vh", background: "var(--app-bg)", overflow: "hidden" }}>
      <CreateView initialSource={source} />
    </div>
  );
}

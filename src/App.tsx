// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Library } from "@/components/Library";
import { UpdateBanner } from "@/components/UpdateBanner";
import { AppHeader, type View } from "@/components/AppHeader";
import { SettingsView } from "@/components/settings/SettingsView";
import { TooltipProvider } from "@/components/ui/tooltip";

function App() {
  const [view, setView] = useState<View>("vault");
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#FFFFFF", overflow: "hidden" }}>
        <AppHeader view={view} onNavigate={setView} version={version} />
        <UpdateBanner />
        <main style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Both screens stay mounted so the Library keeps its inspect view and scroll position. */}
          <div hidden={view !== "vault"} style={{ height: "100%", display: view === "vault" ? "block" : "none" }}>
            <Library />
          </div>
          <div hidden={view !== "settings"} style={{ height: "100%", display: view === "settings" ? "block" : "none" }}>
            <SettingsView version={version} />
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}

export default App;

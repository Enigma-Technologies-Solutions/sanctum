// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { Commands } from "@/lib/commands";
import type { LinkEvent } from "@/lib/types";
import { LINK_EVENT } from "@/lib/registry";
import { LinkInstallDialog } from "@/components/catalogue/LinkInstallDialog";
import { Library } from "@/components/Library";
import { UpdateBanner } from "@/components/UpdateBanner";
import { RegistryNoticeBanner } from "@/components/RegistryNoticeBanner";
import { useRegistryChecks } from "@/lib/notices";
import { AppHeader, type View } from "@/components/AppHeader";
import { SettingsView } from "@/components/settings/SettingsView";
import { CatalogueView } from "@/components/catalogue/CatalogueView";
import { TooltipProvider } from "@/components/ui/tooltip";

function App() {
  const [view, setView] = useState<View>("vault");
  const [version, setVersion] = useState<string | null>(null);
  // Bumped when something was installed from a registry, so the Tool Vault reloads.
  const [libraryKey, setLibraryKey] = useState(0);

  // A sanctum:// link that is waiting for the user's confirmation, and a key that remounts the
  // Catalogue after the link flow added a registry or installed something.
  const [link, setLink] = useState<LinkEvent | null>(null);
  const [catalogueKey, setCatalogueKey] = useState(0);
  const checks = useRegistryChecks(libraryKey);

  useEffect(() => {
    // The event only says "a link arrived". The link itself is read from Rust, once, so a link
    // is shown one time and a reload of the window never shows it again.
    const take = () =>
      Commands.takePendingLink()
        .then((e) => {
          if (e) {
            setLink(e);
            setView("catalogue");
          }
        })
        .catch(() => {});
    void take();
    let off: (() => void) | undefined;
    let gone = false;
    listen(LINK_EVENT, () => void take())
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--app-bg)", overflow: "hidden" }}>
        <AppHeader view={view} onNavigate={setView} version={version} />
        <UpdateBanner />
        <RegistryNoticeBanner notices={checks.notices} onOpenCatalogue={() => setView("catalogue")} />
        <main style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Both screens stay mounted so the Library keeps its inspect view and scroll position. */}
          <div hidden={view !== "vault"} style={{ height: "100%", display: view === "vault" ? "block" : "none" }}>
            <Library
              refreshKey={libraryKey}
              onOpenCatalogue={() => {
                // The welcome step may have just added a registry: reload the Catalogue to show it.
                setCatalogueKey((k) => k + 1);
                setView("catalogue");
              }}
            />
          </div>
          <div hidden={view !== "catalogue"} style={{ height: "100%", display: view === "catalogue" ? "block" : "none" }}>
            <CatalogueView key={catalogueKey} onLibraryChanged={() => setLibraryKey((k) => k + 1)} onOpenVault={() => setView("vault")} />
          </div>
          <div hidden={view !== "settings"} style={{ height: "100%", display: view === "settings" ? "block" : "none" }}>
            <SettingsView version={version} registryChecks={checks} />
          </div>
        </main>
        {link && (
          // A new link replaces an older one that was never confirmed.
          <LinkInstallDialog
            key={JSON.stringify(link)}
            event={link}
            onChanged={() => {
              setLibraryKey((k) => k + 1);
              setCatalogueKey((k) => k + 1);
            }}
            onOpenVault={() => setView("vault")}
            onClose={() => setLink(null)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

export default App;

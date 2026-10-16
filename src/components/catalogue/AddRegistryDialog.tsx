// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, type FormEvent } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import { Commands } from "@/lib/commands";
import { asRegistryError, errorHint, shortKey } from "@/lib/registry";
import type { RegistryCommandError, RegistrySummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const font = "'Inter', system-ui, sans-serif";
const mono = "'Space Mono', ui-monospace, monospace";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (registry: RegistrySummary) => void;
  /** Fill the address field. The user still presses Add. */
  initialUrl?: string;
}

type Unknown = { signer: string; registryName: string };

/**
 * Add a registry by address. A registry signed by a key Sanctum compiles in is accepted. One
 * signed by any other key is refused until the user has seen that key and chosen to trust it:
 * the dialog shows it and asks, and only then sends it back as a pin.
 */
export function AddRegistryDialog({ open, onOpenChange, onAdded, initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RegistryCommandError | null>(null);
  const [unknown, setUnknown] = useState<Unknown | null>(null);
  const [trusted, setTrusted] = useState(false);

  const reset = () => {
    setBusy(false);
    setError(null);
    setUnknown(null);
    setTrusted(false);
  };

  const submit = async (pin?: string) => {
    setBusy(true);
    setError(null);
    try {
      const added = await Commands.addRegistry(url.trim(), pin);
      reset();
      setUrl("");
      onAdded(added);
      onOpenChange(false);
    } catch (e) {
      const err = asRegistryError(e);
      setBusy(false);
      if (err.code === "untrusted_signer" && err.signer && !pin) {
        setUnknown({ signer: err.signer, registryName: err.registryName ?? "This registry" });
      } else {
        setUnknown(null);
        setTrusted(false);
        setError(err);
      }
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && url.trim()) void submit();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogTitle style={{ fontFamily: "Poppins, system-ui, sans-serif", fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>
          Add a registry
        </DialogTitle>
        <DialogDescription style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", margin: "0 0 16px" }}>
          A registry is a list of tools. Sanctum contacts the address once to read it. Nothing is
          installed until you choose it.
        </DialogDescription>

        {!unknown && (
          <form onSubmit={onSubmit}>
            <label htmlFor="registry-url" style={{ display: "block", fontFamily: font, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Registry address
            </label>
            <input
              id="registry-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/registry/v1/"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-describedby={error ? "registry-url-error" : undefined}
              aria-invalid={error ? true : undefined}
              style={{ width: "100%", padding: "8px 10px", border: "1px solid var(--app-border)", borderRadius: 6, fontFamily: mono, fontSize: 12 }}
            />
            {error && (
              <div id="registry-url-error" role="alert" style={{ marginTop: 10, fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
                <div>{error.message}</div>
                {errorHint(error.code) && <div style={{ marginTop: 4, color: "var(--app-ink-2)" }}>{errorHint(error.code)}</div>}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !url.trim()} aria-busy={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {busy ? "Checking…" : "Add registry"}
              </Button>
            </div>
          </form>
        )}

        {unknown && (
          <div role="group" aria-labelledby="unknown-signer-title">
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <ShieldQuestion size={20} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <div id="unknown-signer-title" style={{ fontFamily: font, fontWeight: 600, fontSize: 14 }}>
                  Sanctum does not recognise who signed “{unknown.registryName}”
                </div>
                <p style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", margin: "6px 0 10px" }}>
                  It is signed by a key that is not one of Sanctum's own. The signature proves the list
                  is unchanged and comes from whoever holds this key. It does not tell you who that is.
                </p>
              </div>
            </div>
            <div style={{ fontFamily: font, fontSize: 11, fontWeight: 600, color: "var(--app-ink-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Signing key
            </div>
            <code
              data-testid="signer-key"
              style={{ display: "block", margin: "4px 0 12px", padding: "8px 10px", background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 6, fontFamily: mono, fontSize: 12, wordBreak: "break-all" }}
            >
              {unknown.signer}
            </code>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontFamily: font, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={trusted}
                onChange={(e) => setTrusted(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I got this key ({shortKey(unknown.signer)}) from someone I trust, and I want to trust
                this registry's tools to come from it.
              </span>
            </label>
            {error && (
              <div role="alert" style={{ marginTop: 10, fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
                {error.message}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!trusted || busy} aria-busy={busy} onClick={() => void submit(unknown.signer)}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Add and trust this key
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

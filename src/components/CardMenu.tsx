// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";

/**
 * Overflow menu for the less common card actions. Small, dependency free:
 * opens upward from the trigger, closes on Escape, outside click or selection,
 * arrow keys move between items, and focus returns to the trigger.
 */
export function CardMenu({
  toolName,
  onUpdate,
  onDelete,
}: {
  toolName: string;
  onUpdate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { setOpen(false); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        aria-label={`More actions for ${toolName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={
          "card-icon-btn " + (open ? "bg-app-raised text-app-ink" : "")
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${toolName} actions`}
          className="absolute bottom-full right-0 z-30 mb-1.5 w-44 rounded-lg border border-app-border bg-white p-1 shadow-[0_8px_24px_rgba(16,24,40,.12),0_2px_6px_rgba(16,24,40,.06)]"
        >
          <button role="menuitem" type="button" onClick={pick(onUpdate)} className="card-menu-item">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Update…
          </button>
          <div role="separator" className="my-1 h-px bg-app-border" />
          <button role="menuitem" type="button" onClick={pick(onDelete)} className="card-menu-item card-menu-item-danger">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Delete…
          </button>
        </div>
      )}
    </div>
  );
}

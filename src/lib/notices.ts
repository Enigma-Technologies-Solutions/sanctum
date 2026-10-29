// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

// Updates and withdrawn tools, from the registries the user added.
//
// Registries are contacted when the user clicks "Check now" or, only if the user turned it
// on, once a day while Sanctum is open. The timer is off until then. The choice is a display
// and behaviour preference for this window, kept in its localStorage like the theme.

import { useCallback, useEffect, useRef, useState } from "react";
import { Commands } from "@/lib/commands";
import { asRegistryError } from "@/lib/registry";
import type { RegistryCheckReport, RegistryNotices } from "@/lib/types";

export const AUTO_KEY = "sanctum.registryAutoCheck";
export const LAST_KEY = "sanctum.registryLastCheck";
/** How long after a check the timer checks again. */
export const EVERY_MS = 24 * 60 * 60 * 1000;
/** How often an open window asks whether a check is due. Asking costs nothing. */
const POLL_MS = 15 * 60 * 1000;

export const NO_NOTICES: RegistryNotices = { updates: [], revoked: [] };

export function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) === "on";
  } catch {
    return false;
  }
}

export function saveAuto(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO_KEY, "on");
    else localStorage.removeItem(AUTO_KEY);
  } catch {
    /* the choice still applies until the window closes */
  }
}

export function readLast(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function saveLast(ms: number): void {
  try {
    localStorage.setItem(LAST_KEY, String(ms));
  } catch {
    /* the next start checks again, which is the safe direction */
  }
}

/** A check is due when there has been none, or the last one was a day ago (or in the future). */
export function isDue(last: number | null, now: number, every = EVERY_MS): boolean {
  return last === null || last > now || now - last >= every;
}

/** A line for people about how a check went, or null when every registry answered. */
export function failureSummary(r: RegistryCheckReport): string | null {
  const failed = r.items.filter((i) => i.state === "failed");
  if (failed.length === 0) return null;
  const names = failed.map((i) => i.registryName).join(", ");
  return failed.length === r.items.length
    ? "Could not reach any registry. The saved lists are still in use."
    : `Could not reach ${names}. The saved list is still in use.`;
}

export interface RegistryChecks {
  notices: RegistryNotices;
  checking: boolean;
  /** Set after a check that could not reach some or all registries. */
  problem: string | null;
  lastChecked: number | null;
  auto: boolean;
  setAuto(on: boolean): void;
  checkNow(): Promise<void>;
}

/** Owns the notices for the window. `reloadKey` changes when the library changed. */
export function useRegistryChecks(reloadKey = 0): RegistryChecks {
  const [notices, setNotices] = useState<RegistryNotices>(NO_NOTICES);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lastChecked, setLast] = useState<number | null>(readLast);
  const [auto, setAutoState] = useState<boolean>(readAuto);
  const busy = useRef(false);

  // The cache is read on start and whenever the library changes. No network.
  useEffect(() => {
    let live = true;
    Commands.registryNotices()
      .then((n) => live && setNotices(n))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const checkNow = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      const report = await Commands.checkRegistries();
      setNotices(report.notices);
      setProblem(failureSummary(report));
      const now = Date.now();
      saveLast(now);
      setLast(now);
    } catch (e) {
      setProblem(asRegistryError(e).message);
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, []);

  const setAuto = useCallback((on: boolean) => {
    saveAuto(on);
    setAutoState(on);
  }, []);

  useEffect(() => {
    if (!auto) return;
    const tick = () => {
      if (isDue(readLast(), Date.now())) void checkNow();
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [auto, checkNow]);

  return { notices, checking, problem, lastChecked, auto, setAuto, checkNow };
}

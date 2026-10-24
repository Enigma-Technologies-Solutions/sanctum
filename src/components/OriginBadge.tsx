// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { PencilRuler } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** What the badge says. Where the file came from, not whether it can be trusted. */
export const AGENT_ORIGIN_MEANING =
  "Written by an AI agent from your instructions. Nobody has reviewed or signed it, and it has no access until you approve it.";

/**
 * Icon-only mark next to a tool name when an AI agent wrote the tool in Sanctum. Like the
 * publisher mark, the text shows on hover and on keyboard focus. It is not a mark of trust.
 */
export function OriginBadge({ origin }: { origin?: string | null }) {
  if (origin !== "agent") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="origin-badge"
          aria-label={`Made with Codex. ${AGENT_ORIGIN_MEANING}`}
          className={
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none text-app-ink-3 " +
            "hover:bg-app-raised focus-visible:ring-2 focus-visible:ring-app-ink focus-visible:ring-offset-1"
          }
        >
          <PencilRuler className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[280px] px-3 py-2 leading-snug">
        <div className="font-semibold">Made with Codex</div>
        <div className="mt-1 text-[var(--on-ink)] opacity-70">{AGENT_ORIGIN_MEANING}</div>
      </TooltipContent>
    </Tooltip>
  );
}

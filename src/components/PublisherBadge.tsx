// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { BadgeCheck, ShieldQuestion } from "lucide-react";
import { type ProvenanceRecord, SIGNATURE_MEANING } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Icon-only publisher mark shown next to a tool name. Only tools installed from a signed
 * bundle have one. The full text appears on hover and on keyboard focus (Radix tooltip:
 * portalled so the card cannot clip it, Escape dismisses it). Verified means the signer is
 * a key Sanctum trusts to name publishers. It never means safe and grants no permission.
 */
export function PublisherBadge({ provenance }: { provenance: ProvenanceRecord | null }) {
  if (!provenance) return null;
  const verified = provenance.trust === "verified";
  const who = provenance.publisherName ?? provenance.publisherKey.slice(0, 16) + "…";
  const heading = verified ? `Verified publisher: ${who}` : "Unknown publisher";
  const detail = verified
    ? null
    : `Signed by a key Sanctum does not recognise (${provenance.publisherKey.slice(0, 16)}…).`;
  const Icon = verified ? BadgeCheck : ShieldQuestion;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${heading}. ${detail ?? ""} ${SIGNATURE_MEANING}`.replace(/\s+/g, " ")}
          className={
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none " +
            "focus-visible:ring-2 focus-visible:ring-app-ink focus-visible:ring-offset-1 " +
            (verified ? "text-ok hover:bg-ok/10" : "text-app-ink-3 hover:bg-app-raised")
          }
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[280px] px-3 py-2 leading-snug">
        <div className="font-semibold">{heading}</div>
        {detail && <div className="mt-0.5 text-white/80">{detail}</div>}
        <div className="mt-1 text-white/70">{SIGNATURE_MEANING}</div>
      </TooltipContent>
    </Tooltip>
  );
}

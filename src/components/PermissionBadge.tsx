// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import {
  type DetectedCapability,
  capabilityToPlain,
  type CapabilityFeature,
} from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Short labels for compact display
const ABBREV: Record<CapabilityFeature, string> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  usb: "USB",
  serial: "Serial",
  hid: "HID",
  bluetooth: "Bluetooth",
  storage: "Storage",
};

interface PermissionBadgeProps {
  detected: DetectedCapability[];
  mode?: "compact" | "expanded";
}

// Volt permission pill — black ink on volt, Inter, 8px radius
function VoltPill({ label, tooltip }: { label: string; tooltip?: string }) {
  const pill = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: "#FBFF00",
        color: "#0A0A0A",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontWeight: 600,
        fontSize: "11px",
        padding: "3px 8px",
        borderRadius: "6px",
        lineHeight: 1.4,
        cursor: tooltip ? "default" : undefined,
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );

  if (!tooltip) return pill;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent className="max-w-[220px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// "No special access" — success-tinted soft pill
function NoAccessBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        background: "rgba(30,158,98,.10)",
        color: "#137A4B",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontWeight: 500,
        fontSize: "11px",
        padding: "3px 8px",
        borderRadius: "6px",
        lineHeight: 1.4,
      }}
    >
      <span style={{
        width: "6px", height: "6px", borderRadius: "50%",
        background: "#1E9E62", flexShrink: 0,
      }} />
      No special access
    </span>
  );
}

export function PermissionBadge({ detected, mode = "compact" }: PermissionBadgeProps) {
  if (detected.length === 0) return <NoAccessBadge />;

  if (mode === "compact") {
    const MAX = 2;
    const visible = detected.slice(0, MAX);
    const overflow = detected.length - MAX;
    return (
      <div className="flex flex-wrap gap-1">
        {visible.map((cap, i) => {
          const label =
            typeof cap === "string"
              ? (ABBREV[cap as CapabilityFeature] ?? cap)
              : `Net: ${cap.net.slice(0, 1).join("")}`;
          return <VoltPill key={i} label={label} tooltip={capabilityToPlain(cap)} />;
        })}
        {overflow > 0 && (
          <VoltPill
            label={`+${overflow} more`}
            tooltip={detected.slice(MAX).map(capabilityToPlain).join("\n")}
          />
        )}
      </div>
    );
  }

  // Expanded
  return (
    <div className="flex flex-wrap gap-1.5">
      {detected.map((cap, i) => {
        const label =
          typeof cap === "string"
            ? (ABBREV[cap as CapabilityFeature] ?? cap)
            : "Network";
        return <VoltPill key={i} label={label} tooltip={capabilityToPlain(cap)} />;
      })}
    </div>
  );
}

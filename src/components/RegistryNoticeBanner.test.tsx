// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegistryNoticeBanner } from "./RegistryNoticeBanner";
import type { RegistryNotices, RegistryRevokedNotice } from "@/lib/types";

const revoked = (action: "block" | "warn"): RegistryRevokedNotice => ({
  toolId: "t1",
  name: "Shamir",
  appId: "sh.enigma.shamir",
  version: "1.0.0",
  reason: "key leak <b>bold</b>",
  registryId: "r",
  registryName: "Enigma Registry",
  action,
});

const none: RegistryNotices = { updates: [], revoked: [] };

describe("notices from the registries", () => {
  it("shows nothing when there is nothing to say", () => {
    const { container } = render(<RegistryNoticeBanner notices={none} onOpenCatalogue={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says a blocked tool will not open", () => {
    render(<RegistryNoticeBanner notices={{ ...none, revoked: [revoked("block")] }} onOpenCatalogue={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Enigma Registry withdrew Shamir 1.0.0");
    expect(screen.getByRole("alert")).toHaveTextContent("will not open");
  });

  it("says a pinned registry only warns, and shows its words as plain text", () => {
    render(<RegistryNoticeBanner notices={{ ...none, revoked: [revoked("warn")] }} onOpenCatalogue={() => {}} />);
    const a = screen.getByRole("alert");
    expect(a).toHaveTextContent("still opens");
    expect(a).toHaveTextContent("<b>bold</b>");
    expect(a.querySelector("b")).toBeNull();
  });

  it("lists updates and opens the Catalogue on request", async () => {
    const open = vi.fn();
    render(
      <RegistryNoticeBanner
        notices={{
          ...none,
          updates: [
            { registryId: "r", registryName: "E", appId: "a", name: "OTP vault", installedVersion: "1.0.0", latest: "1.1.0" },
          ],
        }}
        onOpenCatalogue={open}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("OTP vault 1.1.0");
    await userEvent.click(screen.getByRole("button", { name: "Open Catalogue" }));
    expect(open).toHaveBeenCalledOnce();
  });
});

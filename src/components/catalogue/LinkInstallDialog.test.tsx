// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Commands } from "@/lib/commands";
import { ENIGMA_REGISTRY_URL } from "@/lib/registry";
import type { LinkEvent } from "@/lib/types";
import { app, catalogue, commandError, registry, SIGNER, shamir } from "@/test/fixtures";
import { LinkInstallDialog } from "./LinkInstallDialog";

vi.mock("@/lib/commands", () => ({
  Commands: {
    listRegistries: vi.fn(),
    addRegistry: vi.fn(),
    refreshRegistry: vi.fn(),
    registryCatalogue: vi.fn(),
    installFromRegistry: vi.fn(),
  },
}));

const C = vi.mocked(Commands);

const link = (appId = "sh.enigma.otp-vault", registryUrl = ENIGMA_REGISTRY_URL, isEnigma = true): LinkEvent => ({
  kind: "install",
  request: { appId, registryUrl, isEnigma },
});

function show(event: LinkEvent) {
  const onChanged = vi.fn();
  const onOpenVault = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <TooltipProvider>
      <LinkInstallDialog event={event} onChanged={onChanged} onOpenVault={onOpenVault} onClose={onClose} armDelayMs={0} />
    </TooltipProvider>,
  );
  return { user, onChanged, onOpenVault, onClose, ...utils };
}

/** Every command that can reach the network or change anything. */
const NETWORK_OR_WRITE = () =>
  [C.addRegistry, C.refreshRegistry, C.installFromRegistry].reduce((n, f) => n + f.mock.calls.length, 0);

const withApps = (apps = [app(), shamir()]) => {
  C.listRegistries.mockResolvedValue([registry()]);
  C.registryCatalogue.mockResolvedValue(catalogue(apps));
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("a link that was refused", () => {
  it("says so in plain words and does nothing", async () => {
    const { user, onClose } = show({ kind: "refused", code: "wrong_scheme", message: "This is not a Sanctum link." });
    expect(await screen.findByRole("heading", { name: /did not open this link/i })).toBeInTheDocument();
    expect(screen.getByText(/This is not a Sanctum link\. Nothing was changed\./)).toBeInTheDocument();
    expect(C.listRegistries).not.toHaveBeenCalled();
    expect(NETWORK_OR_WRITE()).toBe(0);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("a link for a registry that is already added", () => {
  it("shows the app and what it asks for first, and installs nothing until clicked", async () => {
    withApps();
    show(link());
    expect(await screen.findByRole("heading", { name: "Install OTP Vault?" })).toBeInTheDocument();
    expect(screen.getByText(/came from a link outside Sanctum/i)).toBeInTheDocument();
    expect(screen.getByText("Asks for")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText(/no access at all/i)).toBeInTheDocument();
    expect(screen.getByText(/does not mean the tool is safe/i)).toBeInTheDocument();
    // only local reads so far
    expect(C.registryCatalogue).toHaveBeenCalledWith("registry:sh.enigma.public");
    expect(NETWORK_OR_WRITE()).toBe(0);
  });

  it("installs only after the click, with that registry and that app", async () => {
    withApps();
    C.installFromRegistry.mockResolvedValue({ state: "installed", notes: [], install: { tool: { name: "OTP Vault" }, warnings: [] } } as never);
    const { user, onChanged, onOpenVault, onClose } = show(link());
    await user.click(await screen.findByRole("button", { name: "Install" }));
    expect(C.installFromRegistry).toHaveBeenCalledTimes(1);
    expect(C.installFromRegistry).toHaveBeenCalledWith("registry:sh.enigma.public", "sh.enigma.otp-vault");
    expect(await screen.findByRole("heading", { name: "Installed OTP Vault" })).toBeInTheDocument();
    expect(screen.getByText(/It has no access yet/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Tool Vault" }));
    expect(onOpenVault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Cancel closes without installing", async () => {
    withApps();
    const { user, onClose } = show(link());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(NETWORK_OR_WRITE()).toBe(0);
  });

  it("a different app in the link is not confused with the one next to it", async () => {
    withApps();
    show(link("sh.enigma.shamir"));
    expect(await screen.findByRole("heading", { name: "Install Shamir Secret Sharing?" })).toBeInTheDocument();
    expect(screen.queryByText("OTP Vault")).toBeNull();
  });

  it("an app that is already installed offers no install button", async () => {
    withApps([app({ state: "installed", installedVersion: "1.0.2" })]);
    show(link());
    expect(await screen.findByText(/Version 1\.0\.2 is installed\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("an update is offered as an update", async () => {
    withApps([app({ state: "updateAvailable", installedVersion: "1.0.1" })]);
    show(link());
    expect(await screen.findByRole("heading", { name: "Update OTP Vault?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update to 1.0.2" })).toBeInTheDocument();
  });

  it("a withdrawn or licensed app cannot be installed from a link", async () => {
    withApps([app({ latestRevoked: true })]);
    const { unmount } = show(link());
    expect(await screen.findByText(/withdrew this version/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    unmount();
    withApps([app({ state: "licensed" })]);
    show(link());
    expect(await screen.findByText(/licensed app/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("an app the catalogue does not list asks before making any request", async () => {
    withApps([shamir()]);
    const { user } = show(link("sh.enigma.otp-vault"));
    expect(await screen.findByRole("heading", { name: /not in this catalogue/i })).toBeInTheDocument();
    expect(NETWORK_OR_WRITE()).toBe(0);
    C.refreshRegistry.mockResolvedValue({} as never);
    C.registryCatalogue.mockResolvedValue(catalogue([app(), shamir()]));
    await user.click(screen.getByRole("button", { name: "Check the registry again" }));
    expect(C.refreshRegistry).toHaveBeenCalledWith("registry:sh.enigma.public");
    expect(await screen.findByRole("heading", { name: "Install OTP Vault?" })).toBeInTheDocument();
    expect(C.installFromRegistry).not.toHaveBeenCalled();
  });

  it("shows an install failure and offers to try again without repeating it on its own", async () => {
    withApps();
    C.installFromRegistry.mockRejectedValueOnce(commandError("hash_mismatch", "The bundle does not match the signed catalogue."));
    const { user } = show(link());
    await user.click(await screen.findByRole("button", { name: "Install" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match the signed catalogue");
    expect(C.installFromRegistry).toHaveBeenCalledTimes(1);
    C.installFromRegistry.mockResolvedValue({ state: "alreadyInstalled", version: "1.0.2" });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(C.installFromRegistry).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/already installed/i)).toBeInTheDocument();
  });
});

describe("a link for the Enigma registry when it is not added", () => {
  beforeEach(() => {
    C.listRegistries.mockResolvedValue([]);
  });

  it("asks first, and makes no request on arrival", async () => {
    show(link());
    expect(await screen.findByRole("heading", { name: "Add the Enigma registry?" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is installed yet/i)).toBeInTheDocument();
    expect(NETWORK_OR_WRITE()).toBe(0);
  });

  it("adds it on the click, shows the app, and still needs a second click to install", async () => {
    C.addRegistry.mockResolvedValue(registry());
    C.registryCatalogue.mockResolvedValue(catalogue([app(), shamir()]));
    const { user, onChanged } = show(link());
    await user.click(await screen.findByRole("button", { name: "Add the Enigma registry" }));
    expect(C.addRegistry).toHaveBeenCalledWith(ENIGMA_REGISTRY_URL);
    expect(await screen.findByRole("heading", { name: "Install OTP Vault?" })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(C.installFromRegistry).not.toHaveBeenCalled();
  });

  it("a failed add is explained and can be retried", async () => {
    C.addRegistry.mockRejectedValueOnce(commandError("network", "Could not reach the registry."));
    const { user } = show(link());
    await user.click(await screen.findByRole("button", { name: "Add the Enigma registry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the registry.");
    C.addRegistry.mockResolvedValue(registry());
    C.registryCatalogue.mockResolvedValue(catalogue([app()]));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Install OTP Vault?" })).toBeInTheDocument();
  });
});

describe("a link for a registry Sanctum does not know", () => {
  const other = "https://tools.example.com/registry/v1/";
  beforeEach(() => {
    C.listRegistries.mockResolvedValue([]);
  });

  it("shows the whole address, never adds it by itself, and says to trust the source", async () => {
    show(link("com.example.tool", other, false));
    expect(await screen.findByRole("heading", { name: /registry you have not used before/i })).toBeInTheDocument();
    expect(screen.getByTestId("link-registry-url")).toHaveTextContent(other);
    expect(screen.getByText(/only continue if you know and trust/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add the Enigma registry" })).toBeNull();
    expect(NETWORK_OR_WRITE()).toBe(0);
  });

  it("goes through the normal add dialog, with the address filled in but not sent", async () => {
    const { user } = show(link("com.example.tool", other, false));
    await user.click(await screen.findByRole("button", { name: "Review and add…" }));
    expect(await screen.findByLabelText("Registry address")).toHaveValue(other);
    expect(C.addRegistry).not.toHaveBeenCalled();
  });

  it("an unknown signer still has to be seen and trusted, as for any added registry", async () => {
    C.addRegistry.mockRejectedValueOnce(commandError("untrusted_signer", "unknown", { signer: SIGNER, registryName: "Example Tools" }));
    const { user } = show(link("com.example.tool", other, false));
    await user.click(await screen.findByRole("button", { name: "Review and add…" }));
    await user.click(await screen.findByRole("button", { name: "Add registry" }));
    expect(await screen.findByTestId("signer-key")).toHaveTextContent(SIGNER);
    expect(screen.getByRole("button", { name: /add and trust this key/i })).toBeDisabled();
    expect(C.installFromRegistry).not.toHaveBeenCalled();
  });

  it("a registry added earlier under the same address skips straight to the app", async () => {
    C.listRegistries.mockResolvedValue([registry({ id: "registry:com.example.tools", name: "Example Tools", baseUrl: other })]);
    C.registryCatalogue.mockResolvedValue(catalogue([app({ appId: "com.example.tool", name: "Example Tool" })], { registryId: "registry:com.example.tools" }));
    show(link("com.example.tool", other, false));
    expect(await screen.findByRole("heading", { name: "Install Example Tool?" })).toBeInTheDocument();
  });

  it("a registry with a similar address is not treated as the same one", async () => {
    C.listRegistries.mockResolvedValue([registry({ baseUrl: "https://tools.example.com.evil.example/registry/v1/" })]);
    show(link("com.example.tool", other, false));
    expect(await screen.findByRole("heading", { name: /registry you have not used before/i })).toBeInTheDocument();
    expect(C.registryCatalogue).not.toHaveBeenCalled();
  });
});

describe("the dialog", () => {
  it("has no automated accessibility violations in its main states", async () => {
    withApps();
    const { unmount } = show(link());
    await screen.findByRole("heading", { name: "Install OTP Vault?" });
    let r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
    unmount();
    show({ kind: "refused", code: "x", message: "This is not a Sanctum link." });
    await screen.findByRole("heading", { name: /did not open/i });
    r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("cannot be dismissed while an install is running", async () => {
    withApps();
    let finish: (v: never) => void = () => {};
    C.installFromRegistry.mockReturnValue(new Promise((res) => (finish = res as never)));
    const { user, onClose } = show(link());
    await user.click(await screen.findByRole("button", { name: "Install" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish({ state: "alreadyInstalled", version: "1.0.2" } as never);
    await waitFor(() => expect(screen.getByRole("heading", { name: /already installed/i })).toBeInTheDocument());
  });
});

describe("a dialog that was just swapped in", () => {
  it("cannot be confirmed until it has been on screen for a moment", async () => {
    withApps();
    render(
      <TooltipProvider>
        <LinkInstallDialog event={link()} onChanged={vi.fn()} onOpenVault={vi.fn()} onClose={vi.fn()} armDelayMs={300} />
      </TooltipProvider>,
    );
    const install = await screen.findByRole("button", { name: "Install" });
    expect(install).toBeDisabled();
    await waitFor(() => expect(install).toBeEnabled(), { timeout: 2000 });
    expect(NETWORK_OR_WRITE()).toBe(0);
  });
});

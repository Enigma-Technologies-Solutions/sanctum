// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Commands } from "@/lib/commands";
import { ENIGMA_REGISTRY_URL } from "@/lib/registry";
import { app, catalogue, commandError, detail, registry, SIGNER, shamir } from "@/test/fixtures";
import { CatalogueView } from "./CatalogueView";

vi.mock("@/lib/commands", () => ({
  Commands: {
    listRegistries: vi.fn(),
    addRegistry: vi.fn(),
    refreshRegistry: vi.fn(),
    removeRegistry: vi.fn(),
    registryCatalogue: vi.fn(),
    registryAppDetail: vi.fn(),
    installFromRegistry: vi.fn(),
    installAllFromRegistry: vi.fn(),
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));

const C = vi.mocked(Commands);

function show(props: Partial<{ onLibraryChanged: () => void; onOpenVault: () => void }> = {}) {
  const onLibraryChanged = props.onLibraryChanged ?? vi.fn();
  const onOpenVault = props.onOpenVault ?? vi.fn();
  const user = userEvent.setup();
  const utils = render(
    <TooltipProvider>
      <CatalogueView onLibraryChanged={onLibraryChanged} onOpenVault={onOpenVault} />
    </TooltipProvider>,
  );
  return { user, onLibraryChanged, onOpenVault, ...utils };
}

/** Accessibility violations axe can find in jsdom. Colour contrast needs a real renderer. */
async function violations(node: Element = document.body) {
  const result = await axe.run(node, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const withApps = (apps = [app(), shamir()], reg = registry()) => {
  C.listRegistries.mockResolvedValue([reg]);
  C.registryCatalogue.mockResolvedValue(catalogue(apps));
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("with no registry", () => {
  beforeEach(() => {
    C.listRegistries.mockResolvedValue([]);
  });

  it("offers the Enigma registry with one click, and says what it is for", async () => {
    show();
    expect(await screen.findByRole("heading", { name: "No registry yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add the Enigma registry" })).toBeInTheDocument();
    expect(screen.getByText(/nothing runs with access until you\s+approve it/i)).toBeInTheDocument();
  });

  it("adds exactly the Enigma address, with no pinned key, then shows the catalogue and installs nothing", async () => {
    C.addRegistry.mockResolvedValue(registry());
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add the Enigma registry" }));
    expect(C.addRegistry).toHaveBeenCalledTimes(1);
    expect(C.addRegistry).toHaveBeenCalledWith(ENIGMA_REGISTRY_URL);
    expect(ENIGMA_REGISTRY_URL).toBe("https://sanctum.enigma.sh/registry/v1/");
    expect(await screen.findByText(/Added Enigma Technologies Solutions\. Nothing is installed yet\./)).toBeInTheDocument();
    expect(C.installFromRegistry).not.toHaveBeenCalled();
    expect(C.installAllFromRegistry).not.toHaveBeenCalled();
  });

  it("explains a failure and offers a next step, without leaving the screen empty-handed", async () => {
    C.addRegistry.mockRejectedValue(commandError("fetch_failed", "could not connect: dns error"));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add the Enigma registry" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not connect: dns error");
    expect(alert).toHaveTextContent(/check your connection/i);
    expect(screen.getByRole("button", { name: "Add the Enigma registry" })).toBeEnabled();
  });

  it("has no accessibility violations", async () => {
    show();
    await screen.findByRole("heading", { name: "No registry yet" });
    expect(await violations()).toEqual([]);
  });
});

describe("adding another registry", () => {
  beforeEach(() => {
    C.listRegistries.mockResolvedValue([]);
  });

  it("sends the address as typed, without a pin", async () => {
    C.addRegistry.mockResolvedValue(registry({ id: "registry:x.y", name: "Acme" }));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add another registry" }));
    await user.type(screen.getByLabelText("Registry address"), "https://acme.test/registry/");
    await user.click(screen.getByRole("button", { name: "Add registry" }));
    expect(C.addRegistry).toHaveBeenCalledWith("https://acme.test/registry/", undefined);
  });

  it("refuses to submit an empty address", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add another registry" }));
    expect(screen.getByRole("button", { name: "Add registry" })).toBeDisabled();
    expect(C.addRegistry).not.toHaveBeenCalled();
  });

  it("shows why an address was refused", async () => {
    C.addRegistry.mockRejectedValue(commandError("insecure_url", "registries must be reached over https"));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add another registry" }));
    await user.type(screen.getByLabelText("Registry address"), "http://acme.test/");
    await user.click(screen.getByRole("button", { name: "Add registry" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("registries must be reached over https");
    expect(alert).toHaveTextContent(/starts with https/);
    expect(screen.getByLabelText("Registry address")).toHaveAttribute("aria-invalid", "true");
  });

  describe("a registry signed by a key Sanctum does not know", () => {
    const unknown = commandError("untrusted_signer", "signed by a key Sanctum does not know", {
      signer: SIGNER,
      registryId: "registry:acme.public",
      registryName: "Acme Tools",
    });

    async function openPrompt() {
      C.addRegistry.mockRejectedValueOnce(unknown);
      const view = show();
      await view.user.click(await screen.findByRole("button", { name: "Add another registry" }));
      await view.user.type(screen.getByLabelText("Registry address"), "https://acme.test/registry/");
      await view.user.click(screen.getByRole("button", { name: "Add registry" }));
      await screen.findByText(/does not recognise who signed/);
      return view;
    }

    it("shows the whole key and does not add anything yet", async () => {
      await openPrompt();
      expect(screen.getByTestId("signer-key")).toHaveTextContent(SIGNER);
      expect(C.addRegistry).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Add and trust this key" })).toBeDisabled();
    });

    it("pins the key only after the user confirms it, and sends exactly that key", async () => {
      const { user } = await openPrompt();
      C.addRegistry.mockResolvedValueOnce(registry({ id: "registry:acme.public", name: "Acme Tools", trust: "pinned" }));
      await user.click(screen.getByRole("checkbox"));
      await user.click(screen.getByRole("button", { name: "Add and trust this key" }));
      expect(C.addRegistry).toHaveBeenCalledTimes(2);
      expect(C.addRegistry).toHaveBeenLastCalledWith("https://acme.test/registry/", SIGNER);
    });

    it("cancelling pins nothing and sends nothing more", async () => {
      const { user } = await openPrompt();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(C.addRegistry).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByText(/does not recognise who signed/)).not.toBeInTheDocument());
    });

    it("has no accessibility violations", async () => {
      await openPrompt();
      expect(await violations()).toEqual([]);
    });
  });

  it("the plain dialog has no accessibility violations", async () => {
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Add another registry" }));
    await screen.findByLabelText("Registry address");
    expect(await violations()).toEqual([]);
  });
});

describe("the catalogue", () => {
  it("shows what each app asks for before anything is installed", async () => {
    withApps();
    show();
    const otp = await screen.findByRole("article", { name: /OTP Vault/ });
    expect(within(otp).getByText("Asks for")).toBeInTheDocument();
    expect(within(otp).getByText("Storage")).toBeInTheDocument();
    expect(within(otp).getByText("Smart card")).toBeInTheDocument();
    expect(within(otp).getByRole("button", { name: "Install OTP Vault" })).toBeEnabled();
    const sss = screen.getByRole("article", { name: /Shamir/ });
    expect(within(sss).getByText("No special access")).toBeInTheDocument();
    expect(C.installFromRegistry).not.toHaveBeenCalled();
  });

  it("states who vouches for the registry, and what that does not mean", async () => {
    withApps();
    show();
    expect(await screen.findByText("Verified: Enigma Technologies Solutions")).toBeInTheDocument();
    expect(screen.getByText(/It does not mean the tool is safe/)).toBeInTheDocument();
    expect(screen.getByText(/Installing one adds it with no access at all/)).toBeInTheDocument();
  });

  it("says a pinned registry is a key the user chose, not a verified publisher", async () => {
    withApps([app()], registry({ trust: "pinned", publisher: "Key pinned by you" }));
    show();
    expect(await screen.findByText("Key pinned by you")).toBeInTheDocument();
    expect(screen.queryByText(/^Verified:/)).not.toBeInTheDocument();
  });

  it("describes each state in words and offers only the actions that can work", async () => {
    withApps([
      app({ appId: "a.new", name: "Fresh", state: "notInstalled" }),
      app({ appId: "a.cur", name: "Current", state: "installed", installedVersion: "1.0.2" }),
      app({ appId: "a.upd", name: "Older", state: "updateAvailable", latest: "1.1.0", installedVersion: "1.0.0" }),
      app({ appId: "a.lic", name: "Paid", state: "licensed" }),
      app({ appId: "a.rev", name: "Bad", latestRevoked: true }),
    ]);
    show();
    await screen.findByRole("article", { name: /Fresh/ });
    const card = (n: string) => screen.getByRole("article", { name: new RegExp(n) });
    expect(within(card("Fresh")).getByRole("button", { name: "Install Fresh" })).toBeEnabled();
    expect(within(card("Current")).getByRole("button", { name: "Installed" })).toBeDisabled();
    expect(within(card("Older")).getByRole("button", { name: "Update to 1.1.0 Older" })).toBeEnabled();
    expect(within(card("Paid")).getByRole("button", { name: "Not available yet" })).toBeDisabled();
    expect(within(card("Paid")).getByText(/licensed app/)).toBeInTheDocument();
    expect(within(card("Bad")).getByRole("button", { name: "Withdrawn" })).toBeDisabled();
    expect(within(card("Bad")).getByText(/withdrew this version/)).toBeInTheDocument();
  });

  it("warns, without blocking, when the catalogue or the withdrawal list is out of date", async () => {
    withApps([app()], registry({ stale: true, revocations: { serial: 3, expires: 1, stale: true } }));
    show();
    expect(await screen.findByText(/catalogue expired on/)).toBeInTheDocument();
    expect(screen.getByText(/list of withdrawn tools is out of date/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install OTP Vault" })).toBeEnabled();
  });

  it("shows the last failed check and says the catalogue is unchanged", async () => {
    withApps([app()], registry({ lastError: "the server answered 503" }));
    show();
    expect(await screen.findByText(/The last check failed: the server answered 503/)).toBeInTheDocument();
    expect(screen.getByText(/The catalogue below is unchanged/)).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /OTP Vault/ })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    withApps();
    show();
    await screen.findByRole("article", { name: /OTP Vault/ });
    expect(await violations()).toEqual([]);
  });

  it("switches between several registries", async () => {
    const a = registry();
    const b = registry({ id: "registry:acme.public", name: "Acme Tools", trust: "pinned", publisher: "Key pinned by you" });
    C.listRegistries.mockResolvedValue([a, b]);
    C.registryCatalogue.mockImplementation(async (id: string) =>
      id === a.id ? catalogue([app()]) : catalogue([shamir({ name: "Acme Widget", appId: "acme.widget" })], { registryId: b.id, registryName: b.name }),
    );
    const { user } = show();
    await screen.findByRole("article", { name: /OTP Vault/ });
    await user.click(screen.getByRole("tab", { name: "Acme Tools" }));
    expect(await screen.findByRole("article", { name: /Acme Widget/ })).toBeInTheDocument();
    expect(C.registryCatalogue).toHaveBeenLastCalledWith(b.id);
  });
});

describe("installing one app", () => {
  it("installs the chosen app, says it has no access, reloads the vault, and can open it", async () => {
    withApps();
    C.installFromRegistry.mockResolvedValue({
      state: "installed",
      notes: [],
      install: { tool: { name: "OTP Vault" }, warnings: [] },
    } as never);
    const { user, onLibraryChanged, onOpenVault } = show();
    await user.click(await screen.findByRole("button", { name: "Install OTP Vault" }));
    expect(C.installFromRegistry).toHaveBeenCalledWith("registry:sh.enigma.public", "sh.enigma.otp-vault");
    expect(await screen.findByText(/Installed OTP Vault\. It has no access yet/)).toBeInTheDocument();
    expect(onLibraryChanged).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open Tool Vault" }));
    expect(onOpenVault).toHaveBeenCalled();
    // The catalogue was reloaded so the card reflects the new state.
    expect(C.registryCatalogue).toHaveBeenCalledTimes(2);
  });

  it("passes on notes about an out-of-date catalogue", async () => {
    withApps();
    C.installFromRegistry.mockResolvedValue({
      state: "installed",
      notes: ["This registry's catalogue is out of date."],
      install: { tool: { name: "OTP Vault" }, warnings: ["Publisher could not be confirmed."] },
    } as never);
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Install OTP Vault" }));
    const note = await screen.findByText(/Installed OTP Vault/);
    expect(note).toHaveTextContent("Publisher could not be confirmed.");
    expect(note).toHaveTextContent("catalogue is out of date");
  });

  it("reports an install that was already done without pretending something changed", async () => {
    withApps();
    C.installFromRegistry.mockResolvedValue({ state: "alreadyInstalled", version: "1.0.2" });
    const { user, onLibraryChanged } = show();
    await user.click(await screen.findByRole("button", { name: "Install OTP Vault" }));
    expect(await screen.findByText(/OTP Vault 1\.0\.2 is already installed/)).toBeInTheDocument();
    expect(onLibraryChanged).not.toHaveBeenCalled();
  });

  it("shows why an install was refused, and does not touch the vault", async () => {
    withApps();
    C.installFromRegistry.mockRejectedValue(
      commandError("inconsistent", "The downloaded bundle does not match what the registry listed (checksum). Nothing was installed."),
    );
    const { user, onLibraryChanged } = show();
    await user.click(await screen.findByRole("button", { name: "Install OTP Vault" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was installed.");
    expect(onLibraryChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Install OTP Vault" })).toBeEnabled();
  });

  it("pauses every other install while one is running", async () => {
    withApps();
    let finish: (v: unknown) => void = () => {};
    C.installFromRegistry.mockReturnValue(new Promise((r) => (finish = r)) as never);
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Install OTP Vault" }));
    expect(screen.getByRole("button", { name: "Install OTP Vault" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Install Shamir Secret Sharing" })).toBeDisabled();
    finish({ state: "alreadyInstalled", version: "1.0.2" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Install Shamir Secret Sharing" })).toBeEnabled());
  });
});

describe("installing everything", () => {
  it("counts only what can be installed and asks first, saying nothing gets access", async () => {
    withApps([
      app({ appId: "a.1", name: "One" }),
      app({ appId: "a.2", name: "Two" }),
      app({ appId: "a.cur", name: "Current", state: "installed", installedVersion: "1.0.2" }),
      app({ appId: "a.lic", name: "Paid", state: "licensed" }),
      app({ appId: "a.rev", name: "Bad", latestRevoked: true }),
    ]);
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Install all (2)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Install 2 tools\?/)).toBeInTheDocument();
    expect(within(dialog).getByText(/None of them gets any\s+access/)).toBeInTheDocument();
    expect(within(dialog).getByText("One v1.0.2")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Paid|Bad|Current/)).not.toBeInTheDocument();
    expect(C.installAllFromRegistry).not.toHaveBeenCalled();
  });

  it("does nothing if the user cancels", async () => {
    withApps();
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Install all (2)" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(C.installAllFromRegistry).not.toHaveBeenCalled();
  });

  it("installs on confirmation, reports each result, and says none are approved", async () => {
    withApps();
    C.installAllFromRegistry.mockResolvedValue([
      { appId: "sh.enigma.otp-vault", name: "OTP Vault", state: "installed", toolId: "t1", version: "1.0.2", trust: "verified" },
      { appId: "sh.enigma.shamir", name: "Shamir Secret Sharing", state: "failed", code: "hash_mismatch", message: "the file does not match its hash" },
    ]);
    const { user, onLibraryChanged } = show();
    await user.click(await screen.findByRole("button", { name: "Install all (2)" }));
    await user.click(await screen.findByRole("button", { name: "Install all" }));
    expect(C.installAllFromRegistry).toHaveBeenCalledWith("registry:sh.enigma.public");
    expect(await screen.findByText("1 installed, none approved")).toBeInTheDocument();
    expect(screen.getByText(/installed v1\.0\.2, no access yet/)).toBeInTheDocument();
    expect(screen.getByText(/not installed\. the file does not match its hash/)).toBeInTheDocument();
    expect(onLibraryChanged).toHaveBeenCalledTimes(1);
  });

  it("does not offer it when there is nothing to install", async () => {
    withApps([app({ state: "installed", installedVersion: "1.0.2" })]);
    show();
    await screen.findByRole("article", { name: /OTP Vault/ });
    expect(screen.queryByRole("button", { name: /Install all/ })).not.toBeInTheDocument();
  });
});

describe("refreshing and removing", () => {
  it("refreshes and says what changed", async () => {
    withApps();
    C.refreshRegistry.mockResolvedValue({
      index: { state: "updated", fromSerial: 7, toSerial: 8 },
      revocations: { state: "unchanged" },
      registry: registry({ serial: 8 }),
    });
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(C.refreshRegistry).toHaveBeenCalledWith("registry:sh.enigma.public");
    expect(await screen.findByText(/Updated to catalogue 8/)).toBeInTheDocument();
  });

  it("says when nothing changed", async () => {
    withApps();
    C.refreshRegistry.mockResolvedValue({
      index: { state: "unchanged" },
      revocations: { state: "unchanged" },
      registry: registry(),
    });
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/already up to date/)).toBeInTheDocument();
  });

  it("surfaces a partly failed refresh", async () => {
    withApps();
    C.refreshRegistry.mockResolvedValue({
      index: { state: "updated", fromSerial: 7, toSerial: 8 },
      revocations: { state: "failed", message: "Revocations were not refreshed: not found (404)" },
      registry: registry({ serial: 8 }),
    });
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revocations were not refreshed");
  });

  it("explains a failed refresh and keeps the catalogue on screen", async () => {
    withApps();
    C.refreshRegistry.mockRejectedValue(commandError("rollback", "serial 6 is older than 7 already seen"));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("serial 6 is older than 7 already seen");
    expect(alert).toHaveTextContent(/went backwards/);
    expect(screen.getByRole("article", { name: /OTP Vault/ })).toBeInTheDocument();
  });

  it("asks before removing, says installed tools stay, and removes the right registry", async () => {
    withApps();
    C.removeRegistry.mockResolvedValue(undefined);
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Remove Enigma Technologies Solutions" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Tools you already installed from it stay/)).toBeInTheDocument();
    expect(C.removeRegistry).not.toHaveBeenCalled();
    C.listRegistries.mockResolvedValue([]);
    await user.click(within(dialog).getByRole("button", { name: "Remove registry" }));
    expect(C.removeRegistry).toHaveBeenCalledWith("registry:sh.enigma.public");
    expect(await screen.findByRole("heading", { name: "No registry yet" })).toBeInTheDocument();
  });

  it("does not remove when the user cancels", async () => {
    withApps();
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Remove Enigma Technologies Solutions" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(C.removeRegistry).not.toHaveBeenCalled();
  });
});

describe("an app's detail page", () => {
  async function open(d = detail(), apps = [app(), shamir()]) {
    withApps(apps);
    C.registryAppDetail.mockResolvedValue(d);
    const view = show();
    await view.user.click(await screen.findByRole("button", { name: "Details for OTP Vault" }));
    await screen.findByRole("heading", { level: 1, name: /OTP Vault/ });
    return view;
  }

  it("loads the verified detail for exactly that app", async () => {
    await open();
    expect(C.registryAppDetail).toHaveBeenCalledWith("registry:sh.enigma.public", "sh.enigma.otp-vault");
    expect(await screen.findByText("A two-factor code generator in a single file.")).toBeInTheDocument();
    expect(screen.getByText("Licence: AGPL-3.0-only")).toBeInTheDocument();
  });

  it("lists in plain words what the app asks for, and that approval comes later", async () => {
    await open();
    const section = screen.getByRole("region", { name: "What it asks for" });
    expect(within(section).getByText("read/write local browser storage")).toBeInTheDocument();
    expect(within(section).getByText(/talk to your smart card/)).toBeInTheDocument();
    expect(within(section).getByText(/you approve each\s+permission yourself afterwards/)).toBeInTheDocument();
  });

  it("shows the changelog and renders the manual as formatted text", async () => {
    await open();
    const log = await screen.findByRole("region", { name: "What is new" });
    expect(within(log).getByText(/First release signed by Enigma\./)).toBeInTheDocument();
    const manual = screen.getByRole("region", { name: "Manual" });
    expect(within(manual).getByRole("heading", { name: "Create a vault" })).toBeInTheDocument();
    expect(within(manual).getByText("Create vault").tagName).toBe("STRONG");
    expect(within(manual).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows a verified screenshot, and a placeholder where one failed its check", async () => {
    await open(
      detail({
        screenshots: [
          { alt: "The vault, unlocked", width: 640, height: 400, dataUrl: "data:image/png;base64,AAAA", error: null },
          { alt: "The backup screen", width: 640, height: 400, dataUrl: null, error: "the hash does not match" },
        ],
      }),
    );
    expect(await screen.findByRole("img", { name: "The vault, unlocked" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(screen.queryByRole("img", { name: "The backup screen" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "The backup screen (unavailable)" })).toBeInTheDocument();
    expect(screen.getByText(/could not be verified, so it is not shown/)).toBeInTheDocument();
  });

  it("uses the verified icon only as a decorative image", async () => {
    await open(detail({ icon: "data:image/svg+xml;base64,PHN2Zy8+" }));
    const img = document.querySelector("header img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("withholds a manual that failed its check and says so", async () => {
    await open(detail({ manual: null, manualError: "the hash does not match" }));
    expect(await screen.findByText(/The manual could not be verified, so it is not shown/)).toBeInTheDocument();
  });

  it("offers links as text to copy, never as something to click through to", async () => {
    await open();
    expect(document.querySelectorAll("a").length).toBe(0);
    expect(screen.getByRole("button", { name: "Copy website address" })).toBeInTheDocument();
    expect(screen.getByText(/does not open links itself/)).toBeInTheDocument();
  });

  it("installs from the detail page with the same rules", async () => {
    const { user } = await open();
    C.installFromRegistry.mockResolvedValue({ state: "alreadyInstalled", version: "1.0.2" });
    await user.click(screen.getByRole("button", { name: "Install OTP Vault" }));
    expect(C.installFromRegistry).toHaveBeenCalledWith("registry:sh.enigma.public", "sh.enigma.otp-vault");
  });

  it("lists versions, marking installed and withdrawn ones", async () => {
    await open(
      detail(),
      [
        app({
          installedVersion: "1.0.1",
          state: "updateAvailable",
          versions: [
            { version: "1.0.2", publishedAt: 1_790_000_000, declared: [], size: 1, revoked: false },
            { version: "1.0.1", publishedAt: 1_789_000_000, declared: [], size: 1, revoked: false },
            { version: "1.0.0", publishedAt: 1_788_000_000, declared: [], size: 1, revoked: true },
          ],
        }),
      ],
    );
    const versions = screen.getByRole("region", { name: "Versions" });
    expect(within(versions).getByText("Installed")).toBeInTheDocument();
    expect(within(versions).getByText("Withdrawn by the registry")).toBeInTheDocument();
  });

  it("explains a failed load and offers to try again", async () => {
    withApps();
    C.registryAppDetail.mockRejectedValueOnce(commandError("fetch_failed", "could not connect: timeout"));
    const { user } = show();
    await user.click(await screen.findByRole("button", { name: "Details for OTP Vault" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the details. could not connect: timeout");
    // What came from the signed catalogue is still there.
    expect(screen.getByRole("region", { name: "What it asks for" })).toBeInTheDocument();
    C.registryAppDetail.mockResolvedValue(detail());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("A two-factor code generator in a single file.")).toBeInTheDocument();
  });

  it("goes back to the catalogue", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Catalogue" }));
    expect(await screen.findByRole("article", { name: /OTP Vault/ })).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    await open(
      detail({
        screenshots: [{ alt: "The vault", width: 640, height: 400, dataUrl: "data:image/png;base64,AAAA", error: null }],
        icon: "data:image/png;base64,AAAA",
      }),
    );
    await screen.findByRole("region", { name: "Manual" });
    expect(await violations()).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Markdown } from "./Markdown";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));

describe("the manual renderer", () => {
  it("renders the allowed subset as real elements", () => {
    const { container } = render(
      <Markdown source={"## Title\n\nSome **bold**, *soft* and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```\nraw <b>\n```"} />,
    );
    expect(screen.getByRole("heading", { name: "Title" }).tagName).toBe("H4");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("soft");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector("pre code")?.textContent).toBe("raw <b>");
  });

  it("never turns a link into something that can be followed", async () => {
    const { container } = render(<Markdown source="See [the site](https://example.test/a?b=1) for more." />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("https://example.test/a?b=1");
    await userEvent.click(screen.getByRole("button", { name: "Copy link: the site" }));
    expect(writeText).toHaveBeenCalledWith("https://example.test/a?b=1");
  });

  it("shows hostile input as plain text and inserts no element from it", () => {
    const hostile = [
      "<script>window.__pwned = true</script>",
      "Hi <img src=x onerror=alert(1)>",
      "[click](javascript:alert(1))",
      "![x](https://evil.test/track.png)",
      "<!-- comment -->",
      "- one\n  - nested",
    ];
    for (const source of hostile) {
      const { container, unmount } = render(<Markdown source={source} />);
      expect(container.querySelector("script"), source).toBeNull();
      expect(container.querySelector("img"), source).toBeNull();
      expect(container.querySelector("a"), source).toBeNull();
      expect(container.querySelector("[onerror]"), source).toBeNull();
      // The fallback says so and shows the text exactly as written.
      expect(screen.getByRole("note")).toHaveTextContent(/shown as plain text/);
      expect(container.querySelector("pre")?.textContent).toBe(source);
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
      unmount();
    }
  });

  it("escapes markup-looking text inside the allowed subset", () => {
    const { container } = render(<Markdown source={"Use `<div>` and write 5 < 6 & 7 > 3"} />);
    expect(container.querySelector("code")?.textContent).toBe("<div>");
    // The only <div> is the renderer's own wrapper: nothing from the text became an element.
    expect(container.querySelectorAll("div")).toHaveLength(1);
    expect(container.textContent).toContain("5 < 6 & 7 > 3");
  });
});

---
title: "Personal software, on your terms"
date: "2026-10-16"
slug: "introducing-sanctum"
excerpt: "Software is now cheap to build, and a single HTML file is the easiest thing to share. Sanctum runs those files with the access you approve and nothing more."
kicker: "Launch"
cover_title: "Introducing Sanctum"
cover_sub: "Run the tools AI writes for you, on your terms."
---

Software has never been cheaper to make. A person who describes a task to a capable AI model can have a working program a few minutes later, and more and more people are doing exactly that: building small, personal tools for the jobs in front of them, such as a converter, a parser, a calculator, or a utility for a task that no commercial product covers.

Most of these tools take the same form, a single HTML file, and the reason is portability. An HTML file needs no installer, no build step and no server. It opens on any computer with a browser, it can be sent by email or kept in a folder, and one file can still do real work by itself, from transforming data to running cryptography to keeping its own records. Few other things people build are as easy to hand to someone else.

That convenience carries a cost that grows with every tool. The file is usually a few hundred lines of HTML and JavaScript that its user neither wrote nor read, and when it is opened in a browser tab it runs at once with ordinary web permissions. A single line could send data to a host the user has never heard of, and the user learns what the tool contacted only afterwards, if at all. A virtual machine can isolate the file, but it does not report what the file tried to reach, and setting one up for a small utility costs more than the utility saves.

Today we are launching Sanctum to address that. It is a desktop application that runs these tools under rules you set.

## Why we built Sanctum

Sanctum started with a request from a company that needed to generate cryptographic keys with a tool that met three conditions:

- they could inspect the source code and trust it;
- they could keep using it five years later, offline and without our involvement;
- they could verify where it came from.

The tool itself was simple to write, since it fits in one HTML page, and the difficulty lay in everything around it. A hosted version depends on a website that might not exist in five years or might be compromised in the meantime. A downloaded file removes the dependency on a server but leaves a different gap, because a file on a disk carries no proof of who made it or whether it has changed since.

We had also been building a set of small tools for cryptographic tasks, and we wanted to give people something they could download once and rely on indefinitely. Websites disappear, whereas a signed file that you keep does not depend on one.

## What Sanctum does

Sanctum is a desktop application for running single-file HTML tools. When you add a tool, it:

- stores a copy under its SHA-256 hash, runs only that copy, and checks the hash again on every launch;
- scans the source and lists what the tool uses, including the camera, storage, smart cards and every hostname it names;
- asks you to approve each capability, with network access approved one host at a time;
- opens the tool at its own origin, under a Content Security Policy built from your approvals, with the application's own bridge removed.

Anything you did not approve stays blocked, including capabilities the scan missed, because the sandbox enforces your choices and the scan only fills in the approval screen. There is no account and no telemetry. Sanctum is open source under AGPL-3.0 and free for individuals.

## Signed tools

A sandbox is most useful when you also know who made the tool inside it, so Sanctum now includes a Catalogue of tools that their publishers have signed. Enigma publishes the first two: [Shamir](https://sanctum.enigma.sh/apps/sh.enigma.shamir/), which splits a secret into shares and rebuilds it from any chosen number of them, and [OTP Vault](https://sanctum.enigma.sh/apps/sh.enigma.otp-vault/), which keeps one-time codes in Sanctum's storage and optionally on a YubiKey. You can open the Catalogue tab, or choose Install in Sanctum on a tool's page on the website. Either way Sanctum shows the tool, its publisher and what it asks for, and installs nothing until you confirm.

Two rules govern all of it. A signature tells you who published a tool and that the file has not changed since, but it does not tell you the tool is safe, and it never grants access, so an installed tool starts with nothing approved, exactly like one you pasted in.

## Who it is for

Sanctum is intended for CTOs, CISOs and the teams they lead, who need a specific tool and need to know that it will keep behaving in the same way. Models now write such tools readily, but the results usually arrive as links or hosted services that can change or disappear. A tool installed as a signed bundle is a fixed file. It behaves on day one as it does on day one thousand, and it runs on your own desktop and network, where confidential data has nowhere to go that you did not approve.

## What you can verify

We prefer a short list of guarantees that always hold to a long list that depends on a scanner being right. The scanner can be fooled, so it is not the security control; the origin, the policy and the hash check are, and they apply to every tool in the same way. You should not have to rely on our word for any of it:

- **Offline operation.** Installed tools run without a network connection unless you approved a host. Sanctum has no telemetry, and its only request at start is the update check to GitHub releases, which a network inspector will show you.
- **Rejection of altered tools.** The catalogue is signed, and so is each tool. A tampered bundle, or one served by someone who has taken over the download site, fails the check and is not installed.
- **Open source.** Sanctum and the registry format are open source, so anyone can audit what we describe here.

## What comes next

Sanctum contacts a registry only when you ask it to. We are now working on update notices for catalogue tools and a faster way to withdraw a tool that proves to be harmful. For organizations, we are building signed policy, fleet deployment and audit logs with a first group of design partners; if that describes you, write to ultra@enigma.sh.

## Try it

Download Sanctum for macOS, Windows or Linux from [the releases page](https://github.com/Enigma-Technologies-Solutions/sanctum/releases/latest), choose Browse signed tools on the first screen, and install [Shamir](https://sanctum.enigma.sh/apps/sh.enigma.shamir/). We would like to hear how it went, either as an issue on [GitHub](https://github.com/Enigma-Technologies-Solutions/sanctum/issues) or by email at ultra@enigma.sh.

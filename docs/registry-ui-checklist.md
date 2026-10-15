# Catalogue interface: checks that need a real window

Automated tests cover the logic, the flows, the safety properties and basic accessibility
rules (`pnpm test`). They cannot show a real window, a real screen reader or the real webview.
This list is what a person has to look at. Run `pnpm tauri dev`, or use an installed build.

Mark each line pass or fail, and write down anything odd.

## Look and feel (macOS window, which is Safari's engine)

- [ ] The header shows **Tool Vault, Catalogue, Settings**. The current tab has the volt bar.
- [ ] Catalogue with no registry: the "No registry yet" card, one volt button, one outline button.
- [ ] Cards line up in a grid, the same height in a row, nothing clipped. Icons are placeholders, as designed.
- [ ] Text is readable at the default size, and at 200% zoom nothing overlaps or hides a button.
- [ ] Resize to the narrowest window: the grid becomes one column, no horizontal scroll.
- [ ] Dialogs are centred, have a close button, and the background is dimmed.
- [ ] A detail page reads well: title, scope list, about, what is new, manual, versions.
- [ ] The manual shows headings, bold, lists and code with sensible spacing.

## The Enigma registry, end to end (needs a network)

- [ ] Click **Add the Enigma registry**. OTP Vault and Shamir appear. The header says
      "Verified: Enigma Technologies Solutions" and a catalogue number.
- [ ] OTP Vault's card shows **Storage** and **Smart card** under "Asks for". Shamir shows **No special access**.
- [ ] Open OTP Vault's details: the scope sentences, the changelog and the manual load.
      The copy buttons for the website and source addresses put text on the clipboard.
      Nothing in the window opens a browser by itself.
- [ ] **Install Shamir**. The message says it has no access yet. **Open Tool Vault** switches tab,
      and Shamir is already in the list with the green "Verified publisher" badge.
- [ ] Open Shamir from the vault. It runs. In Inspect, no permissions are approved.
- [ ] Back in the catalogue, Shamir's card says **Installed**, and the button is disabled.
- [ ] **Install** OTP Vault. In Tool Vault it shows its permissions as asked for but **not approved**.
      Approve storage by hand and confirm that works as before.
- [ ] **Install all** disappears once everything is installed.
- [ ] **Refresh** says the catalogue is already up to date.
- [ ] Remove a tool in Tool Vault, return to the catalogue: its card says **Install** again.

## Failure and trust

- [ ] Turn the network off. **Refresh** shows an error with a hint, and the cards stay.
- [ ] Network still off: opening a detail page shows "Could not load the details" and **Try again** works once it is back.
- [ ] **Add another registry** with `http://example.com/`: refused with a hint about https.
- [ ] **Add another registry** with a made-up address: a clear error, nothing added.
- [ ] If you have a registry signed by another key: the key is shown in full, the button stays
      disabled until the box is ticked, and Cancel adds nothing.
- [ ] **Remove** the Enigma registry: the dialog says installed tools stay. Afterwards they are still in Tool Vault.

## Keyboard and screen reader (macOS VoiceOver: Cmd+F5)

- [ ] Tab reaches every button, tab and field in a sensible order, and the focus ring is visible.
- [ ] In a dialog Tab stays inside it, Escape closes it, and focus returns to the button that opened it.
- [ ] VoiceOver reads each card as "article, <name>", then the publisher, version and "Asks for".
- [ ] VoiceOver announces the result after an install ("Installed OTP Vault. It has no access yet...") without moving focus.
- [ ] A disabled button's reason (for example "Version 1.0.2 is installed") is read with it.
- [ ] The registry tabs (when there are two) announce as tabs with the selected one.
- [ ] Error messages are announced when they appear.

## Known gaps

- Screenshots and icons only show once a registry publishes them. The Enigma registry has none yet,
  so the screenshot path is covered by tests but not yet seen in a real window.
- Colour contrast is not checked by the automated accessibility tests (they cannot measure it).
  Judge it by eye, or with the macOS Accessibility Inspector.
- Other registries have only been tried with test data.

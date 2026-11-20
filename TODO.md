# TODO

## Open

**iOS** (the native app is new; it uses the mailbox only, like the web client)

- [ ] Calls ring only while the app is open — needs CallKit + push (APNs).
- [ ] A full call (media both ways) hasn't been tested end to end yet: the
      offer reaches web and decrypts, hang-up and the call log work, but the
      simulator has no camera and the test browser no microphone. Test on a
      real iPhone against Android or a desktop browser.
- [ ] Direct UDP transport (the Rust transport builds for iOS, it isn't wired in).
- [ ] Optical pairing / history transfer from another device.
- [ ] Attachments: received ones show as a file entry; no sending, no preview.

**Web**

- [ ] Error messages that come from the Rust core (via WASM) are still Polish.
- [ ] Server tests: 3 fail locally when `.dev.vars` sets
      `DELIVERY_TOKEN_REQUIRED=true` (they assume enforcement is off).

**Android**

- [ ] The neutral visual system compiles but hasn't been checked on a device.

## Done

All items shipped on both clients (web = lead client; Android = parity where the
feature makes sense on a phone). Web: typecheck + tests + `vite build` pass.
Android: `compileDebugKotlin` + `testDebugUnitTest` pass.

1. ✅ **Leaving groups.** The core already had `opuscGrupe` (a SelfRemove
   proposal) — what was missing was a way in from the UI. Web: a "Leave group"
   button in the participants panel (groups only) + confirmation. Android: the
   same in `EkranUczestnikow` + `AlertDialog`.

2. ✅ **UI glitch.** The kebab menu in the conversation list was clipped by the
   row's `overflow: hidden` (needed for the swipe gesture). An open menu now gets
   `overflow: visible` and a higher `z-index`. Web only.

3. ✅ **Blocking users.** A new local, encrypted blocklist module
   (`blokady.ts` / `Blokady.kt`). Blocking is by username: it filters out the
   blocked person's messages and invitations and hides a DM/group made up only
   of blocked people. Block from the person in the participants panel; unblock
   in account settings (the only place, because the DM is hidden).

4. ✅ **Disappearing messages (custom, off by default).** A new module
   (`znikanie.ts` / `Znikanie.kt`): LOCAL retention per conversation — presets +
   custom time, swept every minute and when the setting changes. Deliberately
   doesn't delete on the other person's device (history lives with each person
   separately) — the panel says so plainly.

5. ✅ **Adding people to existing groups.** Web: "Add person" in the
   participants panel → `addMember`. Android: `dodajCzlonka` was already in
   `EkranUczestnikow`.

6. ✅ **Tap a photo → full screen.** Web: an overlay (lightbox) in
   `Zalacznik.tsx`. Android: a full-screen `Dialog` in `PodgladZalacznika`.

7. ✅ **Ctrl+V an image → attach and send.** Web: `onPaste` in the composer
   picks the image from the clipboard and sends it the same way as the paperclip
   (`wyslijPlik`). The idiom doesn't exist on Android — attachments go through a sheet.

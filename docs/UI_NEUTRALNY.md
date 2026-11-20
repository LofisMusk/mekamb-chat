# The "Neutral" visual system — shared spec for web, Android and iOS

This document is **normative for how the apps look**. It replaces Nocturne (cyan
as a line) and the "Mekamb Mobile" variant (a coloured accent as a fill). Every
client implements the same roles under the same names — changing the look means
changing the tokens here and on all three platforms, not re-picking shades on one.

## Why neutral

A messenger whose whole point is *what you can't see* (encryption, no metadata)
doesn't need a brand that shouts with colour. A neutral greyscale (the "neutral"
base from shadcn/ui) does three things at once:

- contrast comes from lightness, so it works the same in both themes and for
  people with colour-vision deficiencies;
- colour is reserved for **states** (error, verified, warning) — when red shows
  up, something really is wrong;
- three platforms are easier to keep in sync, because there's no accent shade
  that has to be tuned for contrast separately on every screen (see the history
  of `#06B6D4` → `#0891B2` → `#0E7490` in Nocturne).

Rejected alternative: keep the accent as a user option on every platform. Android
has one (eight colours) and may keep it as a preference, but **the default is
"Neutral"**, and web and iOS have no picker for now.

## The main rule

**The primary action is filled with `glowny` (near-black in light, near-white in
dark). There is at most one such action per screen.** Everything else is an
outlined button (`linia`) or a "ghost" (no background, `wglebienie` on hover).
This deliberately inverts Nocturne: in a neutral palette an outline can't tell
the primary action from a secondary one, because there's no colour to set it
apart — the lightness of the fill does.

The own-message bubble is filled with the same `glowny`; the other person's is
`wglebienie`. The author is recognisable by lightness, not by side. **That's why
there is no other `glowny` fill in the thread** apart from the send arrow (which
creates exactly that bubble). Call, video and participants buttons are ghosts.

The one exception is the call screen: accept is a green fill and decline/hang up
is a red fill. "Green answers, red declines" is a convention people recognise
without reading, in a hurry — stronger than this system.

## Colour tokens (roles)

| Role | Light | Dark | Used for |
|---|---|---|---|
| `tlo` | `#FFFFFF` | `#0A0A0A` | app background |
| `karta` | `#FFFFFF` | `#171717` | cards, panels, sheets, popovers |
| `wglebienie` | `#F5F5F5` | `#262626` | text fields, the other person's bubble, hover, segment track |
| `wglebienie-mocne` | `#E5E5E5` | `#404040` | pressed state, active list item |
| `tekst` | `#0A0A0A` | `#FAFAFA` | primary text |
| `tekst-drugi` | `#737373` | `#A3A3A3` | captions, message previews, times (≥ 4.5:1) |
| `tekst-trzeci` | `#A3A3A3` | `#737373` | decorative/non-essential only (placeholders) |
| `linia` | `#E5E5E5` | `#FFFFFF1A` (white 10%) | borders, separators |
| `linia-mocna` | `#D4D4D4` | `#FFFFFF26` (white 15%) | focused field border, outlined button |
| `pierscien` | `#A3A3A3` | `#737373` | focus ring (2px, 2px offset) |
| `glowny` | `#171717` | `#E5E5E5` | primary action, own bubble, unread badge |
| `glowny-tekst` | `#FAFAFA` | `#171717` | text on `glowny` |
| `alarm` | `#DC2626` | `#F87171` | error, destructive action (text/outline) |
| `alarm-tlo` | `#FEF2F2` | `#450A0A` | error message background |
| `sukces` | `#16A34A` | `#4ADE80` | "verified", "connected" |
| `ostrzezenie` | `#D97706` | `#FBBF24` | test build, unverified key |
| `nakladka` | `#000000 / 40%` | `#000000 / 60%` | backdrop under a sheet/dialog |

Bubbles: `babel` = `wglebienie` + `tekst`; `babel-wlasny` = `glowny` + `glowny-tekst`.
Unread badge: `glowny` + `glowny-tekst`, pill-shaped.

The role names are Polish because the code is; they are identical on all three
platforms (`web/src/styles.css`, `Nocturne.kt`, `ios/Mekamb/Widoki/Kolory.swift`).

## Typography

- Web: **Geist** (variable, from `@fontsource-variable/geist`, served from our own
  origin — the CSP doesn't allow external fonts), mono: Geist Mono for safety
  numbers and fingerprints.
- iOS: SF Pro (system), SF Mono for codes. Android: system (Roboto), monospace for codes.
- Scale (pt/sp/px): 12 caption · 13 meta · 15 body (bubble, list) · 17 section/navigation
  heading · 22 screen title · 28 welcome title. Weights: 400 / 500 / 600.
  Screen titles 600 with `letter-spacing` −0.02em.

## Shape and spacing

- Radii: `promien-s` 6, `promien-m` 10 (buttons, fields, cards), `promien-l` 14
  (sheets, dialogs — a sheet's top corners 16), `promien-babel` 18, pill 999.
- Spacing on a 4 scale — 4, 8, 12, 16, 24, 32. Content margin 16 on a phone, 24 on desktop.
- Touch targets ≥ 44×44.
- Shadows: light `0 1px 2px #0000000D` for floating cards (popover, menu, toast);
  dark — no shadow, a `linia` border instead.

## Bubble anatomy (unchanged from the previous web version)

One radius for every bubble; a run from one side is held together by 2px spacing,
12px between runs; a tail only on the last bubble of a run. The time sits on a
centred separator ("Today 08:42") on a day change and after an hour of silence.
Delivery state is a word under the last own message ("delivered", "read"), in
`tekst-drugi`, 12.

## Component patterns and their platform counterparts

| Pattern | Web | Android (Compose) | iOS (SwiftUI) |
|---|---|---|---|
| Buttons: primary / outline / ghost / destructive | shadcn `Button` (`default`/`outline`/`ghost`/`destructive`) | own `PrzyciskGlowny`/`PrzyciskObrys`/`PrzyciskDuch` on the tokens | own `ButtonStyle`s on the tokens |
| Transient notification (toast) | **Sonner**, top-centre on phones, bottom-right on desktop | own toast at the top (not Material `Snackbar`), same look: card + line + shadow | overlay at the top, `.transition(.move(edge: .top))` |
| Bottom sheet (actions, attachments, details) | **Vaul** `Drawer` under 768px; Radix `Dialog` on desktop | `ModalBottomSheet` with a handle, `karta` background | `.sheet` with `.presentationDetents` and `.presentationDragIndicator(.visible)` |
| Confirmation dialog | Radix `AlertDialog` | `AlertDialog` restyled with the tokens | `.confirmationDialog` / `.alert` |
| Context / overflow menu | Radix `DropdownMenu` / `ContextMenu` | `DropdownMenu` restyled | `Menu` / `.contextMenu` |
| Command palette / search | **cmdk** (`⌘K`/`Ctrl+K`): conversations, actions, settings | search field above the list | search field above the list |
| Counters (unread, participants) | **NumberFlow** | `AnimatedContent` with a vertical slide | `.contentTransition(.numericText())` |
| Tooltip | Radix `Tooltip` | none (long-press → description) | none |
| Switch / segment | Radix `Switch` / `ToggleGroup` | `Switch` / own segment | `Toggle` / `Picker(.segmented)` |
| Avatar | initials on `wglebienie-mocne`, circle | same | same |
| Welcome screen background | subtle dot pattern (Magic UI *Dot Pattern*) in `linia` | `Canvas` with dots | `Canvas` with dots |

The "gallery" libraries (Magic UI, Aceternity, 21st.dev, Beautiful UI, RareUI) are
a source of **single, restrained** patterns copied into the repo (the dot pattern
behind the welcome screen, a subtle shimmer while loading). No gradients, neon or
animated borders — that would break the neutrality.

## Layout

- **Phone** (< 768px, and Android/iOS): conversation list → thread as a separate
  screen on the navigation stack. Bottom bar: Chats · Settings (iOS `TabView`,
  Android `NavigationBar` restyled: active icon `tekst`, inactive `tekst-drugi`,
  no coloured pill). The screen title sits in one row with its actions (the "+"),
  at the very top — not on a separate row under the bar.
- **Desktop** (≥ 1024px): three columns — a narrow navigation rail (64) ·
  conversation list (320) · thread; conversation details (participants, safety
  number) as a fourth column (360) from 1280px, otherwise in a sheet.
- Thread header: avatar + name + subtitle (`tekst-drugi`); on the right, ghosts:
  call, video. Details open by tapping the name.
- Composer: `wglebienie`, radius 20, no border; next to it the send arrow as a
  `glowny` circle 36×36 (the only fill in the thread).

## Language

English is the default interface language on every client; Polish is a full
alternative, chosen in settings and on the welcome screen (so someone who doesn't
read English can reach it before signing in). Both strings sit side by side at the
point of use — `t(pl, en)` on all three platforms — rather than in a key catalogue.

## Motion

150 ms for states (hover, press), 250 ms for entrances (sheet, toast), curve
`cubic-bezier(0.32, 0.72, 0, 1)` (as in Vaul). `prefers-reduced-motion` /
"Reduce Motion" turns off slides and keeps fades.

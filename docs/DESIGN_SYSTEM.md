# FPV-ARBCON Design System — the 2026-08 UI pass

One React Native codebase renders both targets (Android via Metro, browser
via Vite + react-native-web), so this document describes ONE system, not
two. The warm-paper background identity (`colors.background #FAF8F3`) is
deliberate and preserved; this pass strengthened typography, icons,
controls and RTL *within* that identity.

## Typography — Cairo everywhere except the terminal

- Family: **Cairo** (SIL OFL), self-hosted on both platforms.
  - Web: `src/web/cairo.css` — variable woff2 per script subset
    (arabic / latin / latin-ext, wght 400–800), imported by
    `index.web.tsx`, fingerprinted by Vite.
  - Android: static instances in `android/app/src/main/res/font/`
    (`cairo_regular/medium/semibold/bold.ttf`) mapped by `cairo.xml` and
    registered as family `"Cairo"` in `MainApplication.kt` via
    `ReactFontManager.addCustomFont`. On API 28+ `fontWeight` selects the
    real face; API 24–27 resolves regular/bold only (platform floor).
- Tokens: `src/ui/theme/typography.ts` — `display / title / sectionTitle /
  heading / bodyStrong / body / label / value / caption / helper / eyebrow
  / mono`. The object type is EXACT: a phantom token is a compile error
  (28 call sites used to spread tokens that did not exist and silently
  rendered unstyled).
- Rules:
  - Every `Text` style must include a typography token (or
    `cairo(weight)` from the theme) — never a bare
    `fontSize`/`fontWeight` pair without family and line-height.
  - Weights live in 400–700. **Never** 800/900 (no face exists; Android
    fake-bolds), never below 400 (thin Arabic is unreadable).
  - Line-heights are ~1.7× and are part of the token. Do not tighten
    them; Cairo's Arabic ascenders/descenders genuinely need the span.
  - `letterSpacing` stays 0 in Arabic text — tracking tears the
    connected script apart.
  - No text below 12px. If a hint doesn't fit, shorten the hint.
  - Terminal/CLI output and byte-level values stay `typography.mono` —
    Cairo must NOT reach terminal surfaces.
  - Numbers an operator compares (telemetry, tuning values) get
    `fontVariant: ['tabular-nums']`.

## Icons — `<Icon/>`, never characters

- `src/ui/icons/` renders vendored Lucide geometry (24-grid, stroke 2)
  through react-native-svg on both platforms.
- Emoji, arrows, guillemets, middle-dots-as-chevrons (`⚠ ✓ ⛔ ↻ ‹ › ▲ − +`)
  are banned as icons. (An em-dash as an *empty-value placeholder* is
  typography, not an icon, and stays.)
- Sizes: 18–20 inline beside text, 20–22 in buttons/rows, 22–24 for
  section-level emphasis. Stroke stays 2.
- Direction: geometry names never mirror; navigation uses
  `chevron-forward/back`, `arrow-forward/back` aliases which resolve
  against `I18nManager.isRTL`.
- Icon-only controls use `IconButton` (44×44 floor, label required).

## Controls — `src/ui/components/controls/`

| Component | Replaces | Notes |
|---|---|---|
| `Button` | every local Pressable+Text recipe | primary / secondary / danger / ghost; md 44 / lg 52; hover+pressed+disabled states built in |
| `IconButton` | glyph-only Pressables | 44×44 guaranteed; `accessibilityLabel` required |
| `ToggleSwitch` | `react-native` `Switch` | 52×30 self-drawn; deep-teal ON; identical on both platforms |
| `Stepper` | per-screen `[−][value][+]` clones | LTR numeric island; real glyphs; editable centre optional; per-side disabling |
| `ChoiceChips` | per-screen chip radios | check + tint + border selection; 44px chips |
| `SelectField` | any dropdown need | modal option sheet — **cannot** cover its own label, on any width |
| `SettingRow` | ad-hoc title/desc/control stacks | side-by-side when `wide`, stacked otherwise |
| `NoticeBox` | hand-rolled status boxes | danger / warning / success / info / **hardware** (hardware verification keeps its accent look; see below for its copy) |

Interaction states come from `readInteraction()` — hover is web-only and
harmless on Android. `MIN_TOUCH_TARGET = 44` is exported from
`controls/interaction.ts`; do not re-declare it per file.

### The hardware-verification notice

**The contract, in one line: the visual treatment is fixed by the design
system, the words are fixed by the Arabic catalogue, and neither is
allowed to be an English review token.**

This convention used to be written down as the literal
`REQUIRES HARDWARE TEST`, and nine shared screens rendered exactly that
string to operators — on Android and in the browser alike, since these
are the same files. That phrase is our own engineering process
vocabulary. It belongs in comments, audit documents and test names; it
does not belong in a product whose entire interface is Arabic.

What the notice says has not changed and must not be weakened. A
software ACK, a successful write-readback, or a green UI state proves
storage and protocol correctness — never physical behaviour. Every one
of these notices exists to say so.

Two titles, both in `ar.json` under `hardwareVerification`:

| Key | Arabic | Use when |
|---|---|---|
| `hardwareVerification.title` | يتطلب التحقق على جهاز فعلي | the operator must **look at or measure** the result on real hardware — OSD in the goggles, battery figures against a meter, VTX output on an analyser |
| `hardwareVerification.behaviourTitle` | يتطلب اختبارًا على جهاز فعلي | the operator must **physically actuate something and watch what happens** — move TX switches, cut the RF link, move each sensor axis, run a bench or staged flight test |

Rules for new notices:

- Never inline either Arabic title at a call site; always go through `t()`,
  so `i18nCoverage.test.ts` keeps guarding it and there is one place to
  change the wording.
- Never introduce a third variant of this phrase. If neither title fits,
  the notice is probably a `danger` or `warning`, not a `hardware` one.
- Keep the accent styling. The title changed; the visual language of
  "unproven on real hardware" did not.
- `src/ui/operatorVocabulary.test.ts` fails the build if an internal
  review token reaches runtime source, and `scripts/scan-web-bundle.js`
  fails it again if one reaches the shipped browser bundle.

## Color

- The background identity is untouched: `background`, `backgroundRaised`,
  `surface`, accent family — unchanged values.
- Status tints are tokens now: `errorSoft / warningSoft / successSoft /
  infoSoft`. Hard-coded `#FFF0F2`-style literals are a defect.
- Interactive borders use `borderStrong`; hairline `borderSoft` is for
  separators inside cards, not for control outlines.
- Interaction shades: `accentHover/Pressed`, `surfaceHover/Pressed`,
  `errorHover/Pressed`.

## RTL

- The app forces RTL once, at both roots. Screens use logical properties
  (`marginStart`, `paddingEnd`, flex order) — never `left/right` offsets
  for layout the direction should own.
- Numeric/technical islands (steppers, byte dumps, coordinates) declare
  `direction: 'ltr'` explicitly — digits read LTR inside Arabic copy.
- English identifiers (MSP, UART, DSHOT…) inside Arabic sentences keep
  the existing `writingDirection: 'rtl'` container so the sentence
  direction wins and the token renders as an inline LTR run.

## Layout

- Tiers and envelopes come from `src/ui/theme/layout.ts`
  (`resolveLayoutTier`, `contentEnvelope`) — no new private breakpoints.
- Cards: `surface` fill, 1px `border`, `radii.lg`, `spacing.lg` padding.
  Settings inside cards separate with `borderSoft` hairlines
  (`SettingRow`'s `divider`).

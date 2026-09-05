# Design — CM-HUB

A locked visual system for CM-HUB. Every application-page redesign reads this
file before changing a component. Extend this document when the system grows;
do not create a one-off visual language per route.

## Genre

Modern-minimal operational SaaS: calm, high-information, direct. The interface
is a workbench, not a marketing surface.

## Macrostructure family

- App pages: left navigation rail + compact top context bar + left-biased workbench canvas.
- Action pages: one dominant action surface, proof/result immediately below, history or detail after it.
- Data pages: a concise decision summary followed by an action queue; full historical ledgers live in a dedicated view.

## Theme

- Base surfaces use cool, lightly chromatic neutral OKLCH values.
- CM-HUB blue is the only functional accent. It marks primary actions, selected navigation, links, and focus.
- Green, amber, and red are reserved for labelled success, warning, and error states; colour never carries state alone.
- Accent coverage stays small: no decorative gradients, glows, or filled background bands.
- Light and dark mode use the same hue family. Dark-mode elevation comes from lighter surfaces, not stronger shadows.

## Typography

- Body/UI: `Segoe UI Variable`, with PingFang and Microsoft YaHei fallbacks for CJK.
- Data/identifiers: IBM Plex Mono, only for order numbers, timestamps, and compact metrics.
- Body defaults to 14px in dense operational contexts; meaningful prose stays at 16px or larger.
- Headings use 700 weight, compact tracking, and a 1.2 line-height. Supporting copy uses 1.5–1.65.
- Numeric displays use tabular figures.

## Spacing and layout

- 4pt token scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80px.
- Page gutters are fluid; panels use 24px padding by default and 16px in compact contexts.
- Primary controls are 44px high. Dense secondary controls may be 36px on fine pointers and grow to 44px on touch.
- Content is capped at 1440px. Page layouts use Grid; component internals use Flexbox.
- Desktop breakpoints begin around 40rem, 60rem, and 90rem. Mobile layouts are action-first, do not rely on horizontal scrolling for core work.

## Component voice

- Panels: one hairline border, tinted base surface, 14px radius, no stacked-card construction.
- Buttons: compact, single-line labels; primary is solid blue, secondary is quiet bordered neutral, destructive is text-first until confirmation is needed.
- Inputs: visible labels, 44px baseline, constant 1px border across states, 2px focus ring with 2px offset.
- Tables: quiet header surface, 60px default row height, tabular numeric columns, visible selected/hover states.
- Empty states explain why the content is absent and offer the next permitted action.

## Motion

- Micro: 120ms; state change: 180–220ms; drawers/modals: 420ms.
- Use only opacity and transform for spatial motion. No universal hover lifts, glow effects, or decorative looping motion.
- Honour reduced motion by collapsing spatial movement to brief opacity transitions.

## Accessibility contract

- Normal text targets 4.5:1 contrast or better; UI boundaries and focus rings target 3:1 or better.
- Keyboard focus is always visible. Interactive touch targets are 44×44px where reachable.
- Labels are visible and errors use text/icon/ARIA in addition to colour.
- Every route remains usable at 320, 375, 414, and 768px without document-level horizontal overflow.

## Migration rule

`src/styles/tokens.css` is the canonical primitive → semantic → component token source.
Existing `--cmhub-*` aliases remain during the migration so business components
continue to work. Phase-three page work replaces raw visual values with the
semantic and component tokens rather than adding new page-local palettes.

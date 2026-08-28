# Frontend and UI quality review

Use this reference only when the review includes browser-facing code. It adapts
the accessibility, CSS, forms, performance, motion, and visual-design guidance
from the repository's local Modern Web Guidance material into review questions.
It is an audit rubric, not an instruction to rewrite working UI into one favored
implementation style.

Do not import that skill's AI-building, generic HTML/JavaScript, security, or
TypeScript guidance into this lane. Security remains owned by the security lane.
Framework conventions and the repository's `AGENTS.md` remain authoritative.

## Evidence strategy

Combine static tracing, the existing Playwright suites, automated accessibility
checks, performance budgets, responsive screenshots, and manual keyboard
inspection. Automated accessibility tools find only a subset of problems; do
not call a surface accessible without keyboard, focus, zoom/reflow, contrast,
and assistive-technology reasoning.

Prefer representative user journeys and reusable components over counting
individual rule violations. Record the route, viewport, theme, input method,
browser, command, and screenshot or trace for every runtime claim.

## Accessibility and interaction

Check landmarks, heading order, document language, native semantics, accessible
names, alternative text, media captions, and whether state is communicated by
more than color. Verify DOM order matches visual and keyboard order; CSS `order`,
reverse flex directions, or dense grid placement must not scramble focus.

Exercise every interactive path with keyboard alone. Focus must be visible,
unclipped, and restored or routed after dialogs, popovers, view changes, and
errors. Modal behavior must trap focus and make the background inert. Controls
need usable pointer targets, including coarse-pointer layouts, without disabling
page scrolling through broad `touch-action: none` rules.

Test at 200% zoom and a 320 CSS-pixel viewport for reflow, clipping, hidden
actions, and horizontal scrolling. Check light, dark, forced-colors, and reduced-
motion modes. Meaningful content must survive when backgrounds, shadows, and
decorative generated content disappear.

## Forms

Inspect complete workflows, including loading, server rejection, correction,
retry, and success. Prefer native form controls and ensure each control has a
stable name, visible label, appropriate type, autocomplete value, input mode,
and related hint/error references. Placeholders are not labels. Related choices
should have meaningful grouping and legends.

Required fields should not appear erroneous on initial load. Validate after
interaction or submission, clear stale errors while the user corrects input,
set `aria-invalid` consistently, and route failed submission to a useful error
summary or the first invalid control. Dynamic announcements must be concise and
must not produce duplicate or noisy live-region output. Keep submit available
for validation, then prevent duplicate valid submissions while the request is
in flight. Verify browser autofill and password-manager behavior for identity
forms, including paste support.

## CSS, layout, and theming

Review the cascade and selector intent, not merely syntax. Look for duplicated
policy values, specificity escalation, selectors that overmatch disabled or
nested states, broad global resets, and one-off colors or spacing that bypass
established tokens. Logical properties should be used where the design is meant
to follow writing direction, but not mechanically where physical direction is
intentional.

Check intrinsic sizing, long strings, translated copy, container boundaries,
flex/grid shrink behavior, overflow, dynamic mobile viewport units, media aspect
ratios, scrollbar stability, and layout shift. Fixed dimensions and viewport-
only queries deserve scrutiny when content- or container-driven layout would be
more resilient. New CSS features need a deliberate progressive fallback when
unsupported behavior would break the task rather than merely remove polish.

Theme review covers design-token consistency, native control `color-scheme`,
light/dark contrast, forced-colors fallbacks, selection/focus visibility, and
scrollbar legibility. Do not require rebuilding native controls for styling.

## Performance

Measure before assigning a performance finding. Cover LCP, INP, CLS, bundle and
request cost, long main-thread tasks, editor interaction latency, and expensive
rendering on representative low-end CPU/network conditions. Use field telemetry
when available to distinguish input delay, handler work, and presentation delay.

Check that the likely LCP resource is discoverable and not lazy-loaded, only
genuinely critical resources receive elevated priority, responsive media reserve
space, and below-the-fold media or heavy subtrees are deferred without breaking
keyboard reachability. Long tasks should yield or move off the main thread;
repeated DOM read/write cycles, polling, eager third-party code, and oversized
route bundles need concrete trace evidence before they become findings.

Keep deterministic editor performance budgets as a CI gate. Treat UAT timing as
environment-sensitive evidence: compare it with a declared budget and baseline,
retain traces, and do not claim a regression from one noisy sample.

## Motion and visual design

Animation must preserve state, focus, and interruptibility. Prefer compositor-
friendly transform/opacity work, limit continuous or large spatial motion, and
provide a designed reduced-motion alternative rather than a blanket near-zero
duration hack. Entry/exit and view-transition fallbacks must leave the interface
fully usable when the feature is unsupported.

Review hierarchy, density, alignment, text measure, wrapping, typography,
contrast, responsive composition, empty/loading/error states, and consistency
across themes. Font loading and fallbacks should avoid invisible text and
layout shift. Visual taste calls belong in a separate recommendations section
unless they demonstrably impair a user task, accessibility, or product rule.

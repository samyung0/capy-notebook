- Developer Epo approved (2026-09-16) keeping shared dialog content on a stable rendering layer with `will-change: transform` to prevent the 1px body jump at animation completion while preserving existing motion. src/components/ui/Dialog.tsx
- Developer approved (2026-09-18) preserving the shared custom popup's transparent exit frame until removal to prevent the workspace tag dropdown flashing when dismissed. src/components/ui/PopupMotion.tsx
- Developer requested (2026-09-17) removing workspace settings tab scrollbar overflow and improving settled dialog text clarity while retaining `will-change: transform`. src/components/ui/Tabs.tsx src/components/ui/Dialog.tsx
- Developer requested graceful unrounded dialog centering on browsers without CSS round() support; gate rounding with feature queries. src/components/ui/Dialog.tsx
- Developer Epo requested (2026-09-16) keeping the share dialog's member section visible until its closing animation finishes. src/features/workspace/ShareDialog.tsx

- Developer Epo requested (2026-09-16) signup resend cooldown with Resend code → Code sent → Resend code (60s), inline text-states-swap motion instead of notice text, and number-pop-in motion in workspace statistics, preferably Tailwind. src/features/auth/AuthLanding.tsx src/features/workspace/WorkspaceSettingsDialog.tsx
- Developer Epo requested (2026-09-17) stable notification popover anchor bounds while preserving the generic bell button's existing styles and press animation. src/features/notification/NotificationBell.tsx
- Developer requested (2026-09-17) a stable shared dropdown anchor so button press scaling does not shift menu content. src/components/ui/DropdownMenu.tsx
- Developer clarified (2026-09-17) the Workspaces Filter popover also needs a stable anchor around its animated trigger, matching the notification bell. src/routes/Workspaces.tsx
- Developer decided (2026-09-17) shared PopoverTrigger owns the stationary PopoverAnchor wrapper; callers including Workspaces Filter and the notification bell inherit it without custom wrappers. src/components/ui/Popover.tsx
- Developer approved (2026-09-17) matching dropdown and submenu animations to Popover through a shared recipe: fade, 97% entry scale, 2px entry blur and directional 16px entry slide; 99% exit scale, 250ms open and 150ms close. src/styles/tokens/motion.css src/components/ui/DropdownMenu.tsx src/components/ui/Popover.tsx

- Developer approved (2026-09-18) migrating TagSelect to the shared Popover with input-focused autocomplete behavior and combobox accessibility; retain PopupMotion for editor overlays. src/components/ui/TagSelect.tsx
- Developer requested (2026-09-21) chat send/stop uses the transitions.dev icon-swap fade, blur and scale transition in Tailwind, with a slightly smaller solid stop glyph. src/features/workspace/ChatPanel.tsx
- Developer requested (2026-09-21) preserve the chat send icon's original stroke weight during its send/stop animation; use the shared Icon default instead of strokeWidth 4. src/features/workspace/ChatPanel.tsx

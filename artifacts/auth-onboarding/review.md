# Auth and onboarding implementation review

Reviewed on 2026-09-10 against `plan.md`, the recorded product decisions, and the developer's request to reuse `Card`, `Input`, `InputTitle`, and `InputError`. This review covers the current uncommitted implementation. No implementation files were changed.

## Findings

### 1. [P2] Preserve the password exactly when signing in

Resolved 2026-09-10. Sign-in now uses `signInPasswordSchema()` in `src/features/auth/password.ts`, which never trims; codes keep the trimming schema. `password.test.ts` asserts a padded password parses unchanged.

`src/features/auth/AuthLanding.tsx:179-184,249-250`

The sign-in password uses `requiredField`, which calls `.trim()`. Sign-up and password reset preserve the original password. Someone who creates a password with leading or trailing spaces therefore cannot sign in with that same password. An execution of the current schema changes `" capybara-2026! "` to `"capybara-2026!"` before submission.

Use a non-transforming nonempty string schema for sign-in passwords. Keep trimming verification codes separately. Add a focused check that the password submitted to Clerk equals the entered value.

### 2. [P2] Mount CAPTCHA on the OAuth callback page

Resolved 2026-09-10. `src/routes/SsoCallback.tsx` renders `<div id="clerk-captcha" />` next to the callback component.

`src/routes/SsoCallback.tsx:15-21`

The callback transfers a first-time OAuth sign-in into a sign-up, but this page never renders `clerk-captcha`. The container in `SignUpCard` has already unmounted when the browser returns to `/sso-callback`. The installed `AuthenticateWithRedirectCallback` only invokes Clerk's callback handler and renders nothing itself.

UAT's public environment currently reports smart CAPTCHA enabled and `captcha_oauth_bypass: []`. A visitor flagged for a challenge therefore has no interactive challenge to complete on this page. Clerk documents that the invisible fallback blocks suspected bots without giving a falsely flagged person a way to prove they are human.

Mount `<div id="clerk-captcha" />` alongside the callback. The existing callback component can remain. Sources: [Clerk OAuth flow](https://clerk.com/docs/guides/development/custom-flows/authentication/oauth-connections), [Clerk CAPTCHA behavior](https://clerk.com/docs/react/guides/development/custom-flows/authentication/bot-sign-up-protection).

### 3. [P2] Accept Clerk's absolute same-origin return URLs

Resolved 2026-09-10. `redirectAfterAuth` in `src/features/auth/clerk.ts` parses the value against `window.location.origin`, requires an exact origin match and returns pathname, search and hash. `clerk.test.ts` covers a relative path, an absolute same-origin URL, `//host`, `/\\host` and a foreign origin.

`src/features/auth/clerk.ts:13-16`

The helper only accepts strings beginning with `/`. `AuthGate` uses Clerk's `RedirectToSignIn`, whose default return URL is the full current URL. Opening a protected workspace or invitation while signed out therefore loses the destination: `https://capynotebook.com/workspaces/ws_review` becomes `/`.

Parse the value with `new URL(raw, window.location.origin)`, require an exact origin match, and return its pathname, search, and hash. This also avoids treating `/\\outside.example` as same-origin merely because it passes the current prefix check. Browser URL parsing interprets that value as an external origin; the current client-side history path can fail on it. This review did not demonstrate an external redirect exploit.

Source: [Clerk redirect behavior](https://clerk.com/docs/guides/development/customize-redirect-urls). The absolute-URL rejection was reproduced against the current helper.

### 4. [P2] Prevent dialog dismissal while onboarding saves

Resolved 2026-09-10. `OnboardingDialog` ignores `onClose` while busy and prevents default on `onEscapeKeyDown` and `onInteractOutside` while busy, so `onboardedAt` is written only by a finished Confirm or an available Skip.

`src/features/auth/OnboardingDialog.tsx:74-80,134`

Disabling the footer buttons does not disable Escape or outside-click dismissal. `SimpleDialog` sends those events to `onClose`, which calls `skip()` without checking `busy`. That immediately dismisses the dialog and writes `onboardedAt`, even if an avatar upload or name update is still pending.

If the save then fails, the error is stored in a hidden dialog and the completed metadata prevents it from reopening. Executing the current handlers with a deferred, failing name update reproduced `dismissed=true`, `onboarded=true`, and a hidden save error.

Guard dismissal while busy, including Escape and outside interaction. Only mark onboarding complete after a successful confirm or an available Skip action.

### 5. [P2] Redirect already authenticated visitors out of the auth landing

Resolved 2026-09-10. `AuthLanding` reads `useAuth()` and replaces the history entry with the validated return destination once Clerk reports a session. The reset page is left alone; a signed-in user may still reset a password there.

`src/features/auth/AuthLanding.tsx:552-555`

The new landing always renders its sign-in or sign-up form, including for an active Clerk session. The old prebuilt components redirected already signed-in users in single-session mode, which UAT still enables. A user who revisits a saved `/sign-in` URL or returns there through browser history now sees an unusable authentication form. Even the brand link points back to `/sign-in`.

Add one shared authenticated-user redirect for these landing modes, using the validated return destination. Source for the previous behavior: [Clerk SignIn component](https://clerk.com/docs/reference/components/authentication/sign-in).

## Component reuse and plan alignment

All five items below were applied on 2026-09-10: `AuthCard` renders the existing `Card` (`border="solid"`, `radius="card-lg"`); the onboarding name field pipes a trimmed string into `UpdateMeBody.shape.name` and reads its `maxLength`; every form destructures `formState`; the reset page is two steps, email then code plus new password in one form; `useUpdateMe` takes the `MutationUiOptions` and the dialog passes `errorToast: false`.

- `Input`, `InputTitle`, `InputError`, `Button`, `Avatar`, and `SimpleDialog` are already reused. `SimpleDialog` also uses `Card` internally. `AuthCard` still duplicates the card border, background, and radius at `AuthLanding.tsx:85`. Replace that outer div with the existing `Card`, preserving the agreed dimensions and spacing.
- The onboarding form rebuilds the name schema and hardcodes its limit at `OnboardingDialog.tsx:17,42-44`. The generated `UpdateMeBody` already supplies that API constraint. Compose trimming with that schema rather than maintaining another independent limit.
- Sign-up and reset read `form.formState.isSubmitting` and `codeForm.formState.isSubmitting` directly. Destructure these states to follow the repository convention. The current reads occur during render, so this review does not claim they presently miss React Hook Form subscriptions.
- Password reset has three visible steps: email, code, then password. The agreed design calls for email followed by code plus new password together. `ForgotPassword.tsx:117-200` separates them, while the second-step hint still says to enter both. Combine those inputs into the agreed second step.
- `useUpdateMe` uses the default global error toast while onboarding also renders its failure inline. Set `meta: { errorToast: false }` for this mutation to follow `openwiki/frontend/error-handling.md`.

## Verification and remaining limits

- `pnpm test` passed: 62 source test files, 295 tests, plus 4 editor benchmark-helper tests.
- `pnpm typecheck` passed.
- `pnpm test:go` passed across the Go packages in the backend review.
- Reproduced password mutation, absolute return-URL rejection, and onboarding dismissal/save failure using the current code.
- Read UAT's public Clerk configuration. Google and Microsoft are enabled, signup is public, CAPTCHA has no OAuth exemptions, and MFA is disabled.
- Both Clerk upsert SQL branches preserve an existing display name. The new setter uses the account-session lock. Avatar updates are refreshed through a fresh Clerk profile read on authenticated API requests.
- Live Google/Microsoft round trips, email delivery and verification, and resetting an OAuth-only account were not completed. The passing tests do not cover those custom UI flows.

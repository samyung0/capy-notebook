# Sign-in landing, password reset, and first-run onboarding

Implementation handoff, 2026-09-10. Based on Capy Notebook `main` at `e4d0f7e`. Product choices are agreed and recorded in `human/miscellaneous.md` and `human/authorization-permissions-lifecycles.md` (entries dated 2026-09-10). Read those before reviewing. This document describes what is being built and how a reviewer can check it.

Draft screens the developer approved: https://claude.ai/code/artifact/efa5fab2-a486-4b58-9df8-1275a94d36d8

Status (2026-09-10, same day): implemented on `main`; the findings in `review.md` were applied the same day. Verified: `pnpm test:go` for `store`, `httpapi`, `auth`; `pnpm test` (62 files); `pnpm typecheck`, `pnpm run fix`. In the browser against the development Clerk instance: the landing, sign-up and reset pages render in light and dark; the sign-up password rule shows inline; a wrong-credentials sign-in shows Clerk's "Couldn't find your account." under the OAuth buttons; the sign-up form mounts Clerk's Turnstile widget in the `clerk-captcha` container. Not verified by the agent: the email-code step and finalize (the automated browser drew an interactive Turnstile challenge, which the agent does not complete), Google or Microsoft round trips, the onboarding dialog end to end (needs the local gateway), and whether the reset flow sets a password on an OAuth-only account. A reviewer should walk those four by hand.

## 1. Agreed behavior

- `/sign-in` is a Capy-designed landing page. Left column holds brand copy (headline, one paragraph, four feature pills, company line). Right column holds the auth card: Google, Microsoft, email plus password, a "Forgot password?" link, and a "Create an account" link.
- `/sign-up` renders the same page with the card in sign-up mode. Sign-up is email plus password, then a six-digit email code. The form renders a `clerk-captcha` container because bot protection is on for both Clerk instances.
- `/forgot-password` is one page with two steps: email, then code plus new password. Clerk's reset is code-based, not link-based. Success activates the session and lands on the dashboard.
- `/sso-callback` renders Clerk's `AuthenticateWithRedirectCallback`. Google and Microsoft return here. Clerk performs the sign-in to sign-up transfer for first-time OAuth users.
- Clerk's prebuilt `<SignIn>` and `<SignUp>` pages are removed. `ClerkProvider` receives `signInUrl="/sign-in"` and `signUpUrl="/sign-up"` so `RedirectToSignIn` lands on our page. The same-origin `redirect_url` query keeps the post-auth destination, as today.
- Passwords: the Clerk instances enforce a 12 character minimum. The sign-up and new-password forms additionally require one digit and one special character, checked with zod before the request. The sign-in form only checks non-empty.
- OAuth users are never asked to set a password. Clerk links a later Google or Microsoft sign-in onto an existing verified email account automatically. An OAuth-only user typing email plus password gets Clerk's error under the field.
- `users.name` becomes user-owned. Clerk profile sync and the Clerk webhook write it only when inserting the local account. Later syncs refresh email and avatar only. A new `PATCH /api/me` stores the name the user typed. Stripe customer names use that column, accepted by the developer.
- First-run onboarding dialog on the dashboard. It opens when the Clerk user has no `unsafeMetadata.onboardedAt`. Avatar uploads to Clerk through `user.setProfileImage`. Name saves through `PATCH /api/me`. Confirm and "Skip for now" both write `onboardedAt` to Clerk. Skip writes nothing to Capy's database. Every existing account sees the dialog once.
- No MFA, no magic links, no username attribute. Verified against both instances' `/v1/environment` on 2026-09-10.

## 2. Clerk configuration this depends on

Both instances (`clerk.uat.capynotebook.com` and the development instance) had these settings on 2026-09-10. The pages assume them.

| Setting | Value |
| --- | --- |
| First and last name | enabled, not required |
| Username | disabled |
| Email address | required, verified at sign-up by email code |
| Sign-in first factor | password only |
| Google, Microsoft | enabled |
| MFA | off |
| Password minimum | 12 (developer lowered it from 15) |
| Breached-password check on sign-in | on. Clerk may answer `needs_new_password`; the card handles it with the same new-password form as the reset page |
| Bot protection on sign-up | on, smart widget. The sign-up form renders `<div id="clerk-captcha" />` |
| Dashboard paths | still point at Clerk's hosted pages. Not required for this work because the provider props override them |

## 3. Files

### Backend (Go)

| File | Change |
| --- | --- |
| `server/internal/store/users.go` | `UpsertUserFromClerk` stops writing `name` on the existing-row UPDATE and on `ON CONFLICT`. New `SetName(ctx, userID, name)` under the account session lock, same shape as `SetLocale`. |
| `server/internal/httpapi/apimodel/limits.go` | New bounded type `UserName` (max 60 from `fieldlimits.UserName`). |
| `server/internal/httpapi/apimodel/requests.go` | `UpdateMeReq { Name UserName }` with `minLength:"1"`. |
| `server/internal/httpapi/huma_account.go` | `PATCH /api/me` → `updateMe`, trims, rejects empty after trim with 422, returns the refreshed `User`. |
| `server/internal/httpapi/webhooks.go` | No code change. `user.updated` flows through the same upsert, which no longer touches `name`. |
| `server/internal/store/account_lifecycle_test.go` | New test: a profile refresh with a different name leaves the stored name alone; a first insert still takes the Clerk name. |
| `server/internal/httpapi/me_name_test.go` | `PATCH /api/me` accepts a 60 rune name, rejects empty and 61 runes with 422, and `GET /api/me` reflects the change. |
| `openapi.yaml`, `src/api/gen/*` | Regenerated with `pnpm gen:api:full`. |

### Frontend

| File | Change |
| --- | --- |
| `src/features/auth/AuthLanding.tsx` | Landing layout, brand column, auth card, OAuth buttons, sign-in card (form and needs-new-password states), sign-up card (form and email-code states), shared `NewPasswordForm`. |
| `src/routes/SignIn.tsx`, `src/routes/SignUp.tsx` | Thin routes rendering the landing in sign-in or sign-up mode. |
| `src/routes/ForgotPassword.tsx` | New. Email step, then code plus new password. |
| `src/routes/SsoCallback.tsx` | New. Renders `AuthenticateWithRedirectCallback` with the redirect target. |
| `src/features/auth/password.ts` | New. Zod schema for the composition rule, shared by sign-up and both new-password forms, plus the non-trimming sign-in password schema. One vitest. |
| `src/features/auth/clerk.ts` | New. Clerk error to message, same-origin `redirect_url` parsing (relative or absolute, origin must match), SSO callback URLs. One vitest. |
| `src/features/auth/ProviderIcons.tsx` | Google and Microsoft marks for the OAuth buttons. |
| `src/styles/tailwind.css` | New `t-display` utility over the existing display tokens. |
| `src/features/auth/OnboardingDialog.tsx` | New. Avatar upload, name field, Confirm and Skip. Clerk-only, mounted from the dashboard behind the same `CLERK_ACTIVE` guard the profile pill uses. |
| `src/routes/Dashboard.tsx` | Mounts the onboarding dialog. |
| `src/components/app/AuthProvider.tsx` | `signInUrl` and `signUpUrl` on `ClerkProvider`. |
| `src/router.tsx` | Adds `/forgot-password` and `/sso-callback` next to the existing Clerk-only public routes. |
| `src/api/hooks.ts` | `useUpdateMe` mutation writing the returned user into `qk.me`. |
| `src/api/types.ts` | Re-exports `UpdateMeReq`. |
| `src/mocks/handlers.ts` | `PATCH /api/me` handler updating `db.user.name`. |
| `messages/en.json`, `messages/zh.json` | New `auth_*` and `onboarding_*` keys. |

### Docs

| File | Change |
| --- | --- |
| `openwiki/authorization-permissions-lifecycles.md` | Profile sync paragraph: name is written on insert only; `PATCH /api/me` owns it afterwards. Short "Sign-in pages" subsection listing the four routes. |
| `openwiki/backend-storage-quota.md` | The clamp note about Clerk profile names now applies to the first insert only; typed names are rejected with 422 like other user input. |
| `openwiki/test-catalog.md` | New test rows. |

## 4. Flows

Sign-in with password:
1. `signIn.create({ identifier })` then `signIn.password({ identifier, password })`.
2. `status === 'complete'` → `signIn.finalize({ navigate })` to the `redirect_url` target.
3. `status === 'needs_new_password'` → show the new-password form, then `signIn.resetPasswordEmailCode.submitPassword({ password })` and finalize.
4. Any error → message under the field from `errors.fields` or the global error.

Sign-up with password:
1. `signUp.password({ emailAddress, password })`.
2. `signUp.verifications.sendEmailCode()` → code step.
3. `signUp.verifications.verifyEmailCode({ code })` → `status === 'complete'` → `signUp.finalize({ navigate })`.

OAuth (both modes): `signIn.sso({ strategy: 'oauth_google' | 'oauth_microsoft', redirectCallbackUrl: '/sso-callback', redirectUrl: target })`. On `/sso-callback` the callback component completes the session or transfers to sign-up. The provider props supply `signInUrl`/`signUpUrl` for the failure paths.

Forgot password:
1. `signIn.create({ identifier })` then `signIn.resetPasswordEmailCode.sendCode()`.
2. One form with code and new password: `verifyCode({ code })`, then `submitPassword({ password })`, then finalize to `/`.

Onboarding:
1. Dashboard mounts the dialog when `useUser().user.unsafeMetadata.onboardedAt` is missing.
2. Name prefilled from `me.name`. File input restricted to images, previewed locally.
3. Confirm: `user.setProfileImage({ file })` if a file was picked, `PATCH /api/me { name }` if the name changed, then `user.updateMetadata({ unsafeMetadata: { onboardedAt } })`. `me` query is invalidated so the gateway sync picks up the new avatar on the next request.
4. Skip: only the metadata write.

## 5. Verification

- `pnpm test:go` for the store and HTTP tests above.
- `pnpm test` for the password schema test.
- `pnpm typecheck`, `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`.
- Manual on the development Clerk instance: email sign-up with code, sign-in, forgot password, Google sign-in creating a fresh account then landing on the onboarding dialog, avatar upload visible in the top bar after reload.
- Open question to settle during manual testing: whether Clerk's reset flow sets a password on an OAuth-only account. If it refuses, note it here; a "Set a password" row in Settings is a separate follow-up.

## 6. Review checklist

- `users.name` is never overwritten by a Clerk sync after the row exists. Check both SQL statements in `UpsertUserFromClerk`.
- `PATCH /api/me` trims, refuses empty, and enforces 60 runes through the bounded type, so the OpenAPI schema and the orval validator both carry the limit.
- The sign-in form does not enforce the composition rule.
- The sign-up form renders the `clerk-captcha` element before `signUp.password` is called.
- `redirect_url` is validated as same-origin (parsed against the page origin, exact match) in every place it is read; Clerk's `RedirectToSignIn` sends an absolute URL.
- The onboarding dialog never renders in MSW mode or when Clerk is inactive.
- Skip writes only Clerk metadata.
- Every new string exists in both `messages/en.json` and `messages/zh.json`.
- UAT e2e still signs in through `window.Clerk` tickets and never touches the card, so no e2e change is expected.

## 7. Out of scope

- Editing name or avatar from Settings.
- A "Set a password" control for OAuth-only accounts.
- Updating the Clerk dashboard paths to our pages.
- MFA, magic links, usernames, legal consent.

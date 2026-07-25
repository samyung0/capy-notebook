import { SignIn } from '@clerk/react';

function redirectAfterAuth() {
  const raw = new URLSearchParams(window.location.search).get('redirect_url');
  if (!raw?.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export default function SignInPage() {
  const redirectUrl = redirectAfterAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
      <SignIn
        fallbackRedirectUrl={redirectUrl}
        forceRedirectUrl={redirectUrl}
        path="/sign-in"
        routing="path"
        signUpUrl="/sign-up"
      />
    </div>
  );
}

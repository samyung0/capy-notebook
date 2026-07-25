import { SignUp } from '@clerk/react';

function redirectAfterAuth() {
  const raw = new URLSearchParams(window.location.search).get('redirect_url');
  if (!raw?.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export default function SignUpPage() {
  const redirectUrl = redirectAfterAuth();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6">
      <SignUp
        fallbackRedirectUrl={redirectUrl}
        forceRedirectUrl={redirectUrl}
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
      />
    </div>
  );
}

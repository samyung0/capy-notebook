import { signInHref } from '@/features/auth/clerk';
import { clerkActive, isPublicPath, likelySignedOut } from './clerkSession';

// A visitor with no Clerk session on a signed-in page goes to sign-in before
// the router reads the address (main.tsx imports this first), so no page waits
// for Clerk to say so and nothing reloads (Q905).
if (clerkActive && !isPublicPath(location.pathname) && likelySignedOut())
  history.replaceState(history.state, '', signInHref());

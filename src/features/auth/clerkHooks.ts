// Vite substitutes mock actions only in MSW development. Forms stay shared.
export {
  AuthenticateWithRedirectCallback,
  useAuth,
  useSignIn,
  useSignUp,
  useUser,
} from '@clerk/react';

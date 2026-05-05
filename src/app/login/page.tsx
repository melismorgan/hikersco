'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginInner() {
  const params = useSearchParams();
  const error = params.get('error');

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <h1 className="text-4xl mb-2">HIKERS Inventory</h1>
        <p className="text-charcoal/70 mb-10">
          Sign in with the Google account on the allow-list.
        </p>

        <button
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          className="inline-flex items-center gap-3 rounded-md bg-indigo px-6 py-3 text-warm-white hover:bg-indigo/90 transition-colors"
        >
          Sign in with Google
        </button>

        {error && (
          <p className="mt-6 text-ironclad text-sm">
            {error === 'AccessDenied'
              ? 'That email isn’t on the allow-list. Add it to ALLOWED_EMAILS to grant access.'
              : `Sign-in error: ${error}`}
          </p>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams must live inside a Suspense boundary in App Router.
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

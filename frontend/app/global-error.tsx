'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error:', error);
  }, [error]);

  return (
    <html>
      <body>
        <div className="flex h-screen items-center justify-center bg-black">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white mb-4">
              Application Error
            </h2>
            <p className="text-gray-400 mb-6">
              {error.message || 'A critical error occurred'}
            </p>
            <button
              onClick={reset}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Reload Application
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

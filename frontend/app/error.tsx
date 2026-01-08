'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/Button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Route error:', error);
  }, [error]);

  return (
    <div className="flex h-screen items-center justify-center bg-black">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-white mb-4">
          Something went wrong
        </h2>
        <p className="text-gray-400 mb-6">
          {error.message || 'An unexpected error occurred'}
        </p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}

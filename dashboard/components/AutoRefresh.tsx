'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-runs the server component every `seconds` (the page re-reads SQLite; nothing is pushed). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return <span className="small mut">auto-refresh {seconds}s</span>;
}

'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  ['/', 'Overview'], ['/signals', 'Signals'], ['/alerts', 'Alerts'], ['/performance', 'Performance'],
  ['/heatmap', 'Heat map'], ['/footprint', 'Footprint'], ['/gex', 'GEX'], ['/profile', 'Profile'],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="top">
      <div className="wrap">
        <span className="brand">Order-flow</span>
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href} className={href === '/' ? (path === '/' ? 'on' : '') : path.startsWith(href) ? 'on' : ''}>{label}</Link>
        ))}
        <span className="ro">read-only · no execution</span>
      </div>
    </nav>
  );
}

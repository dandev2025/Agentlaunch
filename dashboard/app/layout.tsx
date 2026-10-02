import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '../components/Nav';

export const metadata: Metadata = { title: 'Order-flow signals', description: 'Read-only dashboard for the order-flow alert and signal system' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Customer Operations Platform",
  description: "AI-powered customer operations for multi-tenant teams.",
};

// Deliberately free of authentication: the public widget (/widget) shares this layout. Clerk lives in
// the (app) route group. The props are typed explicitly: Next's global `LayoutProps` helper only exists after
// `next dev`, `next build` or `next typegen` has generated it, so a fresh checkout could not typecheck without it.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

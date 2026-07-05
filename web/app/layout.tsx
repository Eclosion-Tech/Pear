import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Providers } from "@/src/providers/Providers";
import { EnginesPanel } from "@/src/components/engines/EnginesPanel";
import { WorkspaceQueryBootstrap } from "@/src/components/WorkspaceQueryBootstrap";
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
  title: "Pear",
  description: "Self-hosted, relational-first workspace",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍐</text></svg>",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-200`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {/* Must render before Providers so ?ws/?db deep links set the
              active workspace before WorkspaceProvider reads localStorage. */}
          <WorkspaceQueryBootstrap />
          <Providers>{children}</Providers>
          {/* Desktop-only (renders nothing in a plain browser). */}
          <EnginesPanel />
        </ThemeProvider>
      </body>
    </html>
  );
}

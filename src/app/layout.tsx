import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
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
  title: "Browser — web browser with a real console",
  description:
    "A Chrome-style web browser in a web page: tabs, address bar, real websites streamed through a server-side proxy, plus a built-in console that executes real shell commands and evaluates JavaScript in the page.",
  keywords: [
    "web browser",
    "console",
    "terminal",
    "shell",
    "proxy browser",
    "devtools",
  ],
  authors: [{ name: "Browser" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Browser — web browser with a real console",
    description: "Browse real websites and run real commands, all inside one page.",
    siteName: "Browser",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster theme="dark" position="bottom-right" offset={44} visibleToasts={2} closeButton />
      </body>
    </html>
  );
}

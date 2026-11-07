import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import BottomNav from "@/components/BottomNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI-eat · AI 菜谱助手",
  description: "管理菜谱、按现有食材点菜的 AI 菜谱助手",
};

// 移动端 viewport：约束缩放以贴近原生应用体验
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* pb-14 预留底部导航高度，避免内容被固定导航遮挡 */}
        <div className="pb-14">{children}</div>
        <BottomNav />
      </body>
    </html>
  );
}

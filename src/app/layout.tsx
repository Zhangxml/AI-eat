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

// 移动端 viewport：跟随系统默认缩放（允许用户手势缩放，符合 WCAG 1.4.4）；
// 输入控件字号已统一 text-base（16px），iOS 聚焦不会自动放大页面
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
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
        {/* pb-14 预留底部导航高度，避免内容被固定导航遮挡。
            注意：/access-logs 不渲染底部导航（隐藏页），该路由会多出 56px 尾部留白——
            属可接受代价，为它单独做条件 padding 需要把布局改成 client 侧判断，不值得 */}
        <div className="pb-14">{children}</div>
        <BottomNav />
      </body>
    </html>
  );
}

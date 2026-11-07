// 占位首页：体现「AI 菜谱助手」定位，后续任务替换为真实首页
export default function Home() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-3xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-bold tracking-tight">AI-eat</h1>
      <p className="mt-4 text-lg text-neutral-600">你的 AI 菜谱助手</p>
      <p className="mt-2 text-sm leading-6 text-neutral-500">
        管理自己的菜谱库，标记现有食材，
        <br />
        让 AI 根据家里有什么推荐今天吃什么。
      </p>
    </main>
  );
}

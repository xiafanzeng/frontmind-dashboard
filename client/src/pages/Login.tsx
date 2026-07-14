import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LOGO_ICON =
  "https://d2xsxph8kpxj0f.cloudfront.net/310519663465762565/ZiWzJwHCXtKB4GziVKqKt6/fm-logo_cde8eb94.png";

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, loginPending } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      toast.error("请输入用户名和密码");
      return;
    }

    try {
      await login(normalizedUsername, password);
      setLocation("/", { replace: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "登录失败，请稍后重试";
      toast.error("无法登录", {
        description:
          message.includes("UNAUTHORIZED") || message.includes("用户名")
            ? "用户名或密码不正确"
            : message,
      });
    }
  };

  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-background px-4 py-8 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(800px circle at 12% 16%, oklch(0.86 0.035 178 / 36%) 0%, transparent 56%),
                       radial-gradient(720px circle at 92% 84%, oklch(0.92 0.045 58 / 52%) 0%, transparent 55%),
                       linear-gradient(150deg, oklch(0.99 0.004 83) 0%, oklch(0.955 0.014 83) 100%)`,
        }}
      />

      <div className="relative z-10 grid w-full max-w-5xl overflow-hidden rounded-[2rem] border border-border/70 bg-card/80 shadow-[0_32px_90px_oklch(0.22_0.012_255/0.12)] backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]">
        <section className="relative hidden min-h-[620px] overflow-hidden border-r border-border/60 bg-primary px-12 py-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-90"
            style={{
              background:
                "radial-gradient(circle at 20% 15%, oklch(0.72 0.07 178 / 35%), transparent 38%), radial-gradient(circle at 85% 85%, oklch(0.62 0.11 58 / 32%), transparent 45%)",
            }}
          />

          <div className="relative flex items-center gap-3">
            <img
              src={LOGO_ICON}
              alt="FrontMind"
              className="h-11 w-11 rounded-2xl bg-white/90 shadow-lg ring-1 ring-white/30"
            />
            <div>
              <p className="font-semibold tracking-wide">FrontMind Studio</p>
              <p className="text-xs tracking-[0.18em] text-primary-foreground/60">
                CONTENT AGENTS
              </p>
            </div>
          </div>

          <div className="relative max-w-md space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-primary-foreground/75">
              <Sparkles className="h-3.5 w-3.5" />
              团队内容工作空间
            </div>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight">
              在任意设备，继续你的内容流程
            </h1>
            <p className="text-base leading-7 text-primary-foreground/65">
              登录后即可安全访问属于你的会话记录与 API 凭据，无需在每台设备重复配置。
            </p>
          </div>

          <div className="relative flex items-center gap-2 text-xs text-primary-foreground/55">
            <ShieldCheck className="h-4 w-4" />
            账号数据与 API Key 均由服务端安全管理
          </div>
        </section>

        <section className="flex min-h-[540px] items-center px-6 py-10 sm:px-12 lg:min-h-[620px]">
          <div className="mx-auto w-full max-w-sm">
            <div className="mb-9 lg:hidden">
              <img
                src={LOGO_ICON}
                alt="FrontMind"
                className="mb-4 h-11 w-11 rounded-2xl shadow-sm ring-1 ring-border/70"
              />
              <p className="text-sm font-semibold">FrontMind Studio</p>
            </div>

            <div className="mb-8 space-y-2">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <LockKeyhole className="h-5 w-5" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">欢迎回来</h2>
              <p className="text-sm text-muted-foreground">
                使用管理员分配的账号登录工作空间。
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  name="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="输入用户名"
                  disabled={loginPending}
                  className="h-11 bg-background/70"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  name="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="current-password"
                  placeholder="输入密码"
                  disabled={loginPending}
                  className="h-11 bg-background/70"
                />
              </div>

              <Button
                type="submit"
                className="h-11 w-full gap-2 shadow-sm"
                disabled={loginPending}
              >
                {loginPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {loginPending ? "正在登录" : "登录"}
              </Button>
            </form>

            <p className="mt-7 text-center text-xs leading-5 text-muted-foreground/70">
              无法登录时，请联系管理员重置账号密码。
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

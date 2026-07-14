import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import AdminUsers from "@/pages/AdminUsers";
import { Loader2, RefreshCw } from "lucide-react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ConversationProvider } from "./contexts/ConversationContext";
import { useResumePolling } from "./hooks/useResumePolling";
import Home from "./pages/Home";
import WorkflowBoard from "./pages/WorkflowBoard";

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/login"} component={Home} />
      <Route path={"/admin/users"} component={AdminUsers} />
      <Route path={"/workflow"} component={WorkflowBoard} />
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

/**
 * Inner app shell that has access to ConversationProvider context.
 * Activates the resume-polling hook so that conversations stuck in
 * "running" state after page reload / tab switch are automatically
 * recovered.
 */
function AppShell() {
  // CRITICAL FIX: Resume polling for stuck "running" conversations
  useResumePolling();

  return (
    <Router />
  );
}

export function AuthBoundary() {
  const { user, loading, error, refresh } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          正在打开工作空间
        </div>
      </div>
    );
  }

  if (!user && error) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <div className="glass-card w-full max-w-sm rounded-2xl p-7 text-center">
          <h1 className="text-lg font-semibold">暂时无法连接服务</h1>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {error.message || "请检查网络连接后重试。"}
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />
            重新连接
          </Button>
        </div>
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <ConversationProvider>
      <AppShell />
    </ConversationProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-center" />
          <AuthBoundary />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

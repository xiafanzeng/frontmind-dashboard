import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
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
    <>
      <Toaster position="top-center" />
      <Router />
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <ConversationProvider>
            <AppShell />
          </ConversationProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

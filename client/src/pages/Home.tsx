/**
 * Home Page - Main application layout
 * Design: Fluid Glass Workspace - Glassmorphism + Spatial Design
 * Layout: Left sidebar (conversation history) + Center chat area
 * Background: Subtle gradient with generated hero image overlay
 */
import { useState, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import SettingsDialog from "@/components/SettingsDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useConversation } from "@/contexts/ConversationContext";
import { useIsMobile } from "@/hooks/useMobile";

export default function Home() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { createConversation } = useConversation();
  const isMobile = useIsMobile();

  useKeyboardShortcuts({
    onNewChat: useCallback(() => createConversation(), [createConversation]),
    onSettings: useCallback(() => setSettingsOpen(true), []),
    onToggleSidebar: useCallback(() => {
      if (!isMobile) setSidebarCollapsed((p) => !p);
    }, [isMobile]),
  });

  return (
    <div className="h-[100dvh] w-screen flex overflow-hidden relative bg-background">
      {/* Premium calm workspace background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(900px circle at 22% 12%, oklch(0.93 0.018 90 / 55%) 0%, transparent 54%),
                       radial-gradient(760px circle at 85% 8%, oklch(0.86 0.035 178 / 28%) 0%, transparent 48%),
                       linear-gradient(180deg, oklch(0.988 0.006 83) 0%, oklch(0.965 0.011 83) 100%)`,
        }}
      />

      {/* Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((p) => !p)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main content */}
      <main className="flex-1 flex flex-col relative z-10">
        <ChatArea />
      </main>

      {/* Settings dialog */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

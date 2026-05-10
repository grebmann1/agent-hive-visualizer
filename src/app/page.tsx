import ActivityModal from "../components/ActivityModal";
import AgentRoster from "../components/AgentRoster";
import ClaudeMonitorBridge from "../components/ClaudeMonitorBridge";
import ContextMenu from "../components/ContextMenu";
import EventLog from "../components/EventLog";
import HookSetupBanner from "../components/HookSetupBanner";
import Intro from "../components/Intro";
import MainSplit from "../components/MainSplit";
import ShortcutsModal from "../components/ShortcutsModal";
import StatusStrip from "../components/StatusStrip";

export default function Home() {
  return (
    <div className="h-screen overflow-hidden bg-page flex flex-col relative">
      <HookSetupBanner />
      <header className="title-strip px-4 py-2.5 flex items-center justify-between">
        <h1 className="pixel-font text-[16px] tracking-wide flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block w-[12px] h-[12px] rotate-45 bg-ink"
          />
          AGENT FORCE HQ
        </h1>
        <div className="flex items-center gap-3 text-[11px] opacity-75 border-l border-white/10 pl-3">
          <StatusStrip />
        </div>
      </header>

      <main className="flex-1 w-full mx-auto px-3 py-3 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-3 overflow-hidden">
        <MainSplit />
        <aside className="flex flex-col gap-3 min-w-0 lg:h-[calc(100vh-4.5rem)]">
          <div className="flex-1 min-h-0">
            <AgentRoster />
          </div>
          <EventLog />
        </aside>
      </main>

      <Intro />
      <ShortcutsModal />
      <ContextMenu />
      <ActivityModal />
      <ClaudeMonitorBridge />
    </div>
  );
}

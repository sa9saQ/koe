import { ActivityLog } from "./features/activity/ActivityLog";
import { ApprovalModal } from "./features/activity/ApprovalModal";
import { DevMockEmitter } from "./features/activity/DevMockEmitter";
import { useActivityEvents } from "./features/activity/useActivityEvents";
import "./App.css";

function App() {
  // Subscribe to the backend tool-event / approval / status streams for the
  // app's lifetime.
  useActivityEvents();

  return (
    <main className="koe-app">
      <h1 className="koe-app-title">koe — activity</h1>
      <ActivityLog />
      {import.meta.env.DEV && <DevMockEmitter />}
      <ApprovalModal />
    </main>
  );
}

export default App;

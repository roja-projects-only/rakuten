import { useEffect, useState } from 'react';
import { getRecentValids, getStatus } from './api.js';
import StatusCards from './components/StatusCards.jsx';
import ValidTable from './components/ValidTable.jsx';

function formatTimeAgo(ts) {
  if (!ts) return 'n/a';
  const delta = Date.now() - ts;
  if (delta < 0) return 'just now';
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function App() {
  const [statusState, setStatusState] = useState({ loading: true, data: null, error: null });
  const [validState, setValidState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    loadStatus();
    const id = setInterval(loadStatus, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadValids();
    const id = setInterval(loadValids, 30000);
    return () => clearInterval(id);
  }, []);

  async function loadStatus() {
    setStatusState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await getStatus();
      setStatusState({ loading: false, data, error: null });
    } catch (error) {
      setStatusState({ loading: false, data: null, error: error.message });
    }
  }

  async function loadValids() {
    setValidState((prev) => ({ ...prev, loading: true }));
    try {
      const data = await getRecentValids(50);
      setValidState({ loading: false, data, error: null });
    } catch (error) {
      setValidState({ loading: false, data: null, error: error.message });
    }
  }

  return (
    <div className="app-shell">
      <header>
        <div className="header-title">
          <h1>Rakuten Ops Dashboard</h1>
          <p className="subtitle">Coordinator mode: live status, worker health, and recent VALID captures</p>
        </div>
        <div className="actions">
          <span className="small">Updated {formatTimeAgo(statusState.data?.timestamp)}</span>
          <button className="refresh" onClick={() => { loadStatus(); loadValids(); }}>Refresh now</button>
        </div>
      </header>

      <StatusCards state={statusState} />

      <section className="table-card card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3>Recent VALIDs (with captures)</h3>
          <span className="small">Updated {formatTimeAgo(validState.data?.timestamp)}</span>
        </div>
        {validState.error && <div className="error-box">{validState.error}</div>}
        {validState.loading && <div className="loader">Loading latest VALIDs...</div>}
        {!validState.loading && validState.data && (
          <ValidTable hits={validState.data.hits} />
        )}
      </section>
    </div>
  );
}

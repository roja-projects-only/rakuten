function StatusChip({ label, tone = 'ok' }) {
  const toneClass = tone === 'ok' ? 'status-ok' : tone === 'warn' ? 'status-warn' : 'status-bad';
  return <span className={`status-chip ${toneClass}`}>{label}</span>;
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export default function StatusCards({ state }) {
  const { loading, data, error } = state || {};

  const coordinator = data?.coordinator;
  const pow = data?.powService;

  const coordTone = coordinator?.error ? 'bad' : 'ok';
  const powTone = pow?.health?.error || pow?.stats?.error ? 'bad' : 'ok';

  return (
    <div className="card-grid">
      <div className="card">
        <h3>Coordinator</h3>
        {error && <div className="error-box">{error}</div>}
        {loading && <div className="loader">Loading...</div>}
        {!loading && (
          <>
            <StatusChip label={coordinator?.error ? 'Unreachable' : 'Online'} tone={coordTone} />
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <Metric label="Active workers" value={coordinator?.data?.activeWorkers ?? '–'} />
              <Metric label="Queue depth" value={coordinator?.data?.queueDepth ?? '–'} />
              <div className="small">Uptime: {coordinator?.data?.uptimeSeconds ? `${Math.round(coordinator.data.uptimeSeconds / 3600)}h` : 'n/a'}</div>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>pow-service</h3>
        {error && <div className="error-box">{error}</div>}
        {loading && <div className="loader">Loading...</div>}
        {!loading && (
          <>
            <StatusChip label={pow?.health?.status === 'ok' ? 'Healthy' : pow?.health ? 'Degraded' : 'Unknown'} tone={powTone} />
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <Metric label="Cache hit rate" value={pow?.stats?.cacheHitRate != null ? `${Math.round(pow.stats.cacheHitRate * 100)}%` : '–'} />
              <Metric label="Req/min" value={pow?.stats?.requestsPerMinute ?? '–'} />
              <div className="small">Workers: {pow?.stats?.workerPoolSize ?? 'n/a'}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

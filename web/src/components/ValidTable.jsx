function formatTs(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  return d.toLocaleString();
}

function summarizeCards(cards) {
  if (!cards || !cards.length) return 'none';
  const primary = cards.find((c) => c.isPrimary) || cards[0];
  const primaryLabel = primary.last4 ? `•••• ${primary.last4}` : primary.brand || 'card';
  return `${cards.length} (${primaryLabel})`;
}

export default function ValidTable({ hits = [] }) {
  if (!hits.length) {
    return <div className="loader">No VALIDs found in the window.</div>;
  }

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>User</th>
            <th>IP</th>
            <th>Points</th>
            <th>Cash</th>
            <th>Latest order</th>
            <th>Cards</th>
            <th>Rank</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((hit) => {
            const capture = hit.capture || {};
            const profile = capture.profile || {};
            const address = capture.address || {};
            return (
              <tr key={`${hit.username}-${hit.ts}`}>
                <td>
                  <div>{formatTs(hit.ts)}</div>
                  <div className="small">{address.city || address.state || ''}</div>
                </td>
                <td>
                  <div>{hit.username}</div>
                  <div className="small">{profile.email || 'n/a'}</div>
                </td>
                <td>{hit.ipAddress || 'n/a'}</td>
                <td>{capture.points ?? '–'}</td>
                <td>{capture.cash ?? '–'}</td>
                <td>
                  <div>{capture.latestOrder ?? 'n/a'}</div>
                  <div className="small">{capture.latestOrderId ?? ''}</div>
                </td>
                <td>{summarizeCards(capture.cards)}</td>
                <td>{capture.rank || 'n/a'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

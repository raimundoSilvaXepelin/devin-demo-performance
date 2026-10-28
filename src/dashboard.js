// GET /api/workspaces/:id/dashboard — the customer-facing overview page.
// Aggregates in SQLite with two queries answered from idx_events_dashboard, instead of
// loading every event row of every project into JS.
const { PLAN_EXPR } = require('./db');

const statements = new WeakMap();

function prepare(db) {
  let s = statements.get(db);
  if (!s) {
    s = {
      projects: db.prepare(`
        SELECT p.id, p.name,
               COUNT(e.id) AS events,
               COUNT(DISTINCT e.user_id) + MAX(e.id IS NOT NULL AND e.user_id IS NULL) AS uniqueUsers,
               TOTAL(${PLAN_EXPR.replace(/props/g, 'e.props')} = 'pro') AS proEvents
        FROM projects p
        LEFT JOIN events e ON e.project_id = p.id AND e.ts >= ?
        WHERE p.workspace_id = ?
        GROUP BY p.id
        ORDER BY p.id`),
      names: db.prepare(`
        SELECT e.project_id AS projectId, e.name, COUNT(*) AS count
        FROM projects p
        JOIN events e ON e.project_id = p.id AND e.ts >= ?
        WHERE p.workspace_id = ?
        GROUP BY e.project_id, e.name`),
    };
    statements.set(db, s);
  }
  return s;
}

function dashboard(db, workspaceId, sinceMs) {
  const s = prepare(db);
  const namesByProject = new Map();
  for (const r of s.names.all(sinceMs, workspaceId)) {
    let list = namesByProject.get(r.projectId);
    if (!list) namesByProject.set(r.projectId, (list = []));
    list.push([String(r.name), r.count]);
  }
  return s.projects.all(sinceMs, workspaceId).map((p) => {
    const topEvents = (namesByProject.get(p.id) || [])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));
    return { projectId: p.id, name: p.name, events: p.events, uniqueUsers: p.uniqueUsers, proEvents: p.proEvents, topEvents };
  });
}

module.exports = { dashboard };

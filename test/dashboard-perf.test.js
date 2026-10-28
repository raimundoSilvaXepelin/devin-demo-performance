// Guards against the dashboard regressing to per-project queries (N+1)
// or full scans of `events`, and checks results stay identical to the original JS aggregation.
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../src/db');
const { dashboard } = require('../src/dashboard');

function referenceDashboard(db, workspaceId, sinceMs) {
  const projects = db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY id').all(workspaceId);
  return projects.map((p) => {
    const events = db.prepare('SELECT * FROM events WHERE project_id = ? AND ts >= ?').all(p.id, sinceMs);
    const byName = {};
    const users = new Set();
    let proEvents = 0;
    for (const e of events) {
      byName[e.name] = (byName[e.name] || 0) + 1;
      users.add(e.user_id);
      if (JSON.parse(e.props).plan === 'pro') proEvents++;
    }
    const topEvents = Object.entries(byName)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));
    return { projectId: p.id, name: p.name, events: events.length, uniqueUsers: users.size, proEvents, topEvents };
  });
}

function bigFixture(projectsPerWorkspace) {
  const db = openDb(':memory:');
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const names = ['page_view', 'Page_view', 'signup', 'checkout', 'search', 'share'];
  const insP = db.prepare('INSERT INTO projects (id, workspace_id, name) VALUES (?, ?, ?)');
  const insE = db.prepare('INSERT INTO events (project_id, name, user_id, ts, props) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let w = 1; w <= 3; w++) for (let p = 1; p <= projectsPerWorkspace; p++) insP.run((w - 1) * projectsPerWorkspace + p, w, `P${w}-${p}`);
    // last project of each workspace has no events
    for (let i = 0; i < 5000; i++) {
      const w = 1 + Math.floor(rnd() * 3);
      const p = (w - 1) * projectsPerWorkspace + 1 + Math.floor(rnd() * (projectsPerWorkspace - 1));
      const user = rnd() < 0.02 ? null : Math.floor(rnd() * 300);
      insE.run(p, names[Math.floor(rnd() * names.length)], user, Math.floor(rnd() * 1000), JSON.stringify({ plan: rnd() < 0.3 ? 'pro' : 'free' }));
    }
  })();
  return db;
}

function traced(db) {
  const executed = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    for (const m of ['all', 'get', 'run', 'iterate']) {
      const fn = stmt[m].bind(stmt);
      stmt[m] = (...args) => (executed.push({ sql, args }), fn(...args));
    }
    return stmt;
  };
  return { executed, prepare };
}

test('matches the original per-row aggregation', () => {
  const db = bigFixture(8);
  for (const w of [1, 2, 3, 99]) for (const since of [0, 500, 2000]) {
    assert.deepStrictEqual(dashboard(db, w, since), referenceDashboard(db, w, since), `workspace ${w} since ${since}`);
  }
});

test('uses a constant number of indexed queries regardless of project count', () => {
  for (const projects of [4, 40]) {
    const db = bigFixture(projects);
    const { executed, prepare } = traced(db);
    dashboard(db, 1, 0);
    dashboard(db, 2, 500);
    assert.strictEqual(executed.length, 4, `expected 2 queries per request with ${projects} projects, got ${executed.length / 2}`);
    for (const { sql, args } of executed) {
      const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail);
      assert.ok(!plan.some((d) => /^SCAN (events|e)\b/.test(d)), `full scan of events:\n${sql}\n${plan.join('\n')}`);
      assert.ok(plan.some((d) => /USING (COVERING )?INDEX idx_events_dashboard/.test(d)), `idx_events_dashboard not used:\n${sql}\n${plan.join('\n')}`);
    }
  }
});

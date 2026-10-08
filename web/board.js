// Live board. Polls /api/board every 2 seconds. Every piece of user or model text is rendered
// with textContent, never innerHTML.
(() => {
  const POLL_MS = 2000;
  const $ = (id) => document.getElementById(id);

  const CATEGORY_LABELS = {
    friday_deploy: 'Friday deploy',
    no_backups: 'No backups',
    leaked_secret: 'Leaked secret',
    prod_is_test: 'Prod is test',
    spreadsheet_as_database: 'Spreadsheet DB',
    mystery_cron_job: 'Mystery cron job',
    rm_rf_moment: 'rm -rf moment',
    it_was_dns: 'It was DNS',
    other: 'Other',
  };
  const REASON_LABELS = {
    empty: 'Empty or unreadable',
    moderation_blocked: 'Blocked by moderation',
    invalid_model_output: 'Model output rejected',
    too_long: 'Too long',
    other: 'Pipeline error',
    removed: 'Removed by presenter',
    not_a_story: 'Not a story',
  };

  // ---------- Presenter key: passed once as board.html#key=..., kept for this tab only ----------
  let presenterKey = null;
  try {
    const m = /(?:^|[#&])key=([^&]+)/.exec(location.hash);
    if (m) {
      sessionStorage.setItem('ths-presenter', decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }
    presenterKey = sessionStorage.getItem('ths-presenter');
  } catch {
    /* storage blocked: postmortem stays hidden */
  }
  if (presenterKey) $('presenter').hidden = false;

  // ---------- Helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtCost = (n) => {
    const v = Number(n || 0);
    return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));
  };
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const label = (c) => CATEGORY_LABELS[c] || 'Other';

  // ---------- Tabs ----------
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function showTab(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      $('view-' + t.dataset.tab).hidden = !on;
    }
    try { localStorage.setItem('ths-tab', name); } catch { /* ignore */ }
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  try {
    const wanted = new URLSearchParams(location.search).get('tab') || localStorage.getItem('ths-tab');
    if (wanted && $('view-' + wanted)) showTab(wanted);
  } catch { /* ignore */ }

  // ---------- Rendering ----------
  let selectedId = null;
  const seenFeed = new Set();
  const seenGraves = new Set();
  let firstRender = true;

  function storyCard(s, opts = {}) {
    const li = el('li', 'card');
    li.dataset.id = s.id;
    if (opts.rank) li.append(el('div', 'rank', opts.rank));
    const fear = el('div', 'fear' + (s.fear_level >= 8 ? ' hot' : ''));
    fear.append(el('span', 'n', s.fear_level), el('span', 'of', 'fear'));
    li.append(fear);
    li.append(el('p', 'headline', s.one_liner));
    const meta = el('div', 'meta');
    meta.append(el('span', 'badge', label(s.category)));
    if (s.root_cause) meta.append(el('span', '', 'Root cause: ' + s.root_cause));
    meta.append(el('span', '', s.survivable ? 'Survivable' : 'Not survivable'));
    li.append(meta);
    if (s.text) li.append(el('p', 'story', s.text));
    if (presenterKey) {
      li.classList.add('selectable');
      li.title = 'Select for postmortem';
      if (s.id === selectedId) li.classList.add('selected');
      li.addEventListener('click', () => selectStory(s.id === selectedId ? null : s.id));
    }
    return li;
  }

  function selectStory(id) {
    selectedId = id;
    $('pm-id').value = id || '';
    document.querySelectorAll('.card.selectable').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  }

  function renderFeed(feed) {
    const list = $('feed');
    const frag = document.createDocumentFragment();
    for (const s of feed) {
      const card = storyCard(s);
      if (!seenFeed.has(s.id) && !firstRender) card.classList.add('new');
      seenFeed.add(s.id);
      frag.append(card);
    }
    list.replaceChildren(frag);
    $('feed-empty').hidden = feed.length > 0;
  }

  function renderLeaders(top, categories) {
    $('podium').replaceChildren(...top.map((s, i) => storyCard(s, { rank: i + 1 })));
    if (top.length === 0) $('podium').append(el('li', 'empty', 'No scores yet.'));

    // Single-series horizontal bars, sorted by count, values labeled directly.
    const rows = Object.entries(categories).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const chart = $('chart');
    const existing = new Map(Array.from(chart.children).map((r) => [r.dataset.cat, r]));
    const ordered = rows.map(([cat, n]) => {
      let row = existing.get(cat);
      if (!row) {
        row = el('div', 'bar-row');
        row.dataset.cat = cat;
        row.setAttribute('role', 'row');
        const lab = el('span', 'bar-label', label(cat));
        lab.setAttribute('role', 'rowheader');
        const track = el('div', 'bar-track');
        track.append(el('div', 'bar'));
        const val = el('span', 'bar-value');
        val.setAttribute('role', 'cell');
        row.append(lab, track, val);
      }
      row.querySelector('.bar').style.width = (n / max) * 100 + '%';
      row.querySelector('.bar-value').textContent = n;
      row.title = `${label(cat)}: ${n} ${n === 1 ? 'story' : 'stories'}`;
      return row;
    });
    chart.replaceChildren(...ordered);
  }

  function renderGraveyard(graves) {
    const frag = document.createDocumentFragment();
    for (const g of graves) {
      const li = el('li', 'grave');
      if (!seenGraves.has(g.id) && !firstRender) li.classList.add('new');
      seenGraves.add(g.id);
      const why = el('div', 'why');
      why.append(el('span', 'reason', REASON_LABELS[g.reason] || 'Pipeline error'));
      if (g.quip) why.append(el('span', 'quip', g.quip));
      li.append(why);
      if (g.reason === 'moderation_blocked' || g.reason === 'removed' || g.reason === 'not_a_story') {
        li.append(el('span', 'text redacted', 'Story redacted'));
      } else if (g.text) {
        li.append(el('span', 'text', g.text));
      } else {
        li.append(el('span', 'text redacted', g.reason === 'empty' ? '(nothing readable)' : '(text withheld)'));
      }
      const t = el('time', '', fmtTime(g.createdAt));
      t.dateTime = g.createdAt;
      li.append(t);
      frag.append(li);
    }
    $('graveyard').replaceChildren(frag);
    $('grave-empty').hidden = graves.length > 0;
    $('grave-count').textContent = graves.length;
  }

  function renderCounter(totals, inFlight) {
    $('c-stories').textContent = fmtInt(totals.stories);
    $('c-in').textContent = fmtInt(totals.input_tokens);
    $('c-out').textContent = fmtInt(totals.output_tokens);
    $('c-cost').textContent = fmtCost(totals.cost_usd);
    $('c-running').textContent = inFlight > 0 ? `Currently running: ${inFlight} in flight` : 'Currently running: nothing';
    $('c-dot').className = 'dot' + (inFlight > 0 ? ' busy' : '');
  }

  // ---------- Polling ----------
  let failures = 0;
  async function poll() {
    try {
      const res = await fetch('/api/board', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      renderFeed(data.feed || []);
      renderLeaders(data.leaderboard || [], data.categories || {});
      renderGraveyard(data.graveyard || []);
      renderCounter(data.totals || {}, data.inFlight || 0);
      $('replay-badge').hidden = !data.replay;
      firstRender = false;
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= 3) {
        $('c-dot').className = 'dot stale';
        $('c-running').textContent = 'Reconnecting...';
      }
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }
  poll();

  // ---------- Postmortem ----------
  const panel = $('pm-panel');
  let pmTimer = null;

  // Minimal, safe markdown: ## headings, bullet and numbered lists, paragraphs. Asterisks dropped.
  function renderMarkdown(md, into) {
    into.replaceChildren();
    let list = null;
    for (const raw of md.split('\n')) {
      const line = raw.trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^\*(?!\s)|(?<!\s)\*$/g, '');
      if (!line) { list = null; continue; }
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) {
        list = null;
        into.append(el('h3', '', h[1]));
      } else if (li) {
        if (!list) { list = el('ul'); into.append(list); }
        list.append(el('li', '', li[1]));
      } else {
        list = null;
        into.append(el('p', '', line));
      }
    }
  }

  function showPostmortem(data) {
    panel.hidden = false;
    $('pm-title').textContent = data.one_liner || 'Incident';
    const body = $('pm-body');
    if (data.status === 'done' && data.postmortem) {
      renderMarkdown(data.postmortem, body);
      $('pm-meta').textContent = `${label(data.category)} · fear ${data.fear_level}/10 · story ${data.storyId}`;
    } else if (data.status === 'blocked') {
      body.replaceChildren(el('p', 'waiting', 'The postmortem failed its own moderation review. Try another story.'));
      $('pm-meta').textContent = '';
    } else if (data.status === 'error') {
      body.replaceChildren(el('p', 'waiting', 'The postmortem writer had its own incident. Try again.'));
    } else {
      body.replaceChildren(el('p', 'waiting', 'Writing the postmortem. Nobody is being blamed...'));
      $('pm-meta').textContent = '';
    }
  }

  function stopPolling() {
    if (pmTimer) clearTimeout(pmTimer);
    pmTimer = null;
  }

  async function pollPostmortem(id) {
    try {
      const res = await fetch('/api/postmortem/' + encodeURIComponent(id), { cache: 'no-store' });
      const data = await res.json();
      showPostmortem(data);
      if (data.status === 'pending' && !panel.hidden) pmTimer = setTimeout(() => pollPostmortem(id), 2000);
    } catch {
      pmTimer = setTimeout(() => pollPostmortem(id), 3000);
    }
  }

  async function startPostmortem(fresh) {
    const btn = $('pm-go');
    btn.disabled = true;
    stopPolling();
    try {
      const id = $('pm-id').value.trim();
      const res = await fetch('/api/postmortem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-presenter-key': presenterKey },
        body: JSON.stringify({ storyId: id || undefined, fresh: Boolean(fresh) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        panel.hidden = false;
        $('pm-title').textContent = 'Postmortem unavailable';
        $('pm-body').replaceChildren(el('p', 'waiting', data.message || `Error ${res.status}`));
        $('pm-meta').textContent = '';
        return;
      }
      showPostmortem(data);
      if (data.status !== 'done') pmTimer = setTimeout(() => pollPostmortem(data.storyId), 2000);
    } finally {
      btn.disabled = false;
    }
  }

  function closePanel() {
    panel.hidden = true;
    stopPolling();
  }

  $('pm-go').addEventListener('click', (e) => startPostmortem(e.shiftKey));
  $('pm-close').addEventListener('click', closePanel);
  panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });

  // Keyboard: 1/2/3 switch tabs, P runs the postmortem, Esc closes it.
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') closePanel();
    if (e.key === '1') showTab('feed');
    if (e.key === '2') showTab('leaders');
    if (e.key === '3') showTab('graveyard');
    if ((e.key === 'p' || e.key === 'P') && presenterKey) startPostmortem(e.shiftKey);
  });
})();

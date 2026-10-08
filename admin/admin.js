// Local presenter admin. All text rendered with textContent.
(() => {
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (id) => document.getElementById(id);
  const REASONS = {
    empty: 'Empty or unreadable',
    moderation_blocked: 'Blocked by moderation',
    invalid_model_output: 'Model output rejected',
    too_long: 'Too long',
    other: 'Pipeline error',
    removed: 'Removed by you',
    not_a_story: 'Not a story',
  };
  // Mirrors the board: these reasons never show text there.
  const HIDDEN = new Set(['moderation_blocked', 'removed', 'not_a_story']);
  let submissionsOpen = true;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  const time = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  function say(text, err) {
    $('msg').textContent = text;
    $('msg').className = 'msg' + (err ? ' err' : '');
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-admin-token': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Error ${res.status}`);
    return data;
  }

  function actionButton(label, cls, path, id, done) {
    const b = el('button', 'btn ' + cls, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(path, { id });
        say(`${done}: ${id} (${r.result})`);
        await refresh();
      } catch (e) {
        say(e.message, true);
        b.disabled = false;
      }
    });
    return b;
  }

  function emptyRow(tbody, text) {
    const tr = el('tr', 'empty');
    const td = el('td', '', text);
    td.colSpan = 4;
    tr.append(td);
    tbody.replaceChildren(tr);
  }

  function render(s) {
    submissionsOpen = s.submissionsOpen;
    $('subs').textContent = `Submissions: ${s.submissionsOpen ? 'OPEN' : 'CLOSED'}`;
    $('subs').className = 'subs ' + (s.submissionsOpen ? 'open' : 'closed');
    $('toggle').textContent = s.submissionsOpen ? 'Close submissions' : 'Reopen submissions';
    $('toggle').className = 'btn ' + (s.submissionsOpen ? 'danger' : 'go');
    $('board').href = s.boardUrl || '#';

    $('pub-count').textContent = s.published.length;
    const pub = $('published');
    if (!s.published.length) emptyRow(pub, 'Nothing on the board yet.');
    else
      pub.replaceChildren(
        ...s.published.map((r) => {
          const tr = el('tr');
          tr.append(el('td', 'fear', r.fear_level));
          const main = el('td');
          main.append(el('div', 'headline', r.one_liner), el('div', 'story', r.text));
          tr.append(main, el('td', 'time', time(r.createdAt)));
          const act = el('td', 'act');
          act.append(actionButton('Bury', 'danger', '/api/bury', r.id, 'Buried'));
          tr.append(act);
          return tr;
        }),
      );

    $('grave-count').textContent = s.graveyard.length;
    const grave = $('graveyard');
    if (!s.graveyard.length) emptyRow(grave, 'Nothing buried.');
    else
      grave.replaceChildren(
        ...s.graveyard.map((r) => {
          const tr = el('tr');
          const why = el('td', 'reason' + (r.reason === 'removed' ? ' removed' : ''), REASONS[r.reason] || r.reason);
          if (r.detail) why.append(el('div', 'detail', r.detail));
          if (r.quip) why.append(el('div', 'quip', r.quip));
          tr.append(why);
          const textCell = el('td');
          if (HIDDEN.has(r.reason) || !r.text) textCell.append(el('span', 'hidden-text', HIDDEN.has(r.reason) ? 'Hidden on the board' : '(empty)'));
          else textCell.textContent = r.text;
          tr.append(textCell, el('td', 'time', time(r.createdAt)));
          const act = el('td', 'act');
          if (r.reason === 'removed') act.append(actionButton('Restore', 'go', '/api/restore', r.id, 'Restored'));
          else if (r.text) act.append(actionButton('Hide text', 'danger', '/api/bury', r.id, 'Hidden'));
          tr.append(act);
          return tr;
        }),
      );
  }

  async function refresh() {
    try {
      render(await api('/api/state'));
    } catch (e) {
      say(e.message, true);
    }
  }

  $('toggle').addEventListener('click', async () => {
    const want = !submissionsOpen;
    try {
      await api('/api/submissions', { open: want });
      say(want ? 'Submissions reopened.' : 'Submissions closed. Phones now see "Submissions closed".');
      await refresh();
    } catch (e) {
      say(e.message, true);
    }
  });

  if (!token) say('Missing admin token. Open the URL printed by npm run admin.', true);
  refresh();
  setInterval(refresh, 3000);
})();

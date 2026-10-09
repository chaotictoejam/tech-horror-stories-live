(() => {
  const MAX = 280;
  const COOLDOWN = 20;
  const form = document.getElementById('form');
  const story = document.getElementById('story');
  const count = document.getElementById('count');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const watch = document.getElementById('watch');
  let cooling = 0;
  let busy = false;

  // A random id kept on this phone so the cooldown is per device, not per shared Wi-Fi IP.
  function deviceId() {
    try {
      let id = localStorage.getItem('ths-device');
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('ths-device', id);
      }
      return id;
    } catch {
      return undefined;
    }
  }

  function say(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }

  function refresh() {
    const n = story.value.length;
    count.textContent = `${n} / ${MAX}`;
    count.classList.toggle('near', n > MAX - 30);
    send.disabled = busy || cooling > 0 || story.value.trim().length === 0;
    send.textContent = cooling > 0 ? `Wait ${cooling}s` : busy ? 'Sending...' : 'Submit';
  }

  function startCooldown(seconds) {
    cooling = seconds;
    refresh();
    const t = setInterval(() => {
      cooling -= 1;
      refresh();
      if (cooling <= 0) clearInterval(t);
    }, 1000);
  }

  story.addEventListener('input', refresh);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (send.disabled) return;
    busy = true;
    refresh();
    say('');
    try {
      const payload = JSON.stringify({ text: story.value.slice(0, MAX), deviceId: deviceId() });
      // Retry quietly on server hiccups (a room-wide burst can briefly throttle the backend).
      let res;
      let body = {};
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) {
          say('Busy room. Retrying...', '');
          await new Promise((r) => setTimeout(r, 1500 * attempt + Math.random() * 1000));
        }
        try {
          res = await fetch('/api/stories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
          body = await res.json().catch(() => ({}));
        } catch {
          res = undefined;
          continue;
        }
        const killSwitch = res.status === 503 && body.message === 'Submissions closed';
        if (res.status < 500 || killSwitch) break;
      }
      if (!res) {
        say('Could not reach the server. Try again in a moment.', 'err');
      } else if (res.status === 202) {
        story.value = '';
        say('Received. Watch the board.', 'ok');
        // Only offered after a submit, so the link does not pull people away before they write.
        watch.hidden = false;
        startCooldown(COOLDOWN);
      } else if (res.status === 429) {
        say(body.message || 'Slow down a little.', 'err');
        startCooldown(Number(res.headers.get('retry-after')) || COOLDOWN);
      } else if (res.status === 503 && body.message === 'Submissions closed') {
        say('Submissions are closed. Thanks for playing.', 'err');
      } else if (res.status >= 500) {
        say('The server is swamped. Try again in a few seconds.', 'err');
      } else {
        say(body.message || `Something went wrong (${res.status}).`, 'err');
      }
    } finally {
      busy = false;
      refresh();
    }
  });

  refresh();
})();

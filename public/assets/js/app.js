(function () {
  var volunteers = [];
  var lastResponseTime = null;
  var responseCount = 0;
  var pollTimer = null;

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function getToken() { return localStorage.getItem('catsnip_token'); }
  function setToken(t) { localStorage.setItem('catsnip_token', t); }
  function clearToken() { localStorage.removeItem('catsnip_token'); }

  function syncNav(view) {
    qsa('.nav-link').forEach(function (l) {
      l.ariaSelected = l.dataset.view === view ? 'true' : 'false';
    });
  }

  function showView(name) {
    qsa('.view').forEach(function (v) { hide(v); });
    var target = document.getElementById('view-' + name);
    if (target) show(target);
    syncNav(name);
  }

  function handleRoute() {
    var view = location.hash.slice(1) || 'compose';
    showView(view);
    if (view === 'history') loadHistory();
    if (view === 'volunteers') loadVolunteers();
    if (view === 'settings') loadSettings();
    if (view === 'compose') startPolling();
    else stopPolling();
  }

  window.addEventListener('hashchange', handleRoute);

  qsa('.nav-link').forEach(function (link) {
    link.addEventListener('click', function () {
      var view = this.dataset.view;
      if (view) location.hash = view;
    });
  });

  function formatPhone(num) {
    var s = num.replace(/\D/g, '');
    if (s.length === 11) return '+' + s;
    if (s.length === 10) return '+1' + s;
    return num;
  }

  function authHeaders() {
    var t = getToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  async function api(method, url, body) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, authHeaders());
    var opts = { method: method, headers: h };
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(url, opts);
    if (res.status === 401) {
      clearToken();
      location.hash = 'login';
      throw new Error('Session expired');
    }
    if (!res.ok) {
      var data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || 'Request failed');
    }
    return res.json();
  }

  async function loadVolunteers() {
    var wrap = document.getElementById('volunteerTableWrap');
    try {
      volunteers = await api('GET', '/api/volunteers');
      renderVolunteerTable();
      updateVolunteerSelect();
    } catch (e) {
      wrap.innerHTML = '<div class="empty-state">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  function renderVolunteerTable() {
    var wrap = document.getElementById('volunteerTableWrap');
    if (volunteers.length === 0) {
      wrap.innerHTML = '<div class="empty-state">No volunteers yet. Add one above.</div>';
      return;
    }
    var html = '<table class="volunteer-table"><thead><tr><th>Name</th><th>Phone</th><th>Since</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < volunteers.length; i++) {
      var v = volunteers[i];
      var date = v.created_at ? new Date(v.created_at).toLocaleDateString() : '\u2014';
      html += '<tr><td><strong>' + esc(v.name) + '</strong></td><td>' + esc(v.phone) + '</td><td class="vol-since">' + date + '</td>' +
        '<td><button class="btn btn-danger" data-remove="' + v.id + '" style="padding:4px 12px;font-size:var(--text-xs)">Remove</button></td></tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    qsa('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeVolunteer(btn.dataset.remove); });
    });
  }

  function updateVolunteerSelect() {
    var container = document.getElementById('volunteerSelect');
    if (!container) return;
    if (volunteers.length === 0) {
      container.innerHTML = '<p class="empty-state">No volunteers yet.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < volunteers.length; i++) {
      var v = volunteers[i];
      html += '<label class="volunteer-check-item"><input type="checkbox" value="' + v.id + '">' +
        '<span>' + esc(v.name) + ' <span class="vol-since">(' + esc(v.phone) + ')</span></span></label>';
    }
    container.innerHTML = html;
  }

  async function addVolunteer(e) {
    e.preventDefault();
    var name = document.getElementById('volName').value.trim();
    var phone = formatPhone(document.getElementById('volPhone').value.trim());
    if (!name || !phone) return;
    try {
      await api('POST', '/api/volunteers', { name: name, phone: phone });
      document.getElementById('volName').value = '';
      document.getElementById('volPhone').value = '';
      await loadVolunteers();
    } catch (e) {
      alert(e.message);
    }
  }

  async function removeVolunteer(id) {
    if (!confirm('Remove this volunteer?')) return;
    try {
      await api('DELETE', '/api/volunteers/' + id);
      await loadVolunteers();
    } catch (e) {
      alert(e.message);
    }
  }

  async function loadHistory() {
    var list = document.getElementById('historyList');
    try {
      var messages = await api('GET', '/api/messages');
      renderHistory(messages);
    } catch (e) {
      list.innerHTML = '<div class="empty-state">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  function renderHistory(messages) {
    var list = document.getElementById('historyList');
    if (messages.length === 0) {
      list.innerHTML = '<div class="empty-state">No messages sent yet. <a href="#compose">Send one now.</a></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var date = new Date(m.sent_at).toLocaleString();
      var pct = m.recipient_count > 0 ? Math.round((m.delivered_count / m.recipient_count) * 100) : 0;
      var plural = m.response_count === 1 ? 'reply' : 'replies';
      html += '<div class="history-card" data-msg-id="' + m.id + '">' +
        '<div class="history-card-top">' +
        '<div class="history-body">' + esc(m.body) + '</div>' +
        '<span class="history-badge sent">' + pct + '%</span></div>' +
        '<div class="history-meta">' +
        '<span>' + date + '</span><span>\u00b7</span>' +
        '<span>' + m.recipient_count + ' recipients</span>';
      if (m.response_count > 0) {
        html += '<span>\u00b7 <span class="history-badge responses">' + m.response_count + ' ' + plural + '</span></span>';
      }
      html += '</div></div>';
    }
    list.innerHTML = html;
    qsa('.history-card').forEach(function (card) {
      card.addEventListener('click', function () { openDetail(card.dataset.msgId); });
    });
  }

  async function openDetail(id) {
    var modal = document.getElementById('detailModal');
    var body = document.getElementById('modalBody');
    document.getElementById('modalTitle').textContent = 'Message Details';
    try {
      var data = await api('GET', '/api/messages/' + id);
      var html = '<div class="detail-section"><div class="detail-label">Message</div>' +
        '<div class="detail-message">' + esc(data.body) + '</div></div>' +
        '<div class="detail-section"><div class="detail-label">Sent ' + new Date(data.sent_at).toLocaleString() + '</div></div>';

      if (data.responses && data.responses.length > 0) {
        html += '<div class="detail-section"><div class="detail-label">Replies (' + data.responses.length + ')</div>';
        for (var r = 0; r < data.responses.length; r++) {
          var resp = data.responses[r];
          html += '<div class="detail-response">' +
            '<span><span class="from">' + esc(resp.name) + '</span>: <span class="body">' + esc(resp.body) + '</span></span>' +
            '<span class="time">' + new Date(resp.received_at).toLocaleString() + '</span></div>';
        }
        html += '</div>';
      } else {
        html += '<div class="detail-section"><div class="detail-label">Replies</div><p class="empty-state">No replies yet.</p></div>';
      }

      if (data.deliveries && data.deliveries.length > 0) {
        html += '<div class="detail-section"><div class="detail-label">Delivery (' + data.deliveries.length + ')</div>';
        for (var d = 0; d < data.deliveries.length; d++) {
          var del = data.deliveries[d];
          var cls = del.status === 'delivered' ? 'delivered' : (del.status === 'failed' ? 'failed' : 'sent');
          html += '<div class="detail-response"><span class="from">' + esc(del.name) + '</span>' +
            '<span class="history-badge ' + cls + '">' + del.status + '</span></div>';
        }
        html += '</div>';
      }

      body.innerHTML = html;
      show(modal);
    } catch (e) {
      body.innerHTML = '<p class="empty-state">Error: ' + esc(e.message) + '</p>';
      show(modal);
    }
  }

  async function sendMessage() {
    var bodyEl = document.getElementById('messageBody');
    var body = bodyEl.value.trim();
    if (!body) { alert('Enter a message.'); return; }

    var btn = document.getElementById('sendBtn');
    btn.disabled = true;
    btn.innerHTML = 'Sending\u2026';

    var recipientMode = qs('input[name="recipients"]:checked').value;
    var volunteerIds = null;
    if (recipientMode === 'select') {
      volunteerIds = qsa('#volunteerSelect input[type="checkbox"]:checked').map(function (cb) { return parseInt(cb.value); });
      if (volunteerIds.length === 0) {
        alert('Select at least one volunteer.');
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="send" class="btn-icon"></i> Send Message';
        lucide.createIcons();
        return;
      }
    }

    var result = document.getElementById('sendResult');
    try {
      var data = await api('POST', '/api/messages', { body: body, volunteerIds: volunteerIds });
      result.className = 'send-result success';
      result.innerHTML = 'Sent to ' + data.sent + ' volunteer' + (data.sent === 1 ? '' : 's') +
        (data.failed > 0 ? ' (' + data.failed + ' failed)' : '') + '.';
      show(result);
      bodyEl.value = '';
      document.getElementById('charCount').textContent = '0';
      pollResponses();
    } catch (e) {
      result.className = 'send-result error';
      result.textContent = e.message;
      show(result);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="send" class="btn-icon"></i> Send Message';
      lucide.createIcons();
    }
  }

  function timeAgo(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins === 1) return '1m ago';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs === 1) return '1h ago';
    return hrs + 'h ago';
  }

  async function pollResponses() {
    try {
      var url = '/api/responses';
      if (lastResponseTime) url += '?since=' + encodeURIComponent(lastResponseTime);
      var responses = await api('GET', url);
      if (responses.length > 0) {
        lastResponseTime = responses[0].received_at;
        renderResponses(responses);
      }
    } catch (e) {}
  }

  function renderResponses(responses) {
    var feed = document.getElementById('responseFeed');
    var pulse = document.getElementById('responsePulse');
    if (!feed) return;

    if (responses.length === 0) {
      feed.innerHTML = '<div class="empty-state">No replies yet. Send a message to get started.</div>';
      pulse.textContent = 'Waiting for replies\u2026';
      return;
    }

    var newCount = 0;
    var html = '';
    for (var i = 0; i < responses.length; i++) {
      var r = responses[i];
      var isNew = responseCount > 0 && i === 0;
      if (isNew) newCount++;
      html += '<div class="response-card' + (isNew ? ' new' : '') + '">' +
        '<div class="response-header">' +
        '<span class="response-name">' + esc(r.name) + '</span>' +
        '<span class="response-time">' + timeAgo(r.received_at) + '</span></div>' +
        '<div class="response-body">' + esc(r.body) + '</div>';
      if (r.message_body) {
        html += '<div class="response-reply-to">\u2192 re: \u201c' + esc(r.message_body) + '\u201d</div>';
      }
      html += '</div>';
    }
    feed.innerHTML = html;
    responseCount = responses.length;

    if (newCount > 0) {
      pulse.innerHTML = '<span class="response-pulse"><span class="pulse-dot"></span> ' + newCount + ' new reply' + (newCount > 1 ? 's' : '') + '</span>';
    } else {
      pulse.textContent = responses.length + ' total replies';
    }

    if (newCount > 0 && (!location.hash || location.hash === '#compose')) {
      feed.scrollTop = 0;
    }
  }

  function startPolling() {
    stopPolling();
    pollResponses();
    pollTimer = setInterval(pollResponses, 4000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function loadSettings() {
    var webhookEl = document.getElementById('webhookUrl');
    if (webhookEl) {
      webhookEl.textContent = window.location.origin + '/api/incoming-sms';
    }
    try {
      var s = await api('GET', '/api/status');
      var ps = document.getElementById('providerStatus');
      var pp = document.getElementById('providerPhone');
      if (ps) ps.textContent = s.sms ? 'Connected (Vonage)' : 'Not configured';
      if (pp) pp.textContent = s.sms ? 'See .env' : '—';
    } catch (e) {}
  }

  async function login(e) {
    e.preventDefault();
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    var btn = document.getElementById('loginBtn');
    var err = document.getElementById('loginError');
    btn.disabled = true;
    btn.textContent = 'Signing in\u2026';
    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password }),
      });
      if (!res.ok) throw new Error('Invalid username or password');
      var data = await res.json();
      setToken(data.token);
      showApp();
    } catch (e) {
      err.textContent = e.message;
      err.className = 'send-result error';
      show(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  function showLoggedIn(yes) {
    var els = qsa('.nav-links, #logoutBtn');
    for (var i = 0; i < els.length; i++) {
      if (yes) show(els[i]); else hide(els[i]);
    }
  }

  function logout() {
    clearToken();
    showLoggedIn(false);
    location.hash = 'login';
    showView('login');
  }

  function showApp() {
    showLoggedIn(true);
    if (!location.hash || location.hash === '#login') location.hash = 'compose';
    handleRoute();
    api('GET', '/api/status').then(function (s) {
      if (!s.sms) {
        var banner = document.getElementById('configBanner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'configBanner';
          banner.className = 'config-banner';
          banner.innerHTML = '<i data-lucide="alert-triangle" class="banner-icon"></i> SMS not configured. Set VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_PHONE_NUMBER in .env';
          document.querySelector('.app-main').prepend(banner);
          lucide.createIcons();
        }
      }
    }).catch(function () {});
  }

  qs('input[name="recipients"]').addEventListener('change', function () {
    var sel = document.getElementById('volunteerSelect');
    if (this.value === 'select') show(sel);
    else hide(sel);
  });

  document.getElementById('addVolunteerForm').addEventListener('submit', addVolunteer);
  document.getElementById('sendBtn').addEventListener('click', sendMessage);

  document.getElementById('messageBody').addEventListener('input', function () {
    document.getElementById('charCount').textContent = this.value.length;
  });

  document.getElementById('themeToggle').addEventListener('click', function () {
    var html = document.documentElement;
    html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
    lucide.createIcons();
  });

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('loginForm').addEventListener('submit', login);

  document.getElementById('copyWebhookBtn').addEventListener('click', function () {
    var el = document.getElementById('webhookUrl');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () {
      var btn = document.getElementById('copyWebhookBtn');
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.innerHTML = '<i data-lucide="copy" class="btn-icon"></i> Copy'; lucide.createIcons(); }, 2000);
    }).catch(function () {});
  });

  qsa('[data-close-modal]').forEach(function (el) {
    el.addEventListener('click', function () { hide(document.getElementById('detailModal')); });
  });

  document.getElementById('detailModal').addEventListener('click', function (e) {
    if (e.target === this || e.target.classList.contains('modal-backdrop')) hide(this);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hide(document.getElementById('detailModal'));
  });

  lucide.createIcons();

  if (getToken()) {
    showApp();
  } else {
    showLoggedIn(false);
    showView('login');
  }
})();

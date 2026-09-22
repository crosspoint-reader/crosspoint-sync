/** CrossPoint Kindle Link popup. Thin shell over background.js messages. */

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showError(msg) {
  const el = $('err');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

async function guard(btn, fn) {
  btn.disabled = true;
  showError(null);
  try {
    const r = await fn();
    if (!r?.ok) showError(r?.error ?? 'failed');
    return r;
  } catch (e) {
    showError(e?.message ?? String(e));
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function refresh() {
  const st = await send({ type: 'status' });
  const configured = !!st?.configured;
  const registered = !!st?.registered;
  $('connectSec').hidden = configured;
  $('registerSec').hidden = !configured || registered;
  $('statusSec').hidden = !configured || !registered;
  // A pending Amazon registration outlives the popup: show the code form again.
  $('regForm').hidden = !!st?.otpPending;
  $('otpForm').hidden = !st?.otpPending;
  if (!configured) return;
  if (registered) {
    $('stDevice').textContent = st.deviceName ?? 'registered';
    $('stServer').textContent = `${st.username} @ ${st.server}`;
    $('stUpload').textContent = st.lastUpload ? new Date(st.lastUpload).toLocaleString() : 'not yet';
    if (st.lastError) showError(st.lastError);
  }
}

$('connectBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const server = $('server').value.trim();
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!server || !username || !password) return { ok: false, error: 'fill in server, username and password' };
    // Grant host access to the user's own server (runtime optional permission).
    const origin = new URL(server.includes('://') ? server : `https://${server}`).origin;
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return { ok: false, error: 'permission to reach your server was declined' };
    const r = await send({ type: 'connect', server, username, password });
    if (r?.ok) await refresh();
    return r;
  })
);

$('registerBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const email = $('email').value.trim();
    const password = $('amazonPassword').value;
    if (!email || !password) return { ok: false, error: 'enter your Amazon email and password' };
    const r = await send({ type: 'register-begin', email, password });
    if (r?.ok) await refresh(); // shows the code form (otp pending) or the linked status
    return r;
  })
);

$('otpBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const code = $('otp').value.trim();
    if (!code) return { ok: false, error: 'enter the code from Amazon’s email' };
    const r = await send({ type: 'register-complete', code });
    if (r?.ok) await refresh();
    return r;
  })
);

$('uploadBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const r = await send({ type: 'upload' });
    if (r?.ok) await refresh();
    return r;
  })
);

$('unlinkBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const r = await send({ type: 'unlink' });
    if (r?.ok) await refresh();
    return r;
  })
);

refresh();

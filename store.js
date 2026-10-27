/* Job Book — data layer.
 *
 * Job Book was first built on claude.ai, where the page asks the host for a
 * database with window.claude.use("db") and for the viewer with
 * window.claude.use("user"). This file answers those same two calls, backed by
 * Supabase instead, so index.html keeps its code exactly as it was.
 *
 * The app only ever uses this much of the database:
 *   db.collection(name).doc(id).get() / .set(obj) / .update(patch) / .delete()
 *   db.collection(name).onSnapshot(callback, onError)
 * and this much of the viewer:
 *   user.id(), user.can("data.write"), user.me(), user.profiles(ids)
 *
 * Each collection is one table (books -> jobbook_books, and so on). Every
 * record keeps the app's fields in a single "data" column, exactly as the app
 * wrote them on claude.ai, so a field can never be dropped on the way in or out.
 *
 * Changes show on screen at once (the app doesn't wait for the server), then
 * go to Supabase. If the server refuses, the screen is re-read from the server
 * so it never shows something that didn't save. Changes made on another phone
 * arrive through Supabase Realtime.
 *
 * Anything else the app asks for -- "mcp" (Gmail, Calendar) and "sample" (Ask
 * Claude) -- is answered "not available", which the app already handles by
 * hiding those buttons. Those come back in a later step.
 */
(function () {
  'use strict';

  var CFG = window.JB_CONFIG || {};
  var TABLE = {
    books: 'jobbook_books',
    jobs: 'jobbook_jobs',
    notes: 'jobbook_notes',
    people: 'jobbook_people'
  };

  var client = null;
  var session = null;
  var isMember = false;
  var readyPromise = null;

  var cache = {};      // collection -> Map(id -> data)
  var subs = {};       // collection -> [{cb, onErr}]
  var loaded = {};     // collection -> true once the first read is in
  var starting = {};   // collection -> true once started
  var channels = {};   // collection -> realtime channel
  var emitTimer = {};  // collection -> pending emit

  function err(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }
  /* The app reacts to a few error codes by name (see guard() in index.html):
     not_granted locks the page to read-only with an explanation; anything else
     reads as "That didn't save. Check your signal and try again." */
  function mapErr(e) {
    if (!e) return err('unknown');
    var msg = e.message || '';
    if (e.code === '42501' || /row-level security|permission denied/i.test(msg)) return err('not_granted', msg);
    if (e.code === 'PGRST301' || /jwt/i.test(msg)) return err('session_expired', msg);
    return err(e.code || 'unknown', msg);
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* ---------- live collections ------------------------------------------ */

  function makeDoc(id, data) {
    return { id: id, exists: true, data: function () { return clone(data); } };
  }

  /* Many changes can land together (deleting a job removes all its notes), so
     the app is told once per burst rather than once per record. */
  function schedule(name) {
    if (emitTimer[name]) return;
    emitTimer[name] = setTimeout(function () {
      emitTimer[name] = null;
      emit(name);
    }, 16);
  }
  function emit(name) {
    var m = cache[name];
    if (!m || !loaded[name]) return;
    var docs = [];
    m.forEach(function (data, id) { docs.push(makeDoc(id, data)); });
    (subs[name] || []).forEach(function (s) {
      try { s.cb({ docs: docs }); } catch (e) { console.error(e); }
    });
  }

  function fetchAll(name) {
    var out = new Map(), from = 0, PAGE = 1000;
    function page() {
      return client.from(TABLE[name]).select('id,data').order('id').range(from, from + PAGE - 1)
        .then(function (r) {
          if (r.error) throw mapErr(r.error);
          (r.data || []).forEach(function (row) { out.set(row.id, row.data || {}); });
          if ((r.data || []).length === PAGE) { from += PAGE; return page(); }
          return out;
        });
    }
    return page();
  }

  /* Re-read a whole collection from the server and redraw. Used at start, after
     the phone wakes or comes back online (a sleeping phone drops the live
     connection and can miss changes), and after a refused write. */
  function refresh(name) {
    return fetchAll(name).then(function (m) {
      cache[name] = m;
      loaded[name] = true;
      schedule(name);
    });
  }

  function subscribe(name) {
    if (channels[name]) return;
    channels[name] = client.channel('jobbook-' + name)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE[name] }, function (p) {
        var m = cache[name] || (cache[name] = new Map());
        if (p.eventType === 'DELETE') {
          if (p.old && p.old.id != null) m.delete(p.old.id);
        } else if (p.new && p.new.id != null) {
          m.set(p.new.id, p.new.data || {});
        }
        schedule(name);
      })
      .subscribe(function (status) {
        /* Catch anything that changed while the live connection was down. */
        if (status === 'SUBSCRIBED' && loaded[name]) refresh(name).catch(function () {});
      });
  }

  function start(name) {
    if (starting[name]) return;
    starting[name] = true;
    refresh(name).then(function () { subscribe(name); }, function (e) {
      starting[name] = false;
      (subs[name] || []).forEach(function (s) { if (s.onErr) try { s.onErr(e); } catch (x) {} });
    });
  }

  function refreshAll() {
    Object.keys(starting).forEach(function (name) {
      if (starting[name]) refresh(name).catch(function () {});
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && session) refreshAll();
  });
  window.addEventListener('online', function () { if (session) refreshAll(); });

  /* ---------- writes ------------------------------------------------------ */

  function localSet(name, id, data) {
    (cache[name] || (cache[name] = new Map())).set(id, clone(data));
    schedule(name);
  }
  function localMerge(name, id, patch) {
    var m = cache[name];
    if (!m || !m.has(id)) return;
    m.set(id, Object.assign({}, m.get(id), clone(patch)));
    schedule(name);
  }
  function localDelete(name, id) {
    var m = cache[name];
    if (m && m.delete(id)) schedule(name);
  }
  function settle(name) {
    return function (r) {
      if (r && r.error) {
        refresh(name).catch(function () {});
        throw mapErr(r.error);
      }
    };
  }
  function networkFail(name) {
    return function (e) {
      refresh(name).catch(function () {});
      throw (e && e.code) ? e : err('network', e && e.message);
    };
  }

  function docRef(name, id) {
    id = String(id);
    return {
      id: id,
      get: function () {
        return client.from(TABLE[name]).select('id,data').eq('id', id).maybeSingle().then(function (r) {
          if (r.error) throw mapErr(r.error);
          return r.data ? makeDoc(id, r.data.data || {})
                        : { id: id, exists: false, data: function () { return undefined; } };
        });
      },
      /* set replaces the whole record, as it did on claude.ai. */
      set: function (data) {
        var d = clone(data || {});
        localSet(name, id, d);
        return client.from(TABLE[name]).upsert({ id: id, data: d }, { onConflict: 'id' })
          .then(settle(name), networkFail(name));
      },
      /* update changes only the fields given and leaves the rest. The merge
         happens on the server in one step (jobbook_patch), so two phones
         changing different fields of one note can't undo each other. */
      update: function (patch) {
        var p = clone(patch || {});
        localMerge(name, id, p);
        return client.rpc('jobbook_patch', { p_collection: name, p_id: id, p_patch: p })
          .then(settle(name), networkFail(name));
      },
      delete: function () {
        localDelete(name, id);
        return client.from(TABLE[name]).delete().eq('id', id)
          .then(settle(name), networkFail(name));
      }
    };
  }

  function collection(name) {
    if (!TABLE[name]) throw err('invalid_argument', 'Unknown collection: ' + name);
    return {
      doc: function (id) { return docRef(name, id); },
      onSnapshot: function (cb, onErr) {
        var sub = { cb: cb, onErr: onErr };
        (subs[name] || (subs[name] = [])).push(sub);
        if (loaded[name]) schedule(name); else start(name);
        return function () {
          subs[name] = (subs[name] || []).filter(function (s) { return s !== sub; });
        };
      }
    };
  }

  var dbApi = { collection: collection };

  /* ---------- the viewer -------------------------------------------------- */

  var userApi = {
    id: function () { return Promise.resolve(session ? session.user.id : null); },
    /* Writing is for people on the Job Book members list. Anyone else who signs
       in gets a read-only page (and the database refuses them anyway). */
    can: function (what) { return Promise.resolve(what === 'data.write' ? isMember : false); },
    /* The name shown on "Done by" and Assign. Taken from the roster first, so
       the app never renames someone who is already on it. */
    me: function () {
      if (!session) return Promise.resolve(null);
      var u = session.user;
      return client.from(TABLE.people).select('data').eq('id', u.id).maybeSingle().then(function (r) {
        var n = r && r.data && r.data.data && r.data.data.name;
        if (!n) {
          var md = u.user_metadata || {};
          n = md.full_name || md.name || String(u.email || '').split('@')[0];
        }
        return { id: u.id, name: n, email: u.email };
      });
    },
    /* Names come from the roster table; nothing extra to look up. */
    profiles: function () { return Promise.resolve({}); }
  };

  /* ---------- sign in ----------------------------------------------------- */
  /* Same accounts as Field Measure: email and password, typed into the app.
     No email is sent, so nothing has to bounce back from Safari into the
     home-screen app. */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sheet(html) {
    var w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.5);display:flex;align-items:flex-end';
    w.innerHTML = '<div style="width:100%;max-width:720px;margin:0 auto;background:var(--card,#fff);color:var(--ink,#111);' +
      'border-radius:14px 14px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));' +
      'display:flex;flex-direction:column;gap:11px;font-family:var(--body,system-ui)">' + html + '</div>';
    document.body.appendChild(w);
    return w;
  }
  var BTN = 'border:1px solid var(--accent,#15607a);border-radius:8px;padding:12px;background:var(--accent,#15607a);' +
    'color:var(--accent-ink,#fff);font-family:var(--display,system-ui);font-size:1.1rem;font-weight:700;' +
    'letter-spacing:.05em;text-transform:uppercase';
  var LINK = 'border:none;background:none;padding:9px;color:var(--ink-soft,#666);font-size:.92rem;text-decoration:underline';
  var FIELD = 'font-size:16px;padding:12px;border:1px solid var(--line,#ccc);border-radius:8px;' +
    'background:var(--paper,#f4f4f4);color:var(--ink,#111);width:100%';
  var TITLE = 'font-family:var(--display,system-ui);font-size:1.4rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase';

  function signInSheet(done) {
    var box = sheet(
      '<div id="jbtitle" style="' + TITLE + '">Sign in to Job Book</div>' +
      '<div style="font-size:.92rem;line-height:1.5;color:var(--ink-soft,#666)">Same email and password as Field Measure.</div>' +
      '<input id="jbem" type="email" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" placeholder="you@example.com" style="' + FIELD + '">' +
      '<input id="jbpw" type="password" autocomplete="current-password" placeholder="password" style="' + FIELD + '">' +
      '<div id="jbmsg" style="font-size:.88rem;line-height:1.45;min-height:18px;color:var(--ink-soft,#666)"></div>' +
      '<button id="jbgo" style="' + BTN + '">Sign in</button>' +
      '<button id="jbswap" style="' + LINK + '">Create an account instead</button>');
    var msg = box.querySelector('#jbmsg');
    var go = box.querySelector('#jbgo');
    var pw = box.querySelector('#jbpw');
    var swap = box.querySelector('#jbswap');
    var title = box.querySelector('#jbtitle');
    var creating = false;

    swap.onclick = function () {
      creating = !creating;
      title.textContent = creating ? 'Create an account' : 'Sign in to Job Book';
      go.textContent = creating ? 'Create account' : 'Sign in';
      swap.textContent = creating ? 'I already have an account' : 'Create an account instead';
      pw.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
      msg.textContent = creating ? 'Pick something at least 8 characters.' : '';
    };

    function submit() {
      var email = (box.querySelector('#jbem').value || '').trim();
      var pass = pw.value || '';
      if (!email || !pass) { msg.textContent = 'Fill in both boxes.'; return; }
      if (creating && pass.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      go.disabled = true;
      msg.textContent = creating ? 'Creating…' : 'Signing in…';
      var call = creating
        ? client.auth.signUp({ email: email, password: pass })
        : client.auth.signInWithPassword({ email: email, password: pass });
      call.then(function (r) {
        go.disabled = false;
        if (r.error) {
          var m = (r.error.message || '').toLowerCase();
          if (m.indexOf('already registered') !== -1) msg.textContent = 'That email already has an account. Sign in instead.';
          else if (m.indexOf('invalid login') !== -1) msg.textContent = 'Email or password not right.';
          else msg.textContent = r.error.message || 'That did not go through.';
          return;
        }
        if (!r.data || !r.data.session) {
          msg.textContent = 'Account made, but it needs confirming by email first.';
          return;
        }
        box.remove();
        done(r.data.session);
      }, function () {
        go.disabled = false;
        msg.textContent = 'Could not reach the server. Check your signal.';
      });
    }
    go.onclick = submit;
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function notMemberSheet() {
    var box = sheet(
      '<div style="' + TITLE + '">Not on the list yet</div>' +
      '<div style="font-size:.95rem;line-height:1.5">You’re signed in as <strong>' + esc(session.user.email) +
      '</strong>, but this account isn’t on the Job Book members list, so there’s nothing to show. ' +
      'Ask Stephen to add you.</div>' +
      '<button id="jbok" style="' + BTN + '">OK</button>' +
      '<button id="jbout" style="' + LINK + '">Sign out</button>');
    box.querySelector('#jbok').onclick = function () { box.remove(); };
    box.querySelector('#jbout').onclick = function () { client.auth.signOut(); };
  }

  function checkMembership() {
    return client.from('jobbook_members').select('user_id').eq('user_id', session.user.id).maybeSingle()
      .then(function (r) {
        if (r.error) throw mapErr(r.error);
        isMember = !!r.data;
        if (!isMember) notMemberSheet();
      });
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise(function (resolve, reject) {
      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) {
        reject(err('offline', 'The database library did not load.'));
        return;
      }
      try {
        client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
        });
      } catch (e) { reject(err('offline', e && e.message)); return; }

      /* Note: the library holds a lock while running this callback, so it must
         not call the database itself (that can hang). It only records state. */
      client.auth.onAuthStateChange(function (event, s) {
        if (s) session = s;
        if (event === 'SIGNED_OUT') { session = null; setTimeout(function () { location.reload(); }, 0); }
      });

      function signedIn(s) {
        session = s;
        checkMembership().then(resolve, reject);
      }

      client.auth.getSession().then(function (r) {
        var s = r && r.data && r.data.session;
        if (s) signedIn(s);
        else signInSheet(signedIn);
      }, function (e) { reject(mapErr(e)); });
    });
    return readyPromise;
  }

  /* Sign out: open the app with #signout on the end of the address. */
  if (location.hash === '#signout') {
    ready().then(function () { history.replaceState(null, '', location.pathname); return client.auth.signOut(); })
      .catch(function () {});
  }

  /* ---------- what index.html calls --------------------------------------- */

  window.claude = window.claude || {};
  window.claude.use = function (what) {
    if (what === 'db') return ready().then(function () { return dbApi; });
    if (what === 'user') return ready().then(function () { return userApi; });
    return Promise.reject(err('not_available', what + ' is not available in this version yet'));
  };
})();

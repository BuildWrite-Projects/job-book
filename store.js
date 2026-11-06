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
 * "mcp" is answered with Google Calendar only (see Send to Calendar below).
 * "sample" (Ask Claude) is answered "not available", which the app already
 * handles by hiding the button. Gmail and Ask Claude come back in a later step.
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
      '<div style="font-size:.92rem;line-height:1.5;color:var(--ink-soft,#666)">One account for Job Book, Receipt Run and Field Measure.</div>' +
      '<input id="jbem" type="email" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" placeholder="you@example.com" style="' + FIELD + '">' +
      '<input id="jbpw" type="password" autocomplete="current-password" placeholder="password" style="' + FIELD + '">' +
      '<input id="jbpw2" type="password" autocomplete="new-password" placeholder="type the password again" style="' + FIELD + ';display:none">' +
      '<div id="jbmsg" style="font-size:.88rem;line-height:1.45;min-height:18px;color:var(--ink-soft,#666)"></div>' +
      '<button id="jbgo" style="' + BTN + '">Sign in</button>' +
      '<button id="jbswap" style="' + LINK + '">Create an account instead</button>');
    var msg = box.querySelector('#jbmsg');
    var go = box.querySelector('#jbgo');
    var pw = box.querySelector('#jbpw');
    var pw2 = box.querySelector('#jbpw2');
    var swap = box.querySelector('#jbswap');
    var title = box.querySelector('#jbtitle');
    var creating = false;

    swap.onclick = function () {
      creating = !creating;
      title.textContent = creating ? 'Create an account' : 'Sign in to Job Book';
      go.textContent = creating ? 'Create account' : 'Sign in';
      swap.textContent = creating ? 'I already have an account' : 'Create an account instead';
      pw.setAttribute('autocomplete', creating ? 'new-password' : 'current-password');
      pw2.style.display = creating ? '' : 'none';
      pw2.value = '';
      msg.textContent = creating ? 'Pick something at least 8 characters, and type it twice.' : '';
    };

    function submit() {
      var email = (box.querySelector('#jbem').value || '').trim();
      var pass = pw.value || '';
      if (!email || !pass) { msg.textContent = 'Fill in both boxes.'; return; }
      if (creating && pass.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      if (creating && pass !== (pw2.value || '')) { msg.textContent = 'The two passwords don’t match. Type them again.'; pw2.value = ''; pw2.focus(); return; }
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
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !creating) submit(); });
    pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function notMemberSheet() {
    var box = sheet(
      '<div style="' + TITLE + '">No invite yet</div>' +
      '<div style="font-size:.95rem;line-height:1.5">You’re signed in as <strong>' + esc(session.user.email) +
      '</strong>, but there’s no invite for this email, so there’s nothing to show yet. ' +
      'Ask the person who shared the app to invite this email address, then open it again.</div>' +
      '<button id="jbok" style="' + BTN + '">OK</button>' +
      '<button id="jbout" style="' + LINK + '">Sign out</button>');
    box.querySelector('#jbok').onclick = function () { box.remove(); };
    box.querySelector('#jbout').onclick = function () { client.auth.signOut(); };
  }

  /* First sign-in with an invite: start your own team (a friend), or join
     the team you were invited to. */
  function teamSetupSheet(invite) {
    return new Promise(function (resolve) {
      var joining = invite.kind === 'join';
      var box = sheet(
        '<div style="' + TITLE + '">' + (joining ? 'Join ' + esc(invite.teamName || 'the team') : 'Name your team') + '</div>' +
        '<div style="font-size:.95rem;line-height:1.5">' + (joining
          ? 'You’ve been invited to <strong>' + esc(invite.teamName || 'a team') + '</strong>. You’ll see its jobs in Job Book, Receipt Run and Field Measure.'
          : 'Your jobs, receipts and measurements live in your own team. Nobody else sees them. Use your business name, or your own name.') + '</div>' +
        (joining ? '' : '<input id="jbteam" type="text" autocomplete="organization" placeholder="e.g. Sam’s Builds" style="' + FIELD + '">') +
        '<div id="jbtmsg" style="font-size:.88rem;line-height:1.45;min-height:18px;color:var(--ink-soft,#666)"></div>' +
        '<button id="jbtgo" style="' + BTN + '">' + (joining ? 'Join' : 'Start my team') + '</button>' +
        '<button id="jbtout" style="' + LINK + '">Sign out</button>');
      var msg = box.querySelector('#jbtmsg'), go = box.querySelector('#jbtgo'), nm = box.querySelector('#jbteam');
      box.querySelector('#jbtout').onclick = function () { client.auth.signOut(); };
      if (nm) setTimeout(function () { try { nm.focus(); } catch (e) {} }, 60);
      function submit() {
        var name = nm ? (nm.value || '').trim() : null;
        if (nm && !name) { msg.textContent = 'Type a name for your team.'; nm.focus(); return; }
        go.disabled = true; msg.textContent = joining ? 'Joining…' : 'Setting up your team…';
        client.rpc('accept_invite', { team_name: name }).then(function (r) {
          go.disabled = false;
          if (r.error) { msg.textContent = r.error.message || 'That did not go through.'; return; }
          box.remove(); resolve();
        }, function () { go.disabled = false; msg.textContent = 'Could not reach the server. Check your signal.'; });
      }
      go.onclick = submit;
      if (nm) nm.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    });
  }

  /* In = on a team. Everything a team holds is only ever shown to its
     members (the database enforces it); this just decides what to show. */
  function checkMembership() {
    return client.rpc('my_team_status').then(function (r) {
      if (r.error) throw mapErr(r.error);
      var st = r.data || {};
      if (st.team) { isMember = true; window.BW_TEAM = st.team; return; }
      if (st.invite) {
        return teamSetupSheet(st.invite).then(function () {
          return client.rpc('my_team_status').then(function (r2) {
            var t = r2.data && r2.data.team;
            isMember = !!t; window.BW_TEAM = t || null;
          });
        });
      }
      isMember = false;
      notMemberSheet();
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

  /* for the shared Feedback button (feedback.js) */
  window.JB_client = function () { return client; };

  /* Sign out: open the app with #signout on the end of the address. */
  if (location.hash === '#signout') {
    ready().then(function () { history.replaceState(null, '', location.pathname); return client.auth.signOut(); })
      .catch(function () {});
  }

  /* ---------- Send to Calendar -------------------------------------------- */
  /* On claude.ai the app sent events straight to Google Calendar through the
     Calendar connector. Here there is no connector, so the same request opens
     Google Calendar with the event already filled in -- title, time, length,
     and the job name and bullets in the description -- and Stephen taps Save.
     The app still stamps the note with its date, as before.

     Only "Google Calendar" is offered. has("Gmail") is false, so tapping an
     email address in a note keeps doing what it did without a connector:
     copy the address. */

  function gcalStamp(iso, allDay) {
    if (allDay) return String(iso).slice(0, 10).replace(/-/g, '');
    return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  function calendarLink(p) {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
    var q = [
      'action=TEMPLATE',
      'text=' + encodeURIComponent(p.summary || 'Job Book item'),
      'dates=' + gcalStamp(p.startTime, p.allDay) + '/' + gcalStamp(p.endTime, p.allDay),
      'details=' + encodeURIComponent(p.description || '')
    ];
    if (tz) q.push('ctz=' + encodeURIComponent(tz));
    return 'https://calendar.google.com/calendar/render?' + q.join('&');
  }
  /* Which calendar this phone sends to. Each person picks once (kept on this
     phone); Google is what Stephen has always used. Nothing is linked or
     signed into here: the event opens filled in, in that person's own
     calendar, or arrives as a calendar file their phone adds. */
  var CAL_KEY = 'jobbook.calendar.v1';
  var CALS = [
    ['google', 'Google Calendar', 'Opens Google Calendar filled in. Tap Save.'],
    ['outlook', 'Outlook.com', 'Personal Outlook, Hotmail or Live. Opens filled in. Tap Save.'],
    ['office', 'Outlook for work', 'A work or school Microsoft 365 account. Opens filled in. Tap Save.'],
    ['ics', 'iPhone or other calendar', 'Downloads a calendar file with a reminder. Open it to add it.']
  ];
  function calName(k) { for (var i = 0; i < CALS.length; i++) if (CALS[i][0] === k) return CALS[i][1]; return 'Google Calendar'; }
  function calGet() { try { return localStorage.getItem(CAL_KEY) || ''; } catch (e) { return ''; } }
  function calSet(k) { try { localStorage.setItem(CAL_KEY, k); } catch (e) { /* ignore */ } }
  function calChoose(onPick) {
    var cur = calGet();
    var box = sheet('<div style="' + TITLE + '">Which calendar?</div>' +
      '<div style="font-size:.92rem;line-height:1.5;color:var(--ink-soft,#666)">Job Book sends reminders to the calendar you use. You only pick once on this phone; you can change it any time.</div>' +
      CALS.map(function (c) {
        return '<button data-cal="' + c[0] + '" style="text-align:left;border:1px solid ' + (c[0] === cur ? 'var(--accent,#15607a)' : 'var(--line,#ccc)') +
          ';border-radius:8px;padding:11px 12px;background:var(--paper,#f4f4f4);color:var(--ink,#111);font-size:1rem">' +
          '<b>' + esc(c[1]) + '</b><br><span style="font-size:.85rem;color:var(--ink-soft,#666)">' + esc(c[2]) + '</span></button>';
      }).join('') +
      '<button id="jbcalx" style="' + LINK + '">Cancel</button>');
    box.querySelector('#jbcalx').onclick = function () { box.remove(); onPick(null); };
    box.querySelectorAll('[data-cal]').forEach(function (b) {
      b.onclick = function () { var k = b.getAttribute('data-cal'); calSet(k); box.remove(); onPick(k); };
    });
  }
  window.JB_calendar = { get: calGet, name: function () { return calName(calGet() || 'google'); }, choose: calChoose };

  function outlookLink(base, p) {
    var day = function (iso) { return String(iso).slice(0, 10); };
    var q = [
      'path=%2Fcalendar%2Faction%2Fcompose', 'rru=addevent',
      'subject=' + encodeURIComponent(p.summary || 'Job Book item'),
      'body=' + encodeURIComponent(p.description || ''),
      'startdt=' + encodeURIComponent(p.allDay ? day(p.startTime) : new Date(p.startTime).toISOString()),
      'enddt=' + encodeURIComponent(p.allDay ? day(p.endTime) : new Date(p.endTime).toISOString())
    ];
    if (p.allDay) q.push('allday=true');
    return base + '/calendar/0/deeplink/compose?' + q.join('&');
  }
  /* A standard calendar file (Apple Calendar, Samsung, Outlook desktop...)
     with a reminder: 30 minutes before, or 8 am on the day for all-day. */
  function icsText(p) {
    var esc2 = function (s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); };
    var stamp = function (iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BuildWrite//Job Book//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT', 'UID:' + Date.now().toString(36) + Math.random().toString(36).slice(2) + '@jobbook',
      'DTSTAMP:' + stamp(new Date().toISOString())];
    if (p.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + gcalStamp(p.startTime, true), 'DTEND;VALUE=DATE:' + gcalStamp(p.endTime, true));
    } else {
      lines.push('DTSTART:' + stamp(p.startTime), 'DTEND:' + stamp(p.endTime));
    }
    lines.push('SUMMARY:' + esc2(p.summary || 'Job Book item'), 'DESCRIPTION:' + esc2(p.description),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc2(p.summary || 'Job Book item'),
      'TRIGGER:' + (p.allDay ? 'PT8H' : '-PT30M'), 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }
  function openLink(url) {
    var w = null;
    /* No 'noopener' flag: with it, window.open always reports failure, and
       the fallback below would open the calendar a second time. */
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e) { /* ignore */ } }
    else { try { location.assign(url); } catch (e) { /* nothing left to try */ } }
  }
  function sendTo(k, p) {
    if (k === 'ics') {
      var blob = new Blob([icsText(p)], { type: 'text/calendar;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = String(p.summary || 'Job Book item').replace(/[^\w \-]+/g, '').slice(0, 60).trim() + '.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      return { opened: true, ics: true, calendar: calName(k) };
    }
    var url = k === 'outlook' ? outlookLink('https://outlook.live.com', p)
            : k === 'office' ? outlookLink('https://outlook.office.com', p)
            : calendarLink(p);
    window.__lastCalendarLink = url;
    openLink(url);
    return { opened: true, url: url, calendar: calName(k) };
  }

  var mcpApi = {
    has: function (server) { return server === 'Google Calendar'; },
    /* Called straight from the tap on Send, so the browser allows it to open
       a new page. The first time on a phone, it asks which calendar; the tap
       on that choice opens it. */
    callTool: function (server, tool, payload) {
      if (server !== 'Google Calendar' || tool !== 'create_event') {
        return Promise.reject(err('server_not_connected', server + ' is not available in this version'));
      }
      var p = payload || {};
      /* Stephen's team has always used Google; it carries on without asking. */
      var k = calGet() || (window.BW_TEAM && window.BW_TEAM.founding ? 'google' : '');
      if (k) return Promise.resolve(sendTo(k, p));
      return new Promise(function (resolve, reject) {
        calChoose(function (picked) {
          if (!picked) { reject(err('cancelled', 'No calendar picked')); return; }
          resolve(sendTo(picked, p));
        });
      });
    }
  };

  /* ---------- what index.html calls --------------------------------------- */

  window.claude = window.claude || {};
  window.claude.use = function (what) {
    if (what === 'mcp') return Promise.resolve(mcpApi);
    if (what === 'db') return ready().then(function () { return dbApi; });
    if (what === 'user') return ready().then(function () { return userApi; });
    return Promise.reject(err('not_available', what + ' is not available in this version yet'));
  };
})();

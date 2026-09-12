// Pure helpers for the notification center: the shape of a stored entry, the
// rules that decide what deserves the badge, and the strings the panel
// paints. Kept out of the QML so they can be reasoned about on their own,
// matching how the first-party panels split out their Model.js.

// ---------------------------------------------------------------- identity

// The store's key for one notification: the moment it arrived and the id the
// daemon gave it. Ids restart from 1 with every shell process, so the
// timestamp is what keeps two generations apart.
function entryKey(timestamp, id) {
  return String(Number(timestamp) || 0) + "-" + String(Number(id) || 0)
}

// The daemon id back out of a key, for stores written before it was kept
// as a field of its own (those keys still end in ".json").
function idFromKey(key) {
  var match = /^\d+-(\d+)/.exec(String(key || ""))
  return match ? Number(match[1]) : 0
}

// Whether an on-screen popup row is this entry's toast: the same daemon id
// from the same moment. The first-party stamps its own time on the row, a
// few milliseconds after this store stamped the entry, and a restored row
// after a shell restart carries that same stamp back. Ids restart with every
// shell process, so the time is what tells two generations apart.
var TOAST_MATCH_MS = 2000

function toastRowMatches(row, entry) {
  var r = row || {}
  var e = entry || {}
  var id = Number(e.id) || 0
  if (id <= 0 || Number(r.originalId) !== id) return false
  return Math.abs((Number(r.timestamp) || 0) - (Number(e.timestamp) || 0)) <= TOAST_MATCH_MS
}

function stringHint(hints, name) {
  try {
    if (hints) {
      var value = hints[name]
      if (value !== undefined && value !== null) return String(value)
    }
  } catch (e) {
  }
  return ""
}

// Everything the center stores about one notification, read the moment it
// arrives. `n` is a plain copy of the live object's properties — the object
// itself dies with its sender, and reading a role off a destroyed one is a
// crash rather than an error — and `now` is the arrival time.
function entryFromNotification(n, now) {
  var r = n || {}
  var app = String(r.appName || "")
  var summary = String(r.summary || "")
  var body = String(r.body || "")
  if (!summary && !body && !app) return null
  var expire = Number(r.expireTimeout)
  if (!isFinite(expire) || expire < 0) expire = 0
  return {
    key: entryKey(now, r.id),
    id: Number(r.id) || 0,
    app: app,
    appIcon: String(r.appIcon || ""),
    desktopEntry: String(r.desktopEntry || ""),
    summary: summary,
    body: body,
    glyph: stringHint(r.hints, "omarchy-glyph"),
    execArgv: stringHint(r.hints, "omarchy-exec-argv"),
    urgency: typeof r.urgency === "number" ? r.urgency : 1,
    expireTimeout: expire,
    transient: r.transient === true,
    timestamp: Number(now) || 0,
    unread: true
  }
}

// An entry read back out of the store. Older stores lack the newer fields
// and carry keys in the first-party's file-name shape; both are fine.
function entryFromStored(value) {
  var v = value || {}
  if (!v.key) return null
  if (!v.summary && !v.body && !v.app) return null
  var expire = Number(v.expireTimeout)
  if (!isFinite(expire) || expire < 0) expire = 0
  return {
    key: String(v.key),
    id: Number(v.id) || idFromKey(v.key),
    app: String(v.app || ""),
    appIcon: String(v.appIcon || ""),
    desktopEntry: String(v.desktopEntry || ""),
    summary: String(v.summary || ""),
    body: String(v.body || ""),
    glyph: String(v.glyph || ""),
    execArgv: String(v.execArgv || ""),
    urgency: typeof v.urgency === "number" ? v.urgency : 1,
    expireTimeout: expire,
    transient: false,
    timestamp: Number(v.timestamp) || 0,
    unread: v.unread === true
  }
}

// Senders edit notifications in place — a download's percentage, an edited
// chat message — without changing the identity the key is built from.
function entryChanged(a, b) {
  if (!a || !b) return true
  return a.summary !== b.summary || a.body !== b.body || a.app !== b.app
    || a.appIcon !== b.appIcon || a.desktopEntry !== b.desktopEntry
    || a.glyph !== b.glyph || a.execArgv !== b.execArgv || a.urgency !== b.urgency
}

// Newest first, deduped by key, capped. The order the panel renders in.
function normalize(entries, limit) {
  var seen = {}
  var out = []
  var list = Array.isArray(entries) ? entries : []
  var sorted = list.slice().sort(function(a, b) {
    return (b.timestamp || 0) - (a.timestamp || 0)
  })
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i]
    if (!entry || !entry.key || seen[entry.key]) continue
    seen[entry.key] = true
    out.push(entry)
  }
  var max = Number(limit) || 0
  return max > 0 ? out.slice(0, max) : out
}

// ------------------------------------------------------------ session edge

// Hyprland names its instance "<commit>_<epoch seconds>_<random>", and the
// epoch is when the compositor — this graphical session — started. Read from
// the environment, so no process is needed to know it.
function sessionStartFromSignature(signature) {
  var parts = String(signature || "").split("_")
  if (parts.length < 2) return 0
  var seconds = Number(parts[1])
  return isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

// A notification from before this session. Every window it could have
// pointed at is gone, so it has nothing left to ask of the user: it stays in
// the list but no longer counts as unread. Without a session start nothing
// can be judged, so nothing is.
function isFromPastSession(entry, sessionStart) {
  var timestamp = Number(entry && entry.timestamp) || 0
  var start = Number(sessionStart) || 0
  return start > 0 && timestamp > 0 && timestamp < start
}

// ----------------------------------------------------------------- noise

// Senders that never own a window, so there is nothing to bring forward.
// The first-party treats the same two as ephemeral: notify-send is the CLI
// default for a sender that declared no identity, omarchy-action is
// Omarchy's own "you just did this" feedback.
function isEphemeralApp(app) {
  var name = String(app || "")
  return name === "notify-send" || name === "omarchy-action"
}

// A sender asking for less time on screen than the shell would give it by
// default (five seconds for low urgency) means a status flash, not a
// message: "Background switched" asks for 1.5 seconds.
var SHORT_EXPIRY_MS = 5000

// Why an entry does not deserve the badge, or "" when it does. A transient
// notification is not kept at all — the freedesktop hint means "skip any
// persistence" — and the rest are kept, but arrive already read: they stay
// findable under All without ever counting against the user.
function noiseReason(entry) {
  var e = entry || {}
  if (e.transient === true) return "transient"
  if (isEphemeralApp(e.app)) return "ephemeral-app"
  if (Number(e.urgency) === 0) return "low-urgency"
  var expire = Number(e.expireTimeout) || 0
  if (expire > 0 && expire < SHORT_EXPIRY_MS) return "short-expiry"
  return ""
}

// NotificationCloseReason: 1 expired, 2 dismissed, 3 the sender withdrew it.
// A withdrawal is the sender saying it has been dealt with — Slack read in
// Slack, a tab closed. A dismissal is the user closing or clicking the
// toast, which is dealing with it too — except under do-not-disturb, where
// the first-party dismisses every silenced notification the moment it has
// recorded it, and nobody has seen it yet.
function readOnClose(reason, doNotDisturb) {
  var r = Number(reason)
  if (r === 3) return true
  if (r === 2) return doNotDisturb !== true
  return false
}

// ----------------------------------------------------------------- groups

// The same sender saying the same thing again — "Claude is waiting for your
// input" from five terminal tabs — is one row with a count, not five rows.
// Only consecutive repeats fold together, so the list stays chronological
// and yesterday's identical ping is not pulled into today's.
function groupKey(entry) {
  var e = entry || {}
  return [String(e.app || ""), String(e.appIcon || ""), String(e.desktopEntry || ""),
    String(e.summary || ""), String(e.body || "")].join("")
}

// Entries newest-first in, groups newest-first out. Each group is painted
// as its newest entry, is unread while any member is, and carries the keys
// of every member so acting on the row can act on all of them.
function groupRuns(entries) {
  var list = Array.isArray(entries) ? entries : []
  var out = []
  var last = null
  var lastKey = ""
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (!entry) continue
    var key = groupKey(entry)
    if (last && key === lastKey) {
      last.keys.push(entry.key)
      last.count++
      if (entry.unread === true) last.unread = true
      continue
    }
    last = {
      key: entry.key,
      keys: [entry.key],
      count: 1,
      entry: entry,
      unread: entry.unread === true,
      timestamp: entry.timestamp
    }
    lastKey = key
    out.push(last)
  }
  return out
}

// ---------------------------------------------------------------- settings

// The first-party keeps its do-not-disturb preference in notifications.json
// as {"dnd": bool}. null when the file says nothing usable.
function parseDnd(raw) {
  var text = String(raw || "").trim()
  if (!text) return null
  try {
    var parsed = JSON.parse(text)
    return parsed && typeof parsed.dnd === "boolean" ? parsed.dnd : null
  } catch (e) {
    return null
  }
}

// ---------------------------------------------------------------- activation

// Validate a persisted omarchy-exec-argv hint into a runnable argv, or null.
// Structural only, and fails closed: a non-array, a non-string member, an
// empty program, or a leading-dash program that argv would read as an option.
// Mirrors the first-party check so a toast and its center row behave alike.
function parseExecArgv(value) {
  var text = String(value || "")
  if (!text) return null
  var parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (var i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== "string") return null
  }
  if (!parsed[0] || parsed[0].charAt(0) === "-") return null
  return parsed
}

// Browsers stamp their own name on every web notification, so the app name
// reads "Google Chrome" whether the sender was Slack, Gmail or a random tab.
// Mirrors the first-party check so the same senders get the same treatment.
function isChromiumDerived(app, appIcon) {
  var source = (String(app || "") + "\n" + String(appIcon || "")).toLowerCase()
  return source.indexOf("chrom") >= 0 || source.indexOf("brave") >= 0
    || source.indexOf("vivaldi") >= 0 || source.indexOf("microsoft-edge") >= 0
    || source.indexOf("opera") >= 0
}

// Chromium prefixes a web notification's body with the origin it came from,
// as a link ("<a href=...>app.slack.com</a>") or a bare host. That is the only
// trace of the real sender the notification carries — and it is also how its
// window is found: a Chromium web app's window class is
// "chrome-<host>__<path>-<profile>". Same shapes the first-party strips for
// display, read here for the host instead.
var LEADING_LINK_HOST = /^\s*<a\b[^>]*>\s*(?:https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/[^<\s]*)?\s*<\/a>/i
var LEADING_BARE_HOST = /^\s*(?:https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/\S*)?\s+/i

function originHost(body) {
  var text = String(body || "")
  var match = LEADING_LINK_HOST.exec(text) || LEADING_BARE_HOST.exec(text)
  return match ? match[1].toLowerCase() : ""
}

// A themed icon name — "com.mitchellh.ghostty", not a file:// URL or a path —
// is usually the sender's application id, which is also its window class.
// GLib applications (Ghostty among them) send no app name at all, and this
// is then all that identifies them.
function isIconName(value) {
  var s = String(value || "")
  return s.length > 0 && s.indexOf("/") < 0 && s.indexOf(":") < 0
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The window-class hints a notification carries, most specific first, as
// case-insensitive regexes for omarchy-hyprland-focus-app to try in turn.
// This is the click-through of last resort: what a row does once the
// notification has no action left to run (its toast is gone, the shell
// restarted, or it arrived silenced) and the best it can do is bring the
// sender's window forward.
function focusPatterns(entry) {
  var e = entry || {}
  var app = String(e.app || "").trim()
  var icon = String(e.appIcon || "").trim()
  var desktopEntry = String(e.desktopEntry || "").trim()
  var out = []
  function add(value) {
    if (value && out.indexOf(value) < 0) out.push(value)
  }
  if (isChromiumDerived(app, icon)) add(escapeRegex(originHost(e.body)))
  if (!isEphemeralApp(app)) {
    add(escapeRegex(app))
    // "Google Chrome" notifies under its display name while its window class
    // is google-chrome; the hyphenated form is what desktop entries end up as.
    add(escapeRegex(app.replace(/\s+/g, "-")))
  }
  // The desktop-entry hint is the sender's application id outright.
  if (isIconName(desktopEntry)) add(escapeRegex(desktopEntry))
  if (isIconName(icon)) add(escapeRegex(icon))
  return out
}

// ------------------------------------------------------------- list model

// The roles one row paints, for one group. Deliberately narrower than a
// stored entry: the rest (execArgv, urgency, icons) is only ever read back
// out of the service by key, so putting it in the view model would only
// cost redraws. The member keys ride along as JSON so a click can reach
// every entry the row stands for.
function rowData(group) {
  var g = group || {}
  var e = g.entry || {}
  return {
    key: String(g.key || ""),
    app: String(e.app || ""),
    summary: String(e.summary || ""),
    body: String(e.body || ""),
    timestamp: Number(g.timestamp) || 0,
    unread: g.unread === true,
    count: Number(g.count) || 1,
    members: JSON.stringify(Array.isArray(g.keys) ? g.keys : [])
  }
}

function memberKeys(members) {
  try {
    var parsed = JSON.parse(String(members || "[]"))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch (e) {
    return []
  }
}

// Fold a fresh group array into the panel's ListModel in place.
//
// Handing the ListView a plain JS array works, but every reassignment is a
// model reset: the view drops its delegates and relays out from the top. That
// throws the scroll position away on each mark-as-read and on each
// notification that lands while the panel is open — right when the user is
// working down the list. Editing the rows that actually changed keeps the
// delegates, and the scroll, alive.
function syncRows(model, rows) {
  var list = rows || []

  // Removals first, so what survives keeps its relative order and the pass
  // below only ever meets genuinely new keys.
  var live = ({})
  for (var i = 0; i < list.length; i++) live[String(list[i].key)] = true
  for (var j = model.count - 1; j >= 0; j--) {
    if (!live[model.get(j).key]) model.remove(j)
  }

  for (var k = 0; k < list.length; k++) {
    var next = rowData(list[k])
    if (k >= model.count) {
      model.append(next)
      continue
    }

    var current = model.get(k)
    if (current.key !== next.key) {
      // Entries are newest-first and only ever prepended, so a mismatch here
      // is an arrival. A reorder would still land correctly: the key is
      // looked for further down before giving up and inserting.
      var moved = -1
      for (var m = k + 1; m < model.count; m++) {
        if (model.get(m).key === next.key) {
          moved = m
          break
        }
      }
      if (moved < 0) {
        model.insert(k, next)
        continue
      }
      model.move(moved, k, 1)
      current = model.get(k)
    }

    for (var role in next) {
      if (current[role] !== next[role]) model.setProperty(k, role, next[role])
    }
  }

  if (model.count > list.length) model.remove(list.length, model.count - list.length)
}

// ---------------------------------------------------------------- display

// The bell's hover text. A sentence rather than a bare count, because on a
// vertical bar the badge digits are small enough to want confirming.
function tooltip(unread, dnd) {
  if (dnd) return unread > 0
    ? "Do not disturb — " + unread + " unread"
    : "Do not disturb"
  if (unread <= 0) return "No unread notifications"
  if (unread === 1) return "1 unread notification"
  return String(unread) + " unread notifications"
}

// A vertical bar is ~28px wide, so the badge has room for two digits and no
// more. Past 99 it stops growing rather than pushing into the icon.
function badgeText(unread) {
  var n = Number(unread) || 0
  return n > 99 ? "99+" : String(n)
}

function tabLabel(name, count) {
  var n = Number(count) || 0
  return n > 0 ? name + "  " + n : name
}

// "×4" beside the sender when a row stands for repeats; nothing for one.
function countLabel(count) {
  var n = Number(count) || 0
  return n > 1 ? "×" + n : ""
}

// Sender name for the row's eyebrow line. Notifications from CLI tooling
// carry no useful app name, so the summary alone has to identify them.
function appLabel(entry) {
  var app = String((entry && entry.app) || "").trim()
  if (!app || app === "notify-send") return "NOTIFICATION"
  return app.toUpperCase()
}

// The stored body may carry Pango markup and hyperlinks, since the daemon
// advertises both to senders. The list is one dim two-line block, not a rich
// text view, so the tags come out and the entities go back to their glyphs.
function bodyText(entry) {
  var body = String((entry && entry.body) || "")
  if (!body) return ""
  return body
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

// Coarse relative age. The list is scanned, not read for exact times, so the
// units stop at days and hand off to a date once a week has passed.
function relativeTime(timestamp, now) {
  var then = Number(timestamp) || 0
  if (then <= 0) return ""

  var seconds = Math.floor(((Number(now) || Date.now()) - then) / 1000)
  // A clock that moved backwards (an NTP correction, a resume from suspend)
  // would otherwise print a negative age.
  if (seconds < 60) return "now"

  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + "m"

  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h"

  var days = Math.floor(hours / 24)
  if (days < 7) return days + "d"

  return Qt.formatDateTime(new Date(then), "d MMM")
}

// Loaded by QML as a plain script, and by `node --test` as a module.
if (typeof module !== "undefined") {
  module.exports = {
    entryKey: entryKey,
    idFromKey: idFromKey,
    toastRowMatches: toastRowMatches,
    stringHint: stringHint,
    entryFromNotification: entryFromNotification,
    entryFromStored: entryFromStored,
    entryChanged: entryChanged,
    normalize: normalize,
    sessionStartFromSignature: sessionStartFromSignature,
    isFromPastSession: isFromPastSession,
    isEphemeralApp: isEphemeralApp,
    SHORT_EXPIRY_MS: SHORT_EXPIRY_MS,
    noiseReason: noiseReason,
    readOnClose: readOnClose,
    groupKey: groupKey,
    groupRuns: groupRuns,
    parseDnd: parseDnd,
    parseExecArgv: parseExecArgv,
    isChromiumDerived: isChromiumDerived,
    originHost: originHost,
    isIconName: isIconName,
    escapeRegex: escapeRegex,
    focusPatterns: focusPatterns,
    rowData: rowData,
    memberKeys: memberKeys,
    tooltip: tooltip,
    badgeText: badgeText,
    tabLabel: tabLabel,
    countLabel: countLabel,
    appLabel: appLabel,
    bodyText: bodyText
  }
}

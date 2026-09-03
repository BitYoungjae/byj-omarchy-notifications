// Pure helpers for the notification center: the shape of a stored entry, the
// on-disk formats it is read out of, and the strings the panel paints. Kept
// out of the QML so they can be reasoned about on their own, matching how the
// first-party panels split out their Model.js.

// ---------------------------------------------------------------- identity

// The name the first-party service files a notification under
// (`<timestamp>-<originalId>.json`). Reused verbatim as this store's key so a
// row read off the live popup model and the same notification read out of the
// history directory collapse onto one entry.
function rowKey(row) {
  var r = row || {}
  var originalId = r.originalId !== undefined && r.originalId !== null ? r.originalId : r.id
  return String(r.timestamp || 0) + "-" + String(originalId || 0) + ".json"
}

// Everything the center stores about one notification. Deliberately a plain
// snapshot: the Notification object behind a toast dies with its sender, and
// reading a role off a destroyed one is a crash, not an error.
function entryFromRow(row) {
  var r = row || {}
  if (!r.summary && !r.body && !r.app) return null
  return {
    key: rowKey(r),
    app: String(r.app || ""),
    appIcon: String(r.appIcon || ""),
    summary: String(r.summary || ""),
    body: String(r.body || ""),
    glyph: String(r.glyph || ""),
    execArgv: String(r.execArgv || ""),
    urgency: typeof r.urgency === "number" ? r.urgency : 1,
    timestamp: Number(r.timestamp) || 0,
    unread: true
  }
}

// Senders edit notifications in place — a download's percentage, an edited
// chat message — without changing the identity the key is built from.
function entryChanged(a, b) {
  if (!a || !b) return true
  return a.summary !== b.summary || a.body !== b.body || a.app !== b.app
    || a.appIcon !== b.appIcon || a.glyph !== b.glyph || a.execArgv !== b.execArgv
    || a.urgency !== b.urgency
}

// ---------------------------------------------------------------- ingest

// The first-party history directory, concatenated one JSON object per line.
// A torn write from a crash mid-save is skipped rather than taking the rest
// of the sweep down with it.
function parseHistory(raw) {
  var lines = String(raw || "").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    try {
      var value = JSON.parse(line)
      if (!value || typeof value !== "object") continue
      var entry = entryFromRow(value)
      if (entry) out.push(entry)
    } catch (e) {
      // Not a whole object — skip this line, keep the sweep going.
    }
  }
  return out
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

// Senders that never own a window, so there is nothing to bring forward.
function isEphemeralApp(app) {
  var name = String(app || "")
  return name === "notify-send" || name === "omarchy-action"
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
// notification has no action left to run (the sender closed it, the shell
// restarted, or it arrived silenced) and the best it can do is bring the
// sender's window forward.
function focusPatterns(entry) {
  var e = entry || {}
  var app = String(e.app || "").trim()
  var icon = String(e.appIcon || "").trim()
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
  if (isIconName(icon)) add(escapeRegex(icon))
  return out
}

// ---------------------------------------------------------------- stale toasts

// What the sweep in Service.qml reads back: the machine's boot time from
// /proc/stat as a "btime <seconds>" line, then the name of every popup file
// the first-party currently has on disk, one per line.
function parseStaleSweep(raw) {
  var lines = String(raw || "").split("\n")
  var bootTime = 0
  var files = {}
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    if (line.indexOf("btime ") === 0) {
      var seconds = Number(line.slice(6))
      if (isFinite(seconds) && seconds > 0) bootTime = seconds * 1000
      continue
    }
    files[line] = true
  }
  return { bootTime: bootTime, files: files }
}

// A toast the first-party restored from a popup file written before this
// boot. Across a shell restart a restored toast is the same toast back after
// a flicker; across a boot it is yesterday's. The file is what tells a
// startup restore from a `showHistory` replay: a replayed row is restored
// too, but its file sits in the history directory, not among the popups.
// Without a boot time nothing can be judged, so nothing is.
function isStaleToast(row, sweep) {
  var r = row || {}
  var s = sweep || {}
  var bootTime = Number(s.bootTime) || 0
  if (bootTime <= 0) return false
  var timestamp = Number(r.timestamp) || 0
  if (timestamp <= 0 || timestamp >= bootTime) return false
  return !!(s.files && s.files[rowKey(r)] === true)
}

// ------------------------------------------------------------- list model

// The roles one row paints. Deliberately narrower than a stored entry: the
// rest (execArgv, urgency, icons) is only ever read back out of the service
// by key, so putting it in the view model would only cost redraws.
function rowData(entry) {
  var e = entry || {}
  return {
    key: String(e.key || ""),
    app: String(e.app || ""),
    summary: String(e.summary || ""),
    body: String(e.body || ""),
    timestamp: Number(e.timestamp) || 0,
    unread: e.unread === true
  }
}

// Fold a fresh entries array into the panel's ListModel in place.
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
    rowKey: rowKey,
    entryFromRow: entryFromRow,
    entryChanged: entryChanged,
    parseHistory: parseHistory,
    normalize: normalize,
    parseExecArgv: parseExecArgv,
    isEphemeralApp: isEphemeralApp,
    isChromiumDerived: isChromiumDerived,
    originHost: originHost,
    isIconName: isIconName,
    escapeRegex: escapeRegex,
    focusPatterns: focusPatterns,
    parseStaleSweep: parseStaleSweep,
    isStaleToast: isStaleToast,
    rowData: rowData,
    tooltip: tooltip,
    badgeText: badgeText,
    tabLabel: tabLabel,
    appLabel: appLabel,
    bodyText: bodyText
  }
}

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

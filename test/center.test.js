// node --test
const test = require("node:test")
const assert = require("node:assert/strict")
const Center = require("../Center.js")

const slackViaChrome = {
  app: "Google Chrome",
  appIcon: "file:///home/me/.local/state/omarchy/notifications/images/1-6-appIcon",
  body: "<a href=\"https://app.slack.com/\">app.slack.com</a>\n\nHeehong: hello"
}

const claudeViaGhostty = {
  app: "",
  appIcon: "com.mitchellh.ghostty",
  desktopEntry: "com.mitchellh.ghostty",
  summary: "Claude Code",
  body: "Claude is waiting for your input"
}

// ---------------------------------------------------------------- identity

test("entryKey pairs the arrival time with the daemon's id", () => {
  assert.equal(Center.entryKey(1788317073505, 6), "1788317073505-6")
  assert.equal(Center.entryKey(undefined, undefined), "0-0")
})

test("entryFromNotification copies what the daemon exposes", () => {
  const entry = Center.entryFromNotification({
    id: 8, appName: "", appIcon: "com.mitchellh.ghostty", desktopEntry: "com.mitchellh.ghostty",
    summary: "T7", body: "hello", urgency: 1, expireTimeout: -1, transient: false,
    hints: { "desktop-entry": "com.mitchellh.ghostty", "omarchy-glyph": "󰂚", "omarchy-exec-argv": "[\"xdg-open\",\"x\"]" }
  }, 1789230000000)
  assert.equal(entry.key, "1789230000000-8")
  assert.equal(entry.id, 8)
  assert.equal(entry.desktopEntry, "com.mitchellh.ghostty")
  assert.equal(entry.glyph, "󰂚")
  assert.equal(entry.execArgv, "[\"xdg-open\",\"x\"]")
  assert.equal(entry.expireTimeout, 0, "a -1 (server default) timeout reads as none")
  assert.equal(entry.transient, false)
  assert.equal(entry.unread, true)
  assert.equal(Center.entryFromNotification({ id: 1, hints: null }, 5), null)
  assert.equal(Center.entryFromNotification({ id: 2, summary: "x", transient: true }, 5).transient, true)
})

test("idFromKey reads the daemon id out of either key shape", () => {
  assert.equal(Center.idFromKey("1789230000000-8"), 8)
  assert.equal(Center.idFromKey("1789227107951-5.json"), 5)
  assert.equal(Center.idFromKey(""), 0)
  assert.equal(Center.idFromKey("garbage"), 0)
})

test("toastRowMatches pairs a popup row with its entry by id and moment", () => {
  const entry = { id: 8, timestamp: 1789230000000 }
  assert.equal(Center.toastRowMatches({ originalId: 8, timestamp: 1789230000012 }, entry), true)
  assert.equal(Center.toastRowMatches({ originalId: 8, timestamp: 1789230000000 - 1500 }, entry), true)
  assert.equal(Center.toastRowMatches({ originalId: 8, timestamp: 1789230005000 }, entry), false, "same id, another generation")
  assert.equal(Center.toastRowMatches({ originalId: 9, timestamp: 1789230000000 }, entry), false)
  assert.equal(Center.toastRowMatches({ originalId: 0, timestamp: 0 }, { id: 0, timestamp: 0 }), false)
})

test("entryFromStored accepts entries written by earlier versions", () => {
  const old = { key: "1789227107951-5.json", app: "", appIcon: "com.mitchellh.ghostty", summary: "Claude Code",
    body: "Claude is waiting for your input", glyph: "", execArgv: "", urgency: 1, timestamp: 1789227107951, unread: true }
  const entry = Center.entryFromStored(old)
  assert.equal(entry.key, "1789227107951-5.json")
  assert.equal(entry.id, 5, "the id comes out of the old key")
  assert.equal(entry.desktopEntry, "")
  assert.equal(entry.expireTimeout, 0)
  assert.equal(entry.unread, true)
  assert.equal(Center.entryFromStored({ key: "x" }), null)
  assert.equal(Center.entryFromStored({ summary: "no key" }), null)
})

test("normalize is newest-first, deduped and capped", () => {
  const rows = [
    { key: "a", timestamp: 1 }, { key: "b", timestamp: 3 }, { key: "a", timestamp: 1 }, { key: "c", timestamp: 2 }
  ]
  assert.deepEqual(Center.normalize(rows, 2).map(e => e.key), ["b", "c"])
  assert.deepEqual(Center.normalize(rows, 0).map(e => e.key), ["b", "c", "a"])
})

// ------------------------------------------------------------ session edge

test("sessionStartFromSignature reads the epoch out of Hyprland's instance signature", () => {
  assert.equal(Center.sessionStartFromSignature("efb50993780079460b0cbed1363e2166a2de1d9f_1789216046_2043238657"), 1789216046000)
  assert.equal(Center.sessionStartFromSignature(""), 0)
  assert.equal(Center.sessionStartFromSignature("garbage"), 0)
  assert.equal(Center.sessionStartFromSignature("x_notanumber_y"), 0)
})

test("isFromPastSession is strict and fails closed without a session start", () => {
  const start = 1789216046000
  assert.equal(Center.isFromPastSession({ timestamp: start - 1 }, start), true)
  assert.equal(Center.isFromPastSession({ timestamp: start }, start), false)
  assert.equal(Center.isFromPastSession({ timestamp: start + 5 }, start), false)
  assert.equal(Center.isFromPastSession({ timestamp: start - 1 }, 0), false)
  assert.equal(Center.isFromPastSession({ timestamp: 0 }, start), false)
})

// ----------------------------------------------------------------- noise

test("noiseReason mirrors the first-party's ephemeral set and the sender's own signals", () => {
  assert.equal(Center.noiseReason({ app: "notify-send", urgency: 1, expireTimeout: 1500 }), "ephemeral-app")
  assert.equal(Center.noiseReason({ app: "omarchy-action", urgency: 0 }), "ephemeral-app")
  assert.equal(Center.noiseReason({ app: "Slack", urgency: 0 }), "low-urgency")
  assert.equal(Center.noiseReason({ app: "Slack", urgency: 1, expireTimeout: 2000 }), "short-expiry")
  assert.equal(Center.noiseReason({ app: "Slack", urgency: 1, expireTimeout: 8000 }), "")
  assert.equal(Center.noiseReason({ app: "Slack", transient: true }), "transient")
  assert.equal(Center.noiseReason({ app: "Google Chrome", urgency: 2, expireTimeout: 0 }), "")
  assert.equal(Center.noiseReason(claudeViaGhostty), "")
})

test("readOnClose: withdrawn and dismissed count as dealt with, expiry does not", () => {
  assert.equal(Center.readOnClose(3, false), true)
  assert.equal(Center.readOnClose(3, true), true)
  assert.equal(Center.readOnClose(2, false), true)
  assert.equal(Center.readOnClose(2, true), false, "a silenced notification is dismissed by the shell, not the user")
  assert.equal(Center.readOnClose(1, false), false)
  assert.equal(Center.readOnClose(undefined, false), false)
})

// ----------------------------------------------------------------- groups

test("groupRuns folds consecutive repeats only", () => {
  const rows = [
    { key: "d", timestamp: 4, unread: true, ...claudeViaGhostty },
    { key: "c", timestamp: 3, unread: false, ...claudeViaGhostty },
    { key: "b", timestamp: 2, unread: false, app: "notify-send", summary: "Background switched", body: "x" },
    { key: "a", timestamp: 1, unread: true, ...claudeViaGhostty }
  ]
  const groups = Center.groupRuns(rows)
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0].keys, ["d", "c"])
  assert.equal(groups[0].key, "d")
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].unread, true)
  assert.equal(groups[0].timestamp, 4)
  assert.equal(groups[1].count, 1)
  assert.equal(groups[1].unread, false)
  assert.deepEqual(groups[2].keys, ["a"])
  assert.deepEqual(Center.groupRuns([]), [])
})

test("rowData carries the member keys as JSON and memberKeys reads them back", () => {
  const groups = Center.groupRuns([
    { key: "d", timestamp: 4, unread: true, ...claudeViaGhostty },
    { key: "c", timestamp: 3, unread: false, ...claudeViaGhostty }
  ])
  const row = Center.rowData(groups[0])
  assert.equal(row.key, "d")
  assert.equal(row.count, 2)
  assert.equal(row.unread, true)
  assert.equal(row.summary, "Claude Code")
  assert.deepEqual(Center.memberKeys(row.members), ["d", "c"])
  assert.deepEqual(Center.memberKeys("not json"), [])
})

test("countLabel only speaks up for repeats", () => {
  assert.equal(Center.countLabel(1), "")
  assert.equal(Center.countLabel(4), "×4")
})

// ---------------------------------------------------------------- settings

test("parseDnd reads the first-party's preference file", () => {
  assert.equal(Center.parseDnd("{\"version\":3,\"dnd\":true}"), true)
  assert.equal(Center.parseDnd("{\"version\":3,\"dnd\":false}"), false)
  assert.equal(Center.parseDnd(""), null)
  assert.equal(Center.parseDnd("{}"), null)
  assert.equal(Center.parseDnd("nope"), null)
})

// ---------------------------------------------------------------- activation

test("originHost reads the origin Chromium prefixes a web notification with", () => {
  assert.equal(Center.originHost(slackViaChrome.body), "app.slack.com")
  assert.equal(Center.originHost("mail.google.com New mail from someone"), "mail.google.com")
  assert.equal(Center.originHost("https://example.org:8443/path?q=1 Body text"), "example.org")
  assert.equal(Center.originHost("<a href=\"https://WWW.Example.COM/\">WWW.Example.COM</a> hi"), "example.com")
})

test("originHost ignores hosts that are not a leading origin line", () => {
  assert.equal(Center.originHost("Visit app.slack.com later"), "")
  assert.equal(Center.originHost("Claude is waiting for your input"), "")
  assert.equal(Center.originHost(""), "")
  assert.equal(Center.originHost(null), "")
})

test("focusPatterns puts a web app's origin before the browser it runs in", () => {
  assert.deepEqual(Center.focusPatterns(slackViaChrome),
    ["app\\.slack\\.com", "Google Chrome", "Google-Chrome"])
})

test("focusPatterns falls back to the desktop entry and icon name when there is no app name", () => {
  assert.deepEqual(Center.focusPatterns(claudeViaGhostty), ["com\\.mitchellh\\.ghostty"])
  assert.deepEqual(Center.focusPatterns({ app: "", appIcon: "", desktopEntry: "org.example.App", body: "" }),
    ["org\\.example\\.App"])
})

test("focusPatterns skips senders that never own a window", () => {
  assert.deepEqual(Center.focusPatterns({ app: "notify-send", appIcon: "", body: "x" }), [])
  assert.deepEqual(Center.focusPatterns({ app: "omarchy-action", appIcon: "", body: "x" }), [])
})

test("focusPatterns never repeats a pattern and skips paths and URLs as icons", () => {
  assert.deepEqual(Center.focusPatterns({ app: "Slack", appIcon: "slack", body: "" }), ["Slack", "slack"])
  assert.deepEqual(Center.focusPatterns({ app: "Slack", appIcon: "Slack", body: "" }), ["Slack"])
  assert.deepEqual(Center.focusPatterns({ app: "", appIcon: "/usr/share/icons/x.png", body: "" }), [])
  assert.deepEqual(Center.focusPatterns({ app: "", appIcon: "image://qs/x", body: "" }), [])
})

test("focusPatterns escapes regex metacharacters", () => {
  assert.deepEqual(Center.focusPatterns({ app: "C++ (Beta)", appIcon: "", body: "" }),
    ["C\\+\\+ \\(Beta\\)", "C\\+\\+-\\(Beta\\)"])
})

test("isChromiumDerived matches the first-party's browser set", () => {
  assert.equal(Center.isChromiumDerived("Google Chrome", ""), true)
  assert.equal(Center.isChromiumDerived("", "brave-browser"), true)
  assert.equal(Center.isChromiumDerived("Firefox", "firefox"), false)
})

test("parseExecArgv fails closed on anything but a string argv", () => {
  assert.deepEqual(Center.parseExecArgv("[\"xdg-open\",\"https://x\"]"), ["xdg-open", "https://x"])
  assert.equal(Center.parseExecArgv("[\"-rf\",\"/\"]"), null)
  assert.equal(Center.parseExecArgv("[1,2]"), null)
  assert.equal(Center.parseExecArgv("not json"), null)
  assert.equal(Center.parseExecArgv(""), null)
})

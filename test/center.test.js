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
  summary: "Claude Code",
  body: "Claude is waiting for your input"
}

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

test("focusPatterns falls back to the icon name when there is no app name", () => {
  assert.deepEqual(Center.focusPatterns(claudeViaGhostty), ["com\\.mitchellh\\.ghostty"])
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

test("rowKey mirrors the first-party's file name", () => {
  assert.equal(Center.rowKey({ timestamp: 1788317073505, originalId: 6 }), "1788317073505-6.json")
  assert.equal(Center.rowKey({ timestamp: 5, id: 2 }), "5-2.json")
})

test("normalize is newest-first, deduped and capped", () => {
  const rows = [
    { key: "a", timestamp: 1 }, { key: "b", timestamp: 3 }, { key: "a", timestamp: 1 }, { key: "c", timestamp: 2 }
  ]
  assert.deepEqual(Center.normalize(rows, 2).map(e => e.key), ["b", "c"])
  assert.deepEqual(Center.normalize(rows, 0).map(e => e.key), ["b", "c", "a"])
})

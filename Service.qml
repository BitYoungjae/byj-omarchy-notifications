import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Center.js" as Center

// Notification center store.
//
// This plugin does NOT own a notification daemon. Omarchy's first-party
// `omarchy.notifications` keeps that role — it holds the
// org.freedesktop.Notifications bus name, draws the toasts, and owns
// do-not-disturb. Replacing it would mean forking the daemon and asking every
// user to disable the built-in; attaching to it instead means this plugin
// installs with one command and survives Omarchy upgrades.
//
// What it adds is the two things the first-party service has no reason to
// keep: a read flag per notification, and a backlog deeper than the ten
// entries its own history directory retains. And one thing it cannot do on
// its own terms: keep a notification clickable after its toast has gone
// (see LiveNotifications.qml).
Item {
  id: service

  // Injected by omarchy-shell's service loader.
  property var shell: null

  // The first-party notification service, reached through the host rather
  // than by path so that an enabled clone of it answers just as well.
  readonly property var source: shell && typeof shell.serviceFor === "function"
    ? shell.serviceFor("omarchy.notifications") : null

  readonly property bool sourceReady: source !== null && source !== undefined

  // Do-not-disturb stays the first-party service's state; the bell only
  // mirrors and toggles it, so the two never disagree.
  readonly property bool doNotDisturb: sourceReady && source.doNotDisturb === true

  function setDoNotDisturb(value) {
    if (sourceReady && typeof source.setDoNotDisturb === "function")
      source.setDoNotDisturb(value === true)
  }

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: home + "/.local/state/byj-notification-center/"
  readonly property string storePath: stateDir + "store.json"

  // Where the first-party service parks notifications that have left the
  // screen. Read only as the do-not-disturb backstop below — everything that
  // actually gets shown is picked up from popupModel, in process.
  readonly property string sourceHistoryDir: home + "/.local/state/omarchy/notifications/history/"

  // How many notifications the center keeps. The first-party history is
  // capped at ten; this store is the reason the "All" tab can go deeper.
  readonly property int retention: 500

  // Newest-first plain snapshots. Deliberately not the live Notification
  // objects: those die with their sender, and reading a role off a destroyed
  // one is a crash rather than an error.
  property var entries: []

  readonly property int unreadCount: {
    var n = 0
    for (var i = 0; i < entries.length; i++) if (entries[i].unread) n++
    return n
  }

  // Notifications cleared out of the center. The first-party history is left
  // alone — it is not this plugin's state to wipe — so the sweep needs a
  // watermark to tell "already cleared" from "not seen yet", or a clear would
  // undo itself on the next do-not-disturb tick.
  property double clearedBefore: 0

  // The live objects behind the entries that arrived this session, kept open
  // at the sender past their toast so a row click can still run the same
  // action the toast would have. Everything else about a notification is a
  // snapshot; this is the one live thing, and it degrades to nothing.
  LiveNotifications {
    id: live
    source: service.source
    onSuperseded: function(key) { service.forget(key) }
  }

  readonly property bool liveActionsSupported: live.supported
  readonly property int liveCount: live.count

  function entryFor(key) {
    var k = String(key || "")
    for (var i = 0; i < entries.length; i++) if (entries[i].key === k) return entries[i]
    return null
  }

  function isUnread(key) {
    var entry = entryFor(key)
    return entry ? entry.unread === true : false
  }

  // ------------------------------------------------------------- ingest

  // Fold a batch of freshly-read entries into the store. Entries already
  // known keep their read flag — a sweep must never resurrect something the
  // user has read — but pick up edits the sender made in place.
  function absorb(incoming) {
    if (!incoming || incoming.length === 0) return

    var next = entries.slice()
    var index = ({})
    for (var i = 0; i < next.length; i++) index[next[i].key] = i

    var changed = false
    for (var j = 0; j < incoming.length; j++) {
      var entry = incoming[j]
      if (!entry || entry.timestamp <= service.clearedBefore) continue

      var at = index[entry.key]
      if (at === undefined) {
        next.push(entry)
        index[entry.key] = next.length - 1
        changed = true
      } else if (Center.entryChanged(next[at], entry)) {
        entry.unread = next[at].unread
        next[at] = entry
        changed = true
      }
    }
    if (changed) commit(next)
  }

  function commit(list) {
    entries = Center.normalize(list, retention)
    // An entry that just aged out of the store can no longer be clicked, so
    // its sender may as well hear that it is done with.
    live.prune(keyIndex(entries))
    scheduleSave()
  }

  function keyIndex(list) {
    var index = ({})
    for (var i = 0; i < list.length; i++) index[list[i].key] = true
    return index
  }

  // Every notification that reaches the screen passes through the
  // first-party popup model, in this process. Insertions, removals and
  // reorders all land here; the scan only adds what it has not seen, so
  // running it more often than strictly necessary costs nothing.
  Connections {
    target: service.sourceReady ? service.source.popupModel : null
    ignoreUnknownSignals: true
    function onCountChanged() { service.ingestPopups() }
    function onDataChanged() { service.ingestPopups() }
  }

  function ingestPopups() {
    if (!sourceReady) return
    var model = source.popupModel
    if (!model) return

    var batch = []
    for (var i = 0; i < model.count; i++) {
      var row = null
      try {
        row = model.get(i)
      } catch (e) {
        continue
      }
      // The first-party "No recent notifications" placeholder carries
      // originalId -1 and is not a notification.
      if (!row || row.originalId < 0) continue
      var entry = Center.entryFromRow(row)
      if (!entry) continue
      // Same watermark as absorb: what a clear left on screen is not the
      // center's to keep hold of either.
      if (entry.timestamp > service.clearedBefore) live.retain(row)
      batch.push(entry)
    }
    absorb(batch)
  }

  // Do-not-disturb is the one path that never reaches popupModel: a silenced
  // notification is written straight into the first-party history and never
  // shown. That directory is the only place to read it back from.
  // True once the first sweep has been folded in. That first batch is
  // whatever was already on the machine before this plugin existed; counting
  // it as unread would hand a new user a badge they never earned, so it is
  // absorbed as already-read and the list simply starts populated.
  property bool primed: false

  Process {
    id: historyProc
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var batch = Center.parseHistory(text)
        if (!service.primed) {
          for (var i = 0; i < batch.length; i++) batch[i].unread = false
          service.primed = true
        }
        service.absorb(batch)
      }
    }
  }

  function sweepHistory() {
    if (historyProc.running) return
    // awk 1 rather than cat: a torn file missing its trailing newline must
    // not glue itself onto the next one and take a valid entry down with it.
    historyProc.command = ["bash", "-c",
      "awk 1 \"$1\"/*.json 2>/dev/null || true", "--", service.sourceHistoryDir]
    historyProc.running = true
  }

  // The history keeps ten entries, so a five-second beat cannot miss one
  // unless more than ten arrive between ticks — and it only runs while
  // do-not-disturb is actually on.
  Timer {
    running: service.doNotDisturb && service.storeLoaded
    interval: 5000
    repeat: true
    triggeredOnStart: true
    onTriggered: service.sweepHistory()
  }

  // Catch the tail of a do-not-disturb window the moment it ends, and
  // anything that arrived while the shell was not running.
  onDoNotDisturbChanged: if (storeLoaded) sweepHistory()

  // ------------------------------------------------------------- read state

  function markRead(key) {
    setRead(key, true)
  }

  function markUnread(key) {
    setRead(key, false)
  }

  function setRead(key, read) {
    var k = String(key || "")
    if (!k) return
    var next = entries.slice()
    for (var i = 0; i < next.length; i++) {
      if (next[i].key !== k) continue
      if (next[i].unread === !read) return
      var copy = {}
      for (var role in next[i]) copy[role] = next[i][role]
      copy.unread = !read
      next[i] = copy
      entries = next
      scheduleSave()
      return
    }
  }

  function markAllRead() {
    if (unreadCount === 0) return
    var next = []
    for (var i = 0; i < entries.length; i++) {
      var copy = {}
      for (var role in entries[i]) copy[role] = entries[i][role]
      copy.unread = false
      next.push(copy)
    }
    entries = next
    scheduleSave()
  }

  // Drop one entry without moving the cleared watermark: the sender replaced
  // it in place, and the replacement is on its way in as an entry of its own.
  function forget(key) {
    var k = String(key || "")
    var next = entries.filter(function(entry) { return entry.key !== k })
    if (next.length === entries.length) return
    entries = next
    scheduleSave()
  }

  // Empties the center. The first-party history is left as it is — its own
  // `showHistory` replay is not this plugin's to erase — so the watermark
  // below is what keeps the sweep from reading it all straight back in.
  function clearAll() {
    var newest = 0
    for (var i = 0; i < entries.length; i++)
      if (entries[i].timestamp > newest) newest = entries[i].timestamp
    // Anything still on screen outlives the clear: it has not been dealt
    // with yet, and it would reappear on the next ingest anyway.
    clearedBefore = Math.max(clearedBefore, newest)
    // Cleared is dealt with, as far as the senders are concerned.
    live.releaseAll()
    entries = []
    scheduleSave()
    ingestPopups()
  }

  // ------------------------------------------------------------- activation

  // Click-through for a center row: the same steps, in the same order, that
  // clicking the toast runs.
  //
  //   1. Omarchy's own action toasts carry their click as data (execArgv),
  //      which the store keeps, so they work from a row indefinitely.
  //   2. The sender's own default action — Slack's "open this channel",
  //      Ghostty's "raise this tab" — kept alive past the toast by
  //      LiveNotifications. The only step that can reach the exact target.
  //   3. Bring the sender's window forward. All that is left once the
  //      notification is closed at the sender: after a shell restart, for one
  //      silenced under do-not-disturb, or when the first-party's shape has
  //      changed under us and nothing is being retained.
  //
  // A toast still on screen comes down with the click, as it would have had
  // the toast itself been clicked.
  function activate(key) {
    var k = String(key || "")
    var entry = entryFor(k)
    markRead(k)
    if (!entry) return

    var argv = Center.parseExecArgv(entry.execArgv)
    if (argv) {
      // Detached so it outlives the shell, which installer toasts depend on:
      // they restart it.
      Util.execArgv(argv)
      live.release(k)
    } else if (!live.invoke(k)) {
      live.release(k)
      focusWindow(Center.focusPatterns(entry))
    }
    dismissToast(k)
  }

  function dismissToast(key) {
    if (!sourceReady || !source.popupModel || typeof source.dismissPopup !== "function") return
    var model = source.popupModel
    for (var i = 0; i < model.count; i++) {
      var row = null
      try {
        row = model.get(i)
      } catch (e) {
        continue
      }
      if (row && row.originalId >= 0 && Center.rowKey(row) === key) {
        source.dismissPopup(i)
        return
      }
    }
  }

  // Focus an existing Hyprland window belonging to the sender, trying each
  // pattern in turn. The Omarchy helper does the case-insensitive matching.
  function focusWindow(patterns) {
    if (!patterns || patterns.length === 0 || focusProc.running) return
    focusProc.command = ["bash", "-c",
      'for pattern in "$@"; do omarchy-hyprland-focus-app "$pattern" && exit 0; done; exit 1',
      "--"].concat(patterns)
    focusProc.running = true
  }

  Process { id: focusProc; running: false }

  // ------------------------------------------------------------- persistence

  property bool storeLoaded: false

  FileView {
    id: storeFile
    path: service.storePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: service.loadStore(text(), true)
    // First run: the file does not exist yet. Without this branch the store
    // never counts as loaded, every save stays a no-op, and nothing is ever
    // written.
    onLoadFailed: service.loadStore("", false)
  }

  Timer {
    id: saveTimer
    interval: 400
    repeat: false
    onTriggered: service.flushStore()
  }

  function scheduleSave() {
    if (!service.storeLoaded) return
    saveTimer.restart()
  }

  function loadStore(raw, existed) {
    if (service.storeLoaded) return

    // Only a genuine first run gets the read-everything grace above; a store
    // that already exists has been tracking read state all along.
    service.primed = existed === true

    var loaded = []
    var watermark = 0
    try {
      var parsed = JSON.parse(String(raw || "").trim() || "{}")
      if (parsed && Array.isArray(parsed.entries)) {
        for (var i = 0; i < parsed.entries.length; i++) {
          var value = parsed.entries[i]
          if (!value || !value.key) continue
          var entry = Center.entryFromRow(value)
          if (!entry) continue
          entry.key = String(value.key)
          entry.unread = value.unread === true
          loaded.push(entry)
        }
      }
      watermark = Number(parsed && parsed.clearedBefore) || 0
    } catch (e) {
      console.warn("notification-center: store parse failed:", e)
    }

    service.clearedBefore = watermark
    // Notifications can land in the tick between startup and this read
    // finishing; folding what is already in memory in keeps them.
    service.entries = Center.normalize(loaded.concat(service.entries), service.retention)
    service.storeLoaded = true

    // Pick up whatever arrived while the shell was not running, then take
    // over from the live model.
    service.sweepHistory()
    service.ingestPopups()
  }

  function flushStore() {
    storeFile.setText(JSON.stringify({
      version: 1,
      clearedBefore: service.clearedBefore,
      entries: service.entries
    }) + "\n")
  }

  Process {
    id: ensureDirProc
    command: ["mkdir", "-p", service.stateDir]
    running: false
  }

  Component.onCompleted: {
    ensureDirProc.running = true
    // Give mkdir a tick before the read; FileView reports a missing file
    // through onLoadFailed, which loadStore handles.
    Qt.callLater(function() { storeFile.reload() })
  }
}

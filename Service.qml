import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Notifications
import qs.Commons
import "Center.js" as Center

// Notification center store.
//
// This plugin does NOT fork the notification daemon. Omarchy's first-party
// `omarchy.notifications` keeps that role — it draws the toasts, owns
// do-not-disturb and decides what leaves the screen when — but since Omarchy
// 4.0.3 a plugin's `shell.serviceFor` resolves only the plugin's own service,
// so the first-party can no longer be attached to from the outside. It is
// attached to from the inside instead: this plugin registers as the clone of
// `omarchy.notifications` (see manifest.json), which makes it the enabled
// implementation of that target, and then runs the *installed* first-party
// service, unmodified and loaded by path, as `inner`. Every Omarchy update to
// that file is picked up as it lands, and the shell's own consumers — the
// bar's do-not-disturb indicator, `omarchy-shell notifications …` — reach it
// through here exactly as they did before.
//
// Two things ride on that. The center's own record of every notification
// comes from a second `NotificationServer` wrapper: Quickshell keeps one
// server per process and hands every wrapper the same live objects, with
// everything they carry (transient hint, requested timeout, desktop entry,
// actions, and later the reason they closed). And with the first-party's
// `liveRefs` in reach, a notification can be kept open at its sender past
// its toast, so a row click can still run the very action the toast would
// have (see LiveNotifications.qml).
Item {
  id: service

  // Injected by omarchy-shell's service loader, and handed on to the
  // embedded first-party, which reads the bar's position and size off it.
  property var shell: null
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: home + "/.local/state/byj-notification-center/"
  readonly property string storePath: stateDir + "store.json"

  // How many notifications the center keeps. The first-party history is
  // capped at ten; this store is the reason the "All" tab can go deeper.
  readonly property int retention: 500

  // When this graphical session started, from Hyprland's instance signature.
  // Everything from before it is from a session whose windows are gone.
  readonly property double sessionStart: Center.sessionStartFromSignature(Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE"))

  // ------------------------------------------------------------- first-party

  // The installed first-party notification service, running in here.
  property var inner: null
  readonly property string innerUrl: "file://" + omarchyPath + "/shell/plugins/notifications/Service.qml"

  function loadInner() {
    var component = Qt.createComponent(innerUrl)
    if (component.status !== Component.Ready) {
      console.warn("notification-center: could not load the first-party notification service from "
        + innerUrl + ": " + component.errorString())
      return
    }
    inner = component.createObject(service, { shell: service.shell, omarchyPath: service.omarchyPath })
    if (!inner) console.warn("notification-center: the first-party notification service failed to start")
  }

  onShellChanged: if (inner) inner.shell = service.shell
  onOmarchyPathChanged: if (inner) inner.omarchyPath = service.omarchyPath

  // Do-not-disturb stays the first-party's state; the bell only mirrors and
  // toggles it, so the two never disagree. These two are also what the
  // shell reads off the enabled notifications service, which is now this.
  readonly property bool doNotDisturb: inner ? inner.doNotDisturb === true : false

  function setDoNotDisturb(value) {
    if (inner && typeof inner.setDoNotDisturb === "function") inner.setDoNotDisturb(value === true)
  }

  // ------------------------------------------------------------- store

  // Newest-first plain snapshots. Deliberately not the live Notification
  // objects: those die with their sender, and reading a role off a destroyed
  // one is a crash rather than an error.
  property var entries: []

  // What the panel lists: consecutive repeats folded into one row each.
  readonly property var allGroups: Center.groupRuns(entries)
  readonly property var unreadGroups: Center.groupRuns(entries.filter(function(entry) { return entry.unread === true }))

  // The badge counts rows, not repeats: five identical pings are one thing
  // to look at.
  readonly property int unreadCount: unreadGroups.length

  // Notifications cleared out of the center. Anything at or before this
  // watermark is refused on the way in, so an in-place edit of a cleared
  // notification cannot bring it back.
  property double clearedBefore: 0

  function entryFor(key) {
    var k = String(key || "")
    for (var i = 0; i < entries.length; i++) if (entries[i].key === k) return entries[i]
    return null
  }

  function isUnread(key) {
    var entry = entryFor(key)
    return entry ? entry.unread === true : false
  }

  // ------------------------------------------------------------- daemon

  // Same advertised capabilities as the first-party, so whichever of the two
  // wrappers goes live last leaves GetCapabilities unchanged.
  NotificationServer {
    id: server
    keepOnReload: false
    imageSupported: true
    actionsSupported: true
    bodyMarkupSupported: true
    bodyHyperlinksSupported: true
    persistenceSupported: true

    onNotification: function(notification) { service.receive(notification) }
  }

  // The live objects behind entries the daemon still considers open, by
  // key, for the sake of hearing why each one closes. Everything else about
  // a notification is a snapshot.
  property var held: ({})

  readonly property var updateSignals: [
    "summaryChanged", "bodyChanged", "appNameChanged", "appIconChanged",
    "urgencyChanged", "expireTimeoutChanged", "hintsChanged"
  ]

  // Kept open at the sender past their toasts, so their rows can still run
  // the sender's own click.
  LiveNotifications {
    id: live
    source: service.inner
    onSuperseded: function(key, notification) {
      service.forget(key)
      service.receive(notification)
    }
    onDismissedOnScreen: function(key) { service.markRead(key) }
  }

  readonly property int liveCount: live.count

  // A plain copy of what the entry needs, taken in one go: the object can be
  // torn down by the server at any later point.
  function snapshot(notification, timestamp) {
    var props = null
    try {
      props = {
        id: notification.id,
        appName: notification.appName,
        appIcon: notification.appIcon,
        desktopEntry: notification.desktopEntry,
        summary: notification.summary,
        body: notification.body,
        urgency: notification.urgency,
        expireTimeout: notification.expireTimeout,
        transient: notification.transient,
        hints: notification.hints
      }
    } catch (e) {
      return null
    }
    return Center.entryFromNotification(props, timestamp)
  }

  function receive(notification) {
    var now = Date.now()
    var entry = snapshot(notification, now)
    if (!entry) return
    // "Skip any kind of persistence" is what the hint asks for.
    if (entry.transient) return
    if (entry.timestamp <= service.clearedBefore) return

    // Noise is kept — it is still findable under All — but arrives read.
    if (Center.noiseReason(entry)) entry.unread = false

    var record = {
      key: entry.key,
      timestamp: now,
      notification: notification,
      handlers: []
    }
    held[entry.key] = record
    connectSignals(record)
    absorb([entry])

    // The first-party's own handler is what puts the object into liveRefs,
    // and it runs after this one; take hold once it has.
    Qt.callLater(function() { live.retain(entry.key, notification, entry.id) })
  }

  function connectSignals(record) {
    var n = record.notification
    var onUpdate = function() { service.refresh(record) }
    var onClosed = function(reason) { service.closedAt(record, reason) }
    var onGone = function() { service.drop(record) }

    function hook(signal, fn) {
      if (!signal || typeof signal.connect !== "function") return
      signal.connect(fn)
      record.handlers.push({ signal: signal, fn: fn })
    }
    for (var i = 0; i < updateSignals.length; i++) hook(n[updateSignals[i]], onUpdate)
    hook(n.closed, onClosed)
    // A server torn down under us destroys without closing.
    try { hook(n.destroyed, onGone) } catch (e) {}
  }

  // A client updating a notification through replaces_id writes the new
  // content onto the object already held. Same key, same read flag; only
  // what the row paints changes.
  function refresh(record) {
    if (held[record.key] !== record) return
    var entry = snapshot(record.notification, record.timestamp)
    if (!entry || entry.transient) return
    absorb([entry])
  }

  function closedAt(record, reason) {
    if (held[record.key] !== record) return
    drop(record)
    if (Center.readOnClose(reason, service.doNotDisturb)) markRead(record.key)
  }

  // Forget a record without touching the notification itself.
  function drop(record) {
    if (held[record.key] !== record) return
    delete held[record.key]
    for (var i = 0; i < record.handlers.length; i++) {
      try {
        record.handlers[i].signal.disconnect(record.handlers[i].fn)
      } catch (e) {}
    }
    record.handlers = []
  }

  // ------------------------------------------------------------- ingest

  // Fold entries into the store. Entries already known keep their read flag
  // — an edit must never resurrect something the user has read — but pick
  // up the changes the sender made in place.
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
    var record = held[k]
    if (record) drop(record)
    var next = entries.filter(function(entry) { return entry.key !== k })
    if (next.length === entries.length) return
    entries = next
    scheduleSave()
  }

  // Empties the center. Toasts still on screen are the first-party's and
  // stay put; the watermark keeps their later edits and closes from
  // reinstating them here. Cleared is dealt with, as far as the senders are
  // concerned.
  function clearAll() {
    var newest = 0
    for (var i = 0; i < entries.length; i++)
      if (entries[i].timestamp > newest) newest = entries[i].timestamp
    clearedBefore = Math.max(clearedBefore, newest)
    live.releaseAll()
    entries = []
    scheduleSave()
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
    dismissToast(entry)
  }

  // Run a row's members as one: the newest gets the click, the rest are
  // simply done with.
  function activateGroup(keys) {
    var list = Array.isArray(keys) ? keys : []
    if (list.length === 0) return
    activate(list[0])
    for (var i = 1; i < list.length; i++) markRead(list[i])
  }

  function markGroupRead(keys) {
    var list = Array.isArray(keys) ? keys : []
    for (var i = 0; i < list.length; i++) markRead(list[i])
  }

  // The toast for an entry, live or restored after a shell restart, is the
  // popup row carrying its daemon id from the same moment.
  function dismissToast(entry) {
    if (!inner || !inner.popupModel || typeof inner.dismissPopup !== "function") return
    var model = inner.popupModel
    for (var i = model.count - 1; i >= 0; i--) {
      var row = null
      try {
        row = model.get(i)
      } catch (e) {
        continue
      }
      if (row && row.originalId >= 0 && Center.toastRowMatches(row, entry)) inner.dismissPopup(i)
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
    onLoaded: service.loadStore(text())
    // First run: the file does not exist yet. Without this branch the store
    // never counts as loaded, every save stays a no-op, and nothing is ever
    // written.
    onLoadFailed: service.loadStore("")
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

  function loadStore(raw) {
    if (service.storeLoaded) return

    var loaded = []
    var watermark = 0
    try {
      var parsed = JSON.parse(String(raw || "").trim() || "{}")
      if (parsed && Array.isArray(parsed.entries)) {
        for (var i = 0; i < parsed.entries.length; i++) {
          var entry = Center.entryFromStored(parsed.entries[i])
          if (!entry) continue
          // Unread from a previous session has nothing left to point at.
          if (entry.unread && Center.isFromPastSession(entry, service.sessionStart)) entry.unread = false
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
    // The past-session pass above only touched what was on disk; write it
    // back so the next load does not redo it.
    scheduleSave()
  }

  function flushStore() {
    storeFile.setText(JSON.stringify({
      version: 2,
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
    // The first-party goes up first: its wrapper registers after this
    // service's own, and nothing should arrive between the two.
    loadInner()
    // Give mkdir a tick before the read; FileView reports a missing file
    // through onLoadFailed, which loadStore handles.
    Qt.callLater(function() { storeFile.reload() })
  }
}

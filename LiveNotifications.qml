import QtQuick
import "Center.js" as Center

// Keeps a notification open past its toast, so a center row can still run the
// click its toast would have run.
//
// Why: the one thing that makes clicking a Slack toast open the channel, or a
// Ghostty toast raise the right tab, is the sender's own "default" action — a
// libnotify action that only works while the sender still considers the
// notification open. The first-party service closes a notification the moment
// its toast leaves the screen, which is exactly when the center becomes the
// way to reach it. GNOME's notification list gets this right by not closing
// on banner timeout; this does the same from the outside.
//
// How: the first-party keeps its live Notification objects in `liveRefs`,
// keyed by id, and reaches them from three places. Each object is swapped for
// a stand-in that answers two of those the same way and absorbs the third:
//
//   removePopup         reads ref.tracked, calls ref.expire() / ref.dismiss()
//                       -> the stand-in reports tracked and ignores the close,
//                          so the toast leaves without the sender hearing of it
//   invokePopupDefault  reads ref.actions to invoke "default"
//                       -> forwarded to the real object; the toast still clicks
//   refreshPopup        requires liveRefs[id] === notification (identity)
//                       -> would silently stop in-place updates reaching the
//                          toast; the real object is put back around each
//                          forwarded call instead (forwardRefresh)
//
// An update arriving once the toast is gone is what the first-party would
// otherwise have received as a brand-new notification — the old one would
// have been closed by then — so it is handed to handleNotification and
// becomes a new toast and a new row, superseding the stale one.
//
// A retained notification is closed at the sender when the user acts on it
// (invoke), clears the center, or it ages out of the store — never on
// mark-as-read, so a row in the All tab stays as clickable as its toast was.
//
// Contract with omarchy.notifications (Omarchy 4.0.x), checked at runtime by
// `supported`. When any of it is missing nothing is retained and rows fall
// back to focusing the sender's window, which is what they did before:
//   property var liveRefs           id -> Notification, a mutable plain object
//   popupModel                      rows carrying originalId and timestamp
//   isRestoredRow(row)              rows with no live object behind them
//   refreshPopup(n, id, timestamp)  in-place toast update
//   handleNotification(n)           the onNotification entry point
//   updateSignals                   optional: what refreshPopup listens for
QtObject {
  id: live

  // The first-party notification service.
  property var source: null

  readonly property bool supported: source !== null && source !== undefined
    && typeof source.liveRefs === "object" && source.liveRefs !== null
    && source.popupModel !== null && source.popupModel !== undefined
    && typeof source.isRestoredRow === "function"
    && typeof source.refreshPopup === "function"
    && typeof source.handleNotification === "function"

  // Retained notifications by store key. Mutated in place; `count` is the
  // bindable view of its size.
  property var records: ({})
  property int count: 0

  // An update to a notification whose toast had already gone was re-shown
  // as a new one; the row under this key is the stale content it replaced.
  signal superseded(string key)

  readonly property var defaultUpdateSignals: [
    "summaryChanged", "bodyChanged", "appNameChanged", "appIconChanged",
    "imageChanged", "urgencyChanged", "expireTimeoutChanged", "hintsChanged"
  ]

  // Said once, and only once it matters: the first time a row could have
  // been retained and was not.
  property bool warned: false

  // ------------------------------------------------------------- retain

  // Called for every row the popup model holds, as often as the model
  // changes. Idempotent: a row already retained is left alone.
  function retain(row) {
    if (!supported) {
      if (source && !warned) {
        warned = true
        console.warn("notification-center: omarchy.notifications does not look like"
          + " Omarchy 4.0 any more; rows fall back to focusing the sender's window")
      }
      return
    }
    if (!row || row.originalId < 0) return
    var key = Center.rowKey(row)
    if (records[key]) return

    var restored = true
    try {
      restored = source.isRestoredRow(row) === true
    } catch (e) {
      return
    }
    // Restored rows outlived their server object; their old-generation id
    // may meanwhile belong to a fresh, unrelated notification.
    if (restored) return

    var current = source.liveRefs[row.originalId]
    if (!current) return
    // A stand-in left by a previous instance of this service still carries
    // the object it stood in for.
    var notification = current.byjLive === true ? current.notification : current
    if (!notification || typeof notification.dismiss !== "function") return

    // One object can only be held once. It moves to the new key when a
    // re-shown update lands (see updated), and the old key goes.
    var prior = recordFor(notification)
    if (prior) drop(prior)

    var record = {
      key: key,
      originalId: row.originalId,
      timestamp: Number(row.timestamp) || 0,
      notification: notification,
      standIn: null,
      handlers: []
    }
    record.standIn = makeStandIn(record)
    records[key] = record
    count++
    source.liveRefs[record.originalId] = record.standIn
    connectSignals(record)

    // The catch-up refresh the first-party runs right after inserting the
    // row will now meet the stand-in and bail; run it on the real object.
    // Deferred: it writes model roles, and this may be running inside the
    // model change that revealed the row.
    Qt.callLater(function() { forwardRefresh(record) })
  }

  function makeStandIn(record) {
    var n = record.notification
    return {
      byjLive: true,
      notification: n,
      get tracked() {
        try { return n.tracked === true } catch (e) { return false }
      },
      get actions() {
        try { return n.actions } catch (e) { return [] }
      },
      // The toast leaving the screen is not the notification closing.
      expire: function() {},
      dismiss: function() {}
    }
  }

  function connectSignals(record) {
    var n = record.notification
    var names = Array.isArray(source.updateSignals) ? source.updateSignals : defaultUpdateSignals
    var onUpdate = function() { live.updated(record) }
    var onGone = function() { live.drop(record) }

    function hook(signal, fn) {
      if (!signal || typeof signal.connect !== "function") return
      signal.connect(fn)
      record.handlers.push({ signal: signal, fn: fn })
    }
    for (var i = 0; i < names.length; i++) hook(n[names[i]], onUpdate)
    hook(n.closed, onGone)
    // Belt and braces: a server torn down under us destroys without closing.
    try { hook(n.destroyed, onGone) } catch (e) {}
  }

  function recordFor(notification) {
    for (var key in records) {
      if (records[key].notification === notification) return records[key]
    }
    return null
  }

  function has(key) {
    return records[String(key || "")] !== undefined
  }

  // ------------------------------------------------------------- updates

  function updated(record) {
    if (records[record.key] !== record) return
    if (onScreen(record)) {
      forwardRefresh(record)
      return
    }
    // Handlers off first: one update fires one signal per changed property,
    // and only the first may re-show. Anything that changes between now and
    // the new row landing is picked up by the first-party's own catch-up.
    var notification = record.notification
    var key = record.key
    drop(record)
    try {
      source.handleNotification(notification)
    } catch (e) {
      console.warn("notification-center: could not re-show updated notification:", e)
      return
    }
    live.superseded(key)
  }

  function onScreen(record) {
    var model = source.popupModel
    for (var i = 0; i < model.count; i++) {
      var row = null
      try {
        row = model.get(i)
      } catch (e) {
        continue
      }
      if (row && row.originalId === record.originalId && row.timestamp === record.timestamp) return true
    }
    return false
  }

  // refreshPopup only acts when liveRefs holds the very object it was handed,
  // so the real one is put back for the duration of the call.
  function forwardRefresh(record) {
    if (records[record.key] !== record) return
    var id = record.originalId
    if (source.liveRefs[id] !== record.standIn) return
    source.liveRefs[id] = record.notification
    try {
      source.refreshPopup(record.notification, id, record.timestamp)
    } catch (e) {
      console.warn("notification-center: toast refresh failed:", e)
    }
    if (source.liveRefs[id] === record.notification) source.liveRefs[id] = record.standIn
  }

  // ------------------------------------------------------------- act

  // Run the notification's own click, the way the toast would. False when
  // nothing is retained under the key or the sender registered no default
  // action, so the caller can fall back.
  function invoke(key) {
    var record = records[String(key || "")]
    if (!record) return false
    var action = defaultAction(record.notification)
    if (!action) return false
    try {
      action.invoke()
    } catch (e) {
      console.warn("notification-center: invoke failed:", e)
      drop(record)
      return false
    }
    // invoke() closes a non-resident notification itself, which lands in
    // drop through the closed signal. A resident one asked to outlive its
    // activation and stays reachable.
    return true
  }

  function defaultAction(notification) {
    try {
      var actions = notification.actions
      for (var i = 0; i < actions.length; i++) {
        if (actions[i] && actions[i].identifier === "default") return actions[i]
      }
    } catch (e) {
      // Torn down by the server — nothing to invoke.
    }
    return null
  }

  // Tell the sender the notification is done with, and forget it.
  function release(key) {
    var record = records[String(key || "")]
    if (record) close(record)
  }

  function releaseAll() {
    prune({})
  }

  // Release everything not under a key in `keep`.
  function prune(keep) {
    var stale = []
    for (var key in records) {
      if (!keep[key]) stale.push(records[key])
    }
    for (var i = 0; i < stale.length; i++) close(stale[i])
  }

  function close(record) {
    var notification = record.notification
    drop(record)
    try {
      if (notification.tracked) notification.dismiss()
    } catch (e) {
      // Already gone.
    }
  }

  // Forget a record without touching the notification itself.
  function drop(record) {
    if (records[record.key] !== record) return
    delete records[record.key]
    count--
    for (var i = 0; i < record.handlers.length; i++) {
      try {
        record.handlers[i].signal.disconnect(record.handlers[i].fn)
      } catch (e) {}
    }
    record.handlers = []
    try {
      if (source.liveRefs[record.originalId] === record.standIn)
        delete source.liveRefs[record.originalId]
    } catch (e) {}
  }

  // Hand everything back on the way out: what is still on screen returns
  // to the first-party as it was, what is not is closed — nothing will be
  // able to click it once this instance is gone.
  Component.onDestruction: {
    var all = []
    for (var key in records) all.push(records[key])
    for (var i = 0; i < all.length; i++) {
      var record = all[i]
      try {
        if (onScreen(record)) {
          var wasOurs = source.liveRefs[record.originalId] === record.standIn
          drop(record)
          if (wasOurs) source.liveRefs[record.originalId] = record.notification
        } else {
          close(record)
        }
      } catch (e) {
        // Source already torn down alongside us.
      }
    }
  }
}

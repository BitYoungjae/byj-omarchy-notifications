# Notification Center

An [Omarchy 4](https://omarchy.org) shell plugin: a bell in the bar carrying an
unread badge, opening a flyout that lists your notifications under two tabs —
**Unread** and **All**. Clicking a row does what clicking the toast would have
done, even long after the toast is gone.

![Notification Center](preview.png)

## Why

Omarchy's built-in notification service shows toasts and keeps the last ten of
them for `showHistory` to replay. That is all it is meant to do. This plugin
adds the three things a notification centre needs on top of it:

- **a read flag per notification**, so the bell can carry a count of what you
  have not looked at yet
- **a deeper backlog** — 500 notifications instead of ten
- **click-through that outlives the toast** — a Slack notification still opens
  its channel, a Claude Code notification still raises its Ghostty tab, from
  the list, minutes later

It does **not** replace the notification daemon. `omarchy.notifications` keeps
the D-Bus name, the toasts and do-not-disturb; this plugin attaches to it
in-process and keeps its own store alongside. So it installs with one command,
coexists with everything, and does not need re-syncing every Omarchy release.

## Install

```bash
omarchy plugin add https://github.com/BitYoungjae/byj-omarchy-notifications.git --enable
```

Pick a bar section when prompted, or place it afterwards:

```bash
omarchy bar move byj.notification-center --section right
```

To update or remove:

```bash
omarchy plugin update byj.notification-center
omarchy plugin remove byj.notification-center
```

## Use

| Action | Result |
|---|---|
| Left click the bell | Open / close the flyout |
| Right click the bell | Toggle do-not-disturb |
| Left click a row | Run the notification's click, exactly as clicking its toast would, or bring the sender's window forward; marks it read and closes |
| Right click a row | Mark read without leaving the list |
| `Mark all read` | Clear the badge, keep the list |
| `Clear` | Empty the centre (Omarchy's own history is left alone) |
| `←` / `→` | Switch tabs while the flyout has focus |

The bell shows an outline when everything is read, fills in when something is
not, and becomes a struck-through bell under do-not-disturb. The badge stays
visible while silenced — "what did I miss" is exactly what it is for.

### IPC

```bash
omarchy-shell notification-center toggle          # open / close the flyout
omarchy-shell notification-center unread          # the current unread count
omarchy-shell notification-center markAllRead
omarchy-shell notification-center clear
omarchy-shell notification-center activateLatest  # click through the newest unread (or newest) notification
omarchy-shell notification-center activate <key>  # click through one row; the key is <timestamp>-<id>.json
omarchy-shell notification-center status          # {"unread","total","live","liveActions","doNotDisturb"}
```

Handy for keybindings:

```lua
-- ~/.config/hypr/bindings.lua
o.bind("SUPER, N", "exec", "omarchy-shell notification-center toggle")
o.bind("SUPER SHIFT, N", "exec", "omarchy-shell notification-center activateLatest")
```

## How it works

Notifications are picked up from the first-party service's live popup model, in
process — no polling, no file watching, and no second daemon on the bus. Each
one is snapshotted into `~/.local/state/byj-notification-center/store.json`
with a read flag, newest 500 kept.

Do-not-disturb is the one case that never reaches that model: a silenced
notification is written straight into Omarchy's history directory and never
shown. So while do-not-disturb is on — and only then — the plugin also sweeps
that directory every five seconds. Omarchy keeps ten entries there, so nothing
is missed unless more than ten arrive between ticks.

### After a reboot

The first-party service mirrors every toast on screen to a file and re-shows
the files it finds when it starts, so that toasts survive the shell restart
`omarchy-update` performs. A toast that never expires — anything critical,
which is how Cursor asks for input and how Omarchy reports a crash — therefore
comes back after a reboot too, and after every reboot until it is dismissed.
Across a shell restart that is right; across a boot it is yesterday's, and the
centre is where it belongs. So a restored toast from before the current boot
is taken off the screen and left to its row, read flag intact. It is archived
into Omarchy's own history on the way, exactly as its expiry would have done,
so `showHistory` can still replay it — and a replay is left alone.

### Click-through

Clicking a row runs the same steps, in the same order, that clicking the toast
runs:

1. **Omarchy's own action toasts** carry their click as data (`execArgv`), which
   the store keeps, so they work from a row indefinitely.
2. **The sender's own default action** — what makes a Slack toast open its
   channel and a Ghostty toast raise the tab Claude Code is waiting in. A
   libnotify action only works while the sender still considers the
   notification open, and the first-party service closes it the moment the
   toast leaves the screen. So this plugin keeps the notification open at the
   sender past its toast (the way GNOME's notification list does), until you
   act on it, clear the centre, or it ages out of the store. Marking a row read
   does not close it, so rows in the All tab stay as clickable as their toasts
   were. See `LiveNotifications.qml` for the mechanism and for exactly which
   parts of the first-party service it relies on; if a future Omarchy changes
   them, the plugin notices at runtime and simply falls back to step 3.
3. **Focus the sender's window.** All that is left once the notification is
   closed at the sender: after a shell restart, for one that arrived silenced,
   or with the fallback above. Browser notifications are matched by the origin
   they came from (a Chrome web app's window is `chrome-app.slack.com…`, not
   "Google Chrome"), GLib applications that send no app name by their icon
   name (`com.mitchellh.ghostty`), everything else by name.

`status` tells you which of these a click can reach: `live` is how many
notifications are currently held open at their sender, and `liveActions` is
whether step 2 is available at all.

## Development

The pure helpers in `Center.js` have tests:

```bash
node --test
```

For a local checkout linked into `~/.config/omarchy/plugins/`, note that the
shell's hot reload watches that directory without following symlinks, and
`rescanPlugins` does not evict already-loaded widget code — use
`omarchy-restart-shell` to pick up changes.

## Requirements

Omarchy 4 (tested on 4.0.x). No other dependencies.

## Licence

MIT — see [LICENSE](LICENSE).

Omarchy itself is MIT-licensed by Basecamp. This plugin ships no Omarchy code;
it calls the shell's public plugin API (`qs.Ui`, `qs.Commons`,
`shell.serviceFor`), reads the state layout the notification service already
writes, and — for click-through only — attaches to that service's live
notification objects as described above.

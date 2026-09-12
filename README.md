# Notification Center

An [Omarchy 4](https://omarchy.org) shell plugin: a bell in the bar carrying an
unread badge, opening a flyout that lists your notifications under two tabs —
**Unread** and **All**. Clicking a row does what clicking the toast would have
done, even long after the toast is gone, and the badge only ever counts what
still deserves your attention.

![Notification Center](preview.png)

## Why

Omarchy's built-in notification service shows toasts and keeps the last ten of
them for `showHistory` to replay. That is all it is meant to do. This plugin
adds what a notification centre needs on top of it:

- **a read flag per notification**, so the bell can carry a count of what you
  have not looked at yet
- **a deeper backlog** — 500 notifications instead of ten
- **click-through that outlives the toast** — a Slack notification still opens
  its channel, a Claude Code notification still raises its Ghostty tab, from
  the list, minutes later
- **a badge that empties itself** when a notification stops mattering: after
  a reboot, when its sender withdraws it, when it was only ever a status
  flash, when it is the fifth copy of the same ping

It does **not** fork the notification daemon. `omarchy.notifications` keeps
drawing the toasts and owning do-not-disturb; this plugin runs the installed
first-party service unmodified, inside itself, and keeps its own store next to
it. So it installs with one command, follows every Omarchy update to that
service as it lands, and does not need re-syncing.

## Install

```bash
omarchy plugin add https://github.com/BitYoungjae/byj-omarchy-notifications.git --enable
```

Pick a bar section when prompted, or place it afterwards:

```bash
omarchy bar move byj.notification-center --section right
```

Enabling it makes it the active implementation of `omarchy.notifications`:
the built-in entry is switched off (it lands in `disabledPlugins` in
`~/.config/omarchy/shell.json`) and switched back on when the plugin is
disabled or removed. This is the same mechanism `omarchy plugin clone` uses,
declared in the manifest as `omarchy.clonedFrom`. Toasts, do-not-disturb and
`omarchy-shell notifications …` keep working exactly as before; the code
behind them is still Omarchy's own.

Upgrading from a version before 0.4 — one that was enabled before it declared
itself a clone — needs the switch made once:

```bash
omarchy plugin disable byj.notification-center
omarchy plugin enable byj.notification-center right --before byj.spotify   # your own placement
omarchy-restart-shell
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

A run of identical notifications — the same sender saying the same thing, as
five terminal tabs each announcing "Claude is waiting for your input" do — is
one row marked `×5`. Clicking it clicks the newest and marks all five read.

### IPC

```bash
omarchy-shell notification-center toggle          # open / close the flyout
omarchy-shell notification-center unread          # the current unread count (rows)
omarchy-shell notification-center markAllRead
omarchy-shell notification-center clear
omarchy-shell notification-center activateLatest  # click through the newest unread (or newest) row
omarchy-shell notification-center activate <key>  # click through one notification; the key is <timestamp>-<id>
omarchy-shell notification-center status          # {"unread","total","live","doNotDisturb"}
```

Handy for keybindings:

```lua
-- ~/.config/hypr/bindings.lua
o.bind("SUPER, N", "exec", "omarchy-shell notification-center toggle")
o.bind("SUPER SHIFT, N", "exec", "omarchy-shell notification-center activateLatest")
```

## How it works

Since Omarchy 4.0.3 a plugin's `shell.serviceFor` resolves only the plugin's
own service, so the first-party notification service cannot be attached to
from the outside any more. It is attached to from the inside instead: the
manifest declares this plugin the clone of `omarchy.notifications`, which
makes it the enabled implementation of that target, and its service loads
`/usr/share/omarchy/shell/plugins/notifications/Service.qml` — the installed
first-party, unmodified — and runs it as a child. The bar's do-not-disturb
indicator and the `notifications` IPC target reach that instance through this
plugin exactly as they reached the original.

The centre's own record of each notification comes from a second
`NotificationServer`: Quickshell keeps one server per process and hands every
wrapper declared in it the same live objects, with everything they carry —
the sender's desktop entry, the `transient` hint, the timeout it asked for,
its actions, and later the reason it closed. Each one is snapshotted into
`~/.local/state/byj-notification-center/store.json` with a read flag, newest
500 kept. A notification silenced by do-not-disturb reaches the store the
same way a shown one does.

### What counts as unread

A notification is unread from the moment it arrives until you act on it —
with four exceptions, each one a case where nothing is left to act on:

- **After a reboot.** A notification from before the current session is
  marked read when the store loads. Every window it could have pointed at
  died with the session, and the desktops that keep a notification list at
  all (GNOME, KDE) drop it entirely at logout. It stays under All. The
  session boundary is Hyprland's own start time, read from
  `HYPRLAND_INSTANCE_SIGNATURE`; a shell restart is not a boundary.
- **Noise.** A notification whose sender says it is not worth keeping arrives
  already read: `app_name` `notify-send` or `omarchy-action` (the two the
  first-party itself treats as ephemeral), low urgency, or a requested
  timeout under five seconds (a status flash such as "Background switched").
  One with the freedesktop `transient` hint is not stored at all, which is
  what the hint asks for.
- **Withdrawn by the sender.** When the sender closes its own notification —
  a chat app that saw you read the message there, a browser tab that closed —
  the row is marked read.
- **Dismissed on screen.** Closing or clicking the toast marks the row read
  too. A notification the shell silenced under do-not-disturb is not counted
  as dismissed: nobody saw it.

Expiry — the toast simply timing out — changes nothing: that is the case the
centre exists for.

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
   "Google Chrome"), GLib applications that send no app name by their desktop
   entry or icon name (`com.mitchellh.ghostty`), everything else by name.

`status` tells you how far a click can reach: `live` is how many notifications
are currently held open at their sender, which is the number step 2 applies to.

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

Omarchy 4.0.3 or later (tested on 4.0.3). The first-party service is loaded
from `$OMARCHY_PATH/shell/plugins/notifications/Service.qml`; if a future
Omarchy moves it, the plugin says so in the journal and toasts are not drawn
until it is updated. No other dependencies.

## Licence

MIT — see [LICENSE](LICENSE).

Omarchy itself is MIT-licensed by Basecamp. This plugin ships no Omarchy code;
it calls the shell's public plugin API (`qs.Ui`, `qs.Commons`,
`shell.serviceFor`), Quickshell's notification server API, runs the installed
first-party notification service as described above and — for click-through
only — attaches to that service's live notification objects.

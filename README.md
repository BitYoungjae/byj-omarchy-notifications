# Notification Center

An [Omarchy 4](https://omarchy.org) shell plugin: a bell in the bar carrying an
unread badge, opening a flyout that lists your notifications under two tabs —
**Unread** and **All**. Clicking a row does what clicking the toast would have
done, and the badge only ever counts what still deserves your attention.

![Notification Center](preview.png)

## Why

Omarchy's built-in notification service shows toasts and keeps the last ten of
them for `showHistory` to replay. That is all it is meant to do. This plugin
adds what a notification centre needs on top of it:

- **a read flag per notification**, so the bell can carry a count of what you
  have not looked at yet
- **a deeper backlog** — 500 notifications instead of ten
- **a badge that empties itself** when a notification stops mattering: after
  a reboot, when its sender withdraws it, when it was only ever a status
  flash, when it is the fifth copy of the same ping

It does **not** replace the notification daemon. `omarchy.notifications` keeps
the D-Bus name, the toasts and do-not-disturb; this plugin listens beside it,
in the same process, and keeps its own store. So it installs with one command,
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
| Left click a row | Run the notification's click, as clicking its toast would, or bring the sender's window forward; marks it read and closes |
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

Quickshell keeps one notification server per process, and every
`NotificationServer` declared in that process hears every notification it
receives. This plugin declares one of its own, next to the first-party's, and
snapshots each notification as it arrives — the same live object the toast is
drawn from, with everything it carries: the sender's desktop entry, the
`transient` hint, the timeout it asked for, its actions, and later the reason
it closed. Each snapshot goes into
`~/.local/state/byj-notification-center/store.json` with a read flag, newest
500 kept. Nothing is polled and nothing is read back out of Omarchy's history;
a notification silenced by do-not-disturb reaches the store the same way a
shown one does.

Do-not-disturb itself stays the first-party's: the bell mirrors the preference
file it writes (`~/.local/state/omarchy/notifications.json`) and toggles it
through `omarchy-shell notifications setDnd`.

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
  too, except under do-not-disturb, where it is the shell dismissing a
  notification nobody has seen.

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
   toast leaves the screen. So this step is there while the toast is, and
   gone afterwards.
3. **Focus the sender's window.** All that is left once the notification is
   closed at the sender. Browser notifications are matched by the origin they
   came from (a Chrome web app's window is `chrome-app.slack.com…`, not
   "Google Chrome"), GLib applications that send no app name by their desktop
   entry or icon name (`com.mitchellh.ghostty`), everything else by name.

`status` tells you how far a click can reach: `live` is how many notifications
are currently still open at the daemon, which is the number step 2 applies to.

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

Omarchy 4.0.3 or later. Earlier 4.0.x handed plugins a wider shell API; since
4.0.3 a plugin's `shell.serviceFor` resolves only its own service, which is
why this plugin listens to the daemon directly instead of attaching to the
first-party service. No other dependencies.

## Licence

MIT — see [LICENSE](LICENSE).

Omarchy itself is MIT-licensed by Basecamp. This plugin ships no Omarchy code;
it calls the shell's public plugin API (`qs.Ui`, `qs.Commons`,
`shell.serviceFor`), Quickshell's notification server API, and reads the one
preference file the first-party notification service writes.

import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Center.js" as Center

// Notification center: a bell in the bar carrying the unread count, and a
// flyout listing what came in. The list has two tabs — the notifications not
// read yet, and everything still inside the store's retention window.
//
// Presentation only. Read state and the row list live on this plugin's
// service half (Service.qml), so the badge stays correct whether or not a bar
// surface currently has this panel mounted.
Panel {
  id: root
  ipcTarget: "notification-center"
  // manageIpc: false so this panel can own the single IpcHandler the target
  // permits — needed for the unread and markAllRead methods below.
  manageIpc: false

  // Looked up by manifest id rather than `moduleName`, which the bar host
  // overwrites with whatever id the layout entry carries.
  readonly property var service: {
    var host = root.bar ? root.bar.shell : null
    if (!host || typeof host.serviceFor !== "function") return null
    return host.serviceFor("byj.notification-center")
  }

  readonly property int unreadCount: service ? service.unreadCount : 0
  readonly property bool dnd: service ? service.doNotDisturb : false

  readonly property var allRows: service ? service.entries : []
  readonly property var unreadRows: allRows.filter(function(row) { return row.unread === true })

  property string tab: "unread"
  readonly property var rows: tab === "unread" ? unreadRows : allRows

  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dimmed: Qt.darker(foreground, 1.5)

  // The bar sizes each slot from its widget's implicit size, so the panel
  // root has to carry the button's — an Item's own implicit size is zero,
  // and a zero-sized slot is skipped entirely.
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // Drives the "2m" / "3h" labels. One timer for the whole list, and only
  // while the list is on screen to read.
  property double now: Date.now()
  Timer {
    running: root.opened
    interval: 30000
    repeat: true
    triggeredOnStart: true
    onTriggered: root.now = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }

    function unread(): string {
      return String(root.unreadCount)
    }

    function markAllRead(): string {
      if (root.service) root.service.markAllRead()
      return "ok"
    }

    function clear(): string {
      if (root.service) root.service.clearAll()
      return "ok"
    }
  }

  // ---------------------------------------------------------- bar button

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.dnd ? "󰂛"
        : root.unreadCount > 0 ? "󰂚"
        : "󰂜"
    active: root.unreadCount > 0
    useActiveColor: false
    tooltipText: Center.tooltip(root.unreadCount, root.dnd)
    onPressed: function(b) {
      if (b === Qt.RightButton && root.service) root.service.setDoNotDisturb(!root.dnd)
      else root.toggle()
    }
  }

  // Unread marker. A count up to 99 fits as a pill; past that the bar is too
  // narrow for another digit, so it becomes "99+" and stops growing.
  //
  // Shown under do-not-disturb too: silencing suppresses the toast, not the
  // record of it, and "what did I miss while silenced" is the case the badge
  // is most useful for.
  Rectangle {
    id: badge
    visible: root.unreadCount > 0
    color: Color.urgent
    radius: height / 2
    height: Style.space(11)
    width: Math.max(height, badgeLabel.implicitWidth + Style.space(5))
    anchors.right: button.right
    anchors.top: button.top
    anchors.rightMargin: Style.space(1)
    anchors.topMargin: Style.space(1)

    Text {
      id: badgeLabel
      anchors.centerIn: parent
      text: Center.badgeText(root.unreadCount)
      color: "white"
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.bold: true
    }
  }

  // ---------------------------------------------------------- flyout

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.tab = dx > 0 ? "all" : "unread"
        else if (dy !== 0) list.flick(0, dy > 0 ? -600 : 600)
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        // ---------- header ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(title.implicitHeight, dndButton.implicitHeight)

          Text {
            id: title
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "Notifications"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Button {
            id: dndButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: root.dnd ? "󰂛" : "󰂚"
            tooltipText: root.dnd ? "Do not disturb is on" : "Silence notifications"
            selected: root.dnd
            bordered: true
            foreground: root.foreground
            accent: root.dnd ? Color.urgent : Color.accent
            fontFamily: root.fontFamily
            onClicked: if (root.service) root.service.setDoNotDisturb(!root.dnd)
          }
        }

        // ---------- tabs ----------
        ButtonGroup {
          id: tabs
          width: parent.width
          focusable: false
          value: root.tab
          foreground: root.foreground
          background: Color.popups.background
          accent: Color.accent
          fontFamily: root.fontFamily
          options: [
            { value: "unread", label: Center.tabLabel("Unread", root.unreadRows.length) },
            { value: "all", label: Center.tabLabel("All", root.allRows.length) }
          ]
          onChanged: function(value) { root.tab = value }
        }

        Rectangle {
          width: parent.width
          height: Math.max(1, Style.space(1))
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        // ---------- list ----------
        Item {
          width: parent.width
          implicitHeight: root.rows.length === 0
            ? empty.implicitHeight + Style.space(28)
            : Math.min(list.contentHeight, Style.space(380))

          Text {
            id: empty
            anchors.centerIn: parent
            visible: root.rows.length === 0
            horizontalAlignment: Text.AlignHCenter
            text: root.tab === "unread" ? "Nothing unread" : "No notifications yet"
            color: root.dimmed
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          ListView {
            id: list
            anchors.fill: parent
            visible: root.rows.length > 0
            clip: true
            spacing: Style.space(2)
            model: root.rows
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            delegate: Item {
              id: entry
              required property var modelData
              required property int index

              readonly property bool unread: modelData.unread === true

              width: ListView.view.width
              implicitHeight: entryBody.implicitHeight + Style.space(14)

              Rectangle {
                anchors.fill: parent
                radius: Style.cornerRadius
                color: entryMouse.containsMouse
                  ? Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.08)
                  : "transparent"
              }

              // Unread marker. The row itself only dims once read, so the dot
              // is what carries the state at a glance.
              Rectangle {
                id: dot
                visible: entry.unread
                width: Style.space(6)
                height: width
                radius: width / 2
                color: Color.urgent
                anchors.left: parent.left
                anchors.leftMargin: Style.space(3)
                anchors.top: parent.top
                anchors.topMargin: Style.space(11)
              }

              Column {
                id: entryBody
                anchors.left: parent.left
                anchors.leftMargin: Style.space(16)
                anchors.right: parent.right
                anchors.rightMargin: Style.space(4)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)

                Item {
                  width: parent.width
                  implicitHeight: Math.max(appLabel.implicitHeight, timeLabel.implicitHeight)

                  Text {
                    id: appLabel
                    anchors.left: parent.left
                    anchors.right: timeLabel.left
                    anchors.rightMargin: Style.space(8)
                    text: Center.appLabel(entry.modelData)
                    color: root.dimmed
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                    font.letterSpacing: 0.8
                    elide: Text.ElideRight
                  }

                  Text {
                    id: timeLabel
                    anchors.right: parent.right
                    text: Center.relativeTime(entry.modelData.timestamp, root.now)
                    color: root.dimmed
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                Text {
                  width: parent.width
                  visible: text !== ""
                  text: String(entry.modelData.summary || "")
                  color: entry.unread ? root.foreground : Qt.darker(root.foreground, 1.25)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.bold: entry.unread
                  elide: Text.ElideRight
                }

                Text {
                  width: parent.width
                  visible: text !== ""
                  text: Center.bodyText(entry.modelData)
                  color: root.dimmed
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.Wrap
                  maximumLineCount: 2
                  elide: Text.ElideRight
                }
              }

              MouseArea {
                id: entryMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                cursorShape: Qt.PointingHandCursor
                // Left mirrors clicking the toast: run the notification's own
                // action, or focus the app that sent it, and get out of the
                // way. Right only clears the unread mark, for working down a
                // backlog without leaving the list.
                onClicked: function(mouse) {
                  if (!root.service) return
                  if (mouse.button === Qt.RightButton) {
                    root.service.markRead(entry.modelData.key)
                    return
                  }
                  root.service.activate(entry.modelData.key)
                  root.close()
                }
              }
            }
          }
        }

        Rectangle {
          width: parent.width
          height: Math.max(1, Style.space(1))
          color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
        }

        // ---------- footer ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(markAll.implicitHeight, clearAll.implicitHeight)

          Button {
            id: markAll
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "Mark all read"
            iconText: "󰄬"
            bordered: true
            foreground: root.foreground
            accent: Color.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            onClicked: if (root.service) root.service.markAllRead()
          }

          Button {
            id: clearAll
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "Clear"
            iconText: "󰃢"
            bordered: true
            foreground: root.foreground
            accent: Color.urgent
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            // Empties the center. Omarchy's own notification history is left
            // alone — this only clears what this plugin accumulated.
            onClicked: if (root.service) root.service.clearAll()
          }
        }
      }
    }
  }
}

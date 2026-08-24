# rxy-web — one remote for every rxy robot

Shown in the app as **BLE REMOTE**. It was "MICRO:BIT REMOTE" until v2.29, back
when a micro:bit was the only thing it talked to — but the protocol is a
Nordic-UART GATT service, not anything micro:bit-specific, and an ESP32-C3 that
speaks it is served exactly the same way. Naming the app after one of its
robots was telling owners of the others that it was not for them.

A drag-and-drop Bluetooth remote that runs in the browser. Nothing to install,
no account, no WiFi.

**The robot owns the layout.** This app is a renderer: it connects, asks the
robot for its configuration, and draws whatever comes back. Point it at a
different robot and it shows that robot's controls instead. There is nothing
to configure on the browser side, and no per-robot build of this app.

## Use it

Open `index.html` in **Chrome** or **Edge** — Safari and Firefox have no Web
Bluetooth. Press **Connect**, pick your robot, and its panel appears.

Web Bluetooth needs a secure context, so serve the folder over `localhost` or
HTTPS rather than opening it from a network share.

### Sharing it

**⧉ Share** in the header shows a QR code of
<https://abourdim.github.io/rxy_web/>, so the next person can point a phone at
your screen instead of typing a URL on a tablet keyboard.

The code is **baked into `index.html`**, not generated at runtime: the address
is a constant, so an encoder would be code to maintain for a fixed picture.
It always encodes the published address, never `location.href` — demonstrate
this from `file://` or a laptop's `localhost` and a generated code would hand
someone a link their phone cannot reach.

Regenerate it only if that address changes:

```bash
python tools/make-qr.py
```

It re-splices the SVG between the `qr:begin`/`qr:end` markers and refuses to
write if the path it produced does not reproduce the QR matrix exactly.

## Robots that speak this protocol

| robot | firmware |
|---|---|
| Keyes 4WD Mecanum (micro:bit) | [`keystudio_4wd_mecanum_rxy`](https://github.com/abourdim/keystudio_4wd_mecanum_rxy) |
| Maqueen (micro:bit) | [`maqueen-rxy`](https://github.com/abourdim/maqueen-rxy) |
| DFRobot micro:Driver rover (micro:bit) | [`dfrobot-rover`](https://github.com/abourdim/dfrobot-rover) |
| ESP32-C3 Super Mini (b3) | [`esp32c3_super_mini_robot-bit-rxy`](https://github.com/abourdim/esp32c3_super_mini_robot-bit-rxy) |
| ESP32-C3 Super Mini — servos + sonar | [`esp32c3_super_mini_servo_sonar-rxy`](https://github.com/abourdim/esp32c3_super_mini_servo_sonar-rxy) |
| plain ESP32-C3, no robot — reference firmware and widget demo | [`esp32-rxy`](https://github.com/abourdim/esp32-rxy) |

A robot joins this list by answering `GETCFG`; nothing in this app names any of
them. `esp32-rxy` is the pattern to start from for a board that is not a
micro:bit — it impersonates the micro:bit's UART service, so this app cannot
tell the difference.

## The protocol

Line-oriented over a Nordic-UART-style GATT service. The app never stores a
layout; it asks for one on every connect.

```
app   -> robot   GETCFG
robot -> app     CFGBEGIN <chunkCount>
robot -> app     CFG <base64 chunk>          ... repeated
robot -> app     CFGEND
app   -> robot   SET <widgetId> <value...>
robot -> app     UPD <widgetId> <value>
```

`CFGBEGIN` may carry the chunk count. Clients match that line with
`startsWith()`, so firmware that omits it still works — the progress bar just
falls back to an estimate instead of a true fraction.

Two robots also send a compact D-pad form: a single byte `'a'..'p'` encoding
the complete four-bit button state, so a dropped packet is corrected by the
next one rather than leaving a direction stuck on.

## Build and Play

**Build** designs a layout by dragging widgets, and exports it as Layout JSON
or a MakeCode CFG snippet to paste into firmware. **Play** connects to a robot
and renders what it sends. Arrange mode inside Play lets you reposition a live
panel and export the result.

## Widget types

`button` `slider` `toggle` `joystick` `dpad` `xypad` `led` `label` `gauge`
`graph` `radar` `battery` `timer` `image` `select` `editfield` `sound`
`notification` `group` `separator`

`group` and `separator` are visual only — they carry no state and are never
`SET` or `UPD` targets, so a client that does not know them can ignore the
grouping metadata safely.

### radar

A sweep scope, for a robot with a distance sensor on a moving head. It reads
**two** widgets rather than being sent values of its own:

| property | names the widget carrying |
|---|---|
| `source` | the distance, in cm |
| `angleSource` | the head angle, 0–180 |
| `max` | beyond this a reading means "nothing there" (default 200) |
| `model` | the display kind, or a sweep marker — see below |

Rings at 10/30/100 cm, a beam on the live angle, and detections that persist
and fade over five seconds — so a sweep builds a picture of the room instead
of flashing one number. Blips take their colour from the threshold: red under
10 cm, amber under 30, green beyond.

**Display kinds.** `model` picks which instrument the widget is. Four of them
show a single live reading; only `sweep` accumulates a fading trail, because
only it is a map rather than a gauge.

| model | shows |
|---|---|
| `sweep` | the polar scope — rings, a beam on the live bearing, and detections that persist and fade over five seconds |
| `bat` | echolocation: a bat, expanding chirps, and the return travelling up its axis |
| `sonar` | a submarine set — nested ping arcs and a rotating sweep arm |
| `lidar` | a laser scanner — a scanning wedge and a point cloud at the detection |
| `heat` | a horizontal proximity bar, no bearing at all; the sub-30 cm zone gets a third of the width because that is the part you steer by |

**The viewer picks the kind, not the layout.** Chips under the scope switch it
live — no reflash, no layout edit — and the choice is remembered per widget id
in `localStorage`. `model` in the layout is only the default. The marker row
appears under `sweep` alone, because a marker style means nothing to a heat bar.

Only `sweep` uses `angleSource`. The other four need distance alone, so they
work on a robot whose sensor does not move.

**Marker styles**, for `sweep` only. Naming a marker in `model` implies the
sweep kind, so `model:"dots"` from an older layout still works. All five share the same geometry and the same thresholds,
so switching changes how the room is drawn, never where anything sits in it.

| model | reads as |
|---|---|
| `dots` | one point per reading — the plain scatter |
| `rays` | a bearing line from the origin out to each detection |
| `sectors` | readings binned into 6 deg wedges: a polar occupancy grid, where walls come out as fat blocks of colour and doorways as the gaps between them |
| `stars` | points sized by proximity as well as coloured, so the reading survives being printed and works without colour vision |
| `emoji` | the thresholds told as symbols rather than colours, for users who read the picture long before the legend |

Readings at or past `max` are **not** plotted. That value is the robot's "no
echo", and drawing it would paint a wall at full range around an empty room.

The distance scale is deliberately not linear — the first 10 cm takes a
quarter of the radius — and matches the scope the dfrobot-rover draws on its
own OLED, so the two displays agree about what "close" looks like.

## History

Forked from `keystudio_4wd_mecanum_rxy` with its full history, because that
app was already a strict superset of `bit-rxy`. The robot-specific parts —
the Keyes micro:bit firmware, its example layout and its product manifest —
were removed in the commit after the merge. Nothing was deleted from the
original repositories.

Powered by [Workshop-DIY.org](https://workshop-diy.org)

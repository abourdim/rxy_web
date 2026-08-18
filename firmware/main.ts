/**
 * ╔════════════════════════════════════════════════════════════════╗
 * ║            🎮 Micro:bit Remote Builder (bit-rxy) 🎮            ║
 * ║                                                                ║
 * ║   Powered by Workshop-DIY.org                                  ║
 *   Keyestudio 4WD Mecanum V2: drive, servo, LEDs, strip, sensors  ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * 📋 PROJECT: Keyes 4WD Mecanum Remote
 *
 * Drives a Keyestudio 4WD Mecanum robot (V2 board) through the
 * mecanumRobotV2 extension: 8-way mecanum drive, STOP, Buzz, headlight
 * toggles, head servo, NeoPixel strip, three line sensors, ultrasonic
 * distance and the micro:bit's own sensors.
 *
 * HISTORY: this firmware began as the Maqueen Lab controller and was
 * retargeted. Where a comment credits Maqueen Lab below it is recording
 * where a piece of logic came from, not describing this hardware.
 *
 * The D-pad → motor mix is ported from Maqueen Lab's proven drive-pad
 * code (js/maqueen-tab.js): it boils down to a
 * normalized (nx, ny) vector — nx = turn (right positive), ny =
 * forward (up positive) — fed through the same differential-drive
 * formula:
 *     L = clamp(ref * (ny + nx), -ref, ref)
 *     R = clamp(ref * (ny - nx), -ref, ref)
 * with the same 12%-of-full-scale dead zone before treating input as
 * "stopped", so behavior should match what Maqueen Lab's own UI does.
 *
 * ════════════════════════════════════════════════════════════════
 * ⚡ LOW-LATENCY D-PAD — REAL-HARDWARE LESSONS (v43)
 * ════════════════════════════════════════════════════════════════
 *
 * This section records the latency investigation so the same problems
 * do not get reintroduced later. The final v43 path was reached by
 * testing each layer separately: browser pointer event → Web Bluetooth
 * write → micro:bit UART receive callback → I2C motor write.
 * v43 was the first build that felt immediate in real driving tests.
 *
 * 1) REMOVE ARTIFICIAL UI/QUEUE DELAYS
 *    - The browser originally waited ~60 ms between BLE writes.
 *    - D-pad release had a 100 ms debounce.
 *    Those two delays were directly visible as press/stop latency and
 *    were removed. D-pad uses Pointer Events so touch devices do not
 *    generate a second synthetic mouse sequence after the touch.
 *
 * 2) DO NOT REPLAY OLD MOTOR EVENTS
 *    A reliable FIFO sounds safe, but it is wrong for steering: a stale
 *    press/release queued ahead of the newest direction makes the robot
 *    faithfully execute OLD intentions. Manual drive therefore uses
 *    "latest complete state wins", not "deliver every historical click".
 *    The state is a 4-bit mask: Up=1, Down=2, Left=4, Right=8. This also
 *    preserves diagonals naturally.
 *
 * 3) KEEP THE RADIO PACKET TINY
 *    The old text protocol could exceed the BLE UART payload used by the
 *    app. For example "SET dpad_move up 1" fit while down/left/right were
 *    longer and could require another BLE write/connection event. We
 *    first shortened the command, then removed text parsing entirely.
 *    FINAL FORMAT: one ASCII byte 'a'..'p' encodes mask 0..15, followed
 *    by newline. The browser therefore writes exactly TWO bytes for a
 *    D-pad state change.
 *
 * 4) BYPASS THE GENERAL BLE QUEUE FOR MOTORS
 *    Sliders, PINGs and other controls may be serialized/coalesced by the
 *    normal app queue. The D-pad has its own writer and replaces any
 *    pending motor state with the newest one. At most the GATT write
 *    already in progress can finish first; stale motor states do not
 *    build a backlog.
 *
 * 5) EXECUTE MOTORS DIRECTLY IN THE RECEIVE CALLBACK
 *    The one-byte packet is detected before GETCFG/SET parsing and goes
 *    straight to handleDpadMask(). That hot path does only: decode mask,
 *    calculate left/right speed, and call motorStop()/motorRun(). It does
 *    NOT call handleWidget(), dbg(), LED rendering, telemetry, or the
 *    generic drive refresh/rate-limit path.
 *
 * 6) NEVER BLOCK THE BLE RECEIVE CALLBACK WITH DISPLAY OR LOGGING
 *    basic.showArrow/showIcon/showLeds normally include hundreds of ms
 *    of display time unless interval 0 is supplied. Earlier firmware
 *    rendered arrows inside the receive path, producing ~400-600 ms of
 *    apparent control lag. Display work is now deferred to the forever
 *    loop and uses interval 0.
 *
 *    serial.writeLine() was another trap: with no USB serial reader it
 *    can block the calling fiber. bluetooth.uartWriteLine() from inside
 *    onUartDataReceived was also found to interfere with BLE turnaround.
 *    dbg() therefore only queues text; optional BLE logs drain later from
 *    the main loop, and debugging defaults OFF.
 *
 * 7) ULTRASONIC POLLING CAN FREEZE THE WHOLE RUNTIME
 *    An ultrasonic read retries pulseIn() when there is no echo.
 *    On open space this can busy-wait for roughly 250 ms. That freeze
 *    also freezes BLE command handling, so a perfectly fast D-pad packet
 *    still appears late. The latency build NEVER polls Ultrasonic() in
 *    Manual or Line mode; distance sensing is reserved for Avoid mode.
 *
 * 8) BACKGROUND BLE TRAFFIC MATTERS
 *    Telemetry/logs/heartbeat traffic shares the same BLE link with motor
 *    commands. The Telemetry selector is the explicit policy switch:
 *    All/Basic may send the lightweight heartbeat, while Off is fully
 *    silent. Expensive sensor work is still suppressed in Manual, app PING
 *    traffic is sparse around driving, and the D-pad writer has priority.
 *    bluetooth.setTransmitPower(7) is used for the strongest
 *    link available from MakeCode.
 *
 * 9) MOTOR I2C WRITES: CHANGE IMMEDIATELY, DO NOT SPAM
 *    The motors are controlled over I2C. Generic joystick/servo code
 *    still avoids redundant writes, but the D-pad hot path writes a real
 *    state change immediately. Do not restore a fixed 125 ms/8 Hz delay
 *    to handleDpadMask(); that turns directly into steering latency.
 *
 * 10) KEEP SAFETY WITHOUT MAKING CONTROL SLUGGISH
 *    A held direction is periodically re-sent as the SAME complete mask.
 *    The firmware watchdog stops the motors if those refreshes disappear,
 *    protecting against a lost release/link while still letting a held
 *    button stay active. Link-loss handling also stops both motors.
 *
 * IMPORTANT DESIGN RULE: for real-time drive controls, optimize for the
 * newest desired STATE, not guaranteed delivery of every EVENT. Reliability
 * for an old steering command is often indistinguishable from latency.
 *
 *
 * ════════════════════════════════════════════════════════════════
 * 💓 v50 — HEARTBEAT FOLLOWS TELEMETRY, NOT DRIVE MODE
 * ════════════════════════════════════════════════════════════════
 * Earlier builds suppressed heartbeat whenever the motors had been
 * updated recently. That was useful while chasing Manual D-pad latency,
 * but in Line/Avoid the motors are updated continuously by autonomous
 * code, so the UI looked as if the heartbeat had stopped.
 *
 * v50 makes the Telemetry selector the single source of truth:
 *   • All   -> heartbeat + full telemetry
 *   • Basic -> heartbeat + firmware version only
 *   • Off   -> no heartbeat / no optional telemetry
 *
 * The heartbeat counter still advances once per second internally.
 * sendValue() applies the selected telemetry level before anything is
 * written over BLE. Therefore Manual, Line and Avoid now have the same
 * heartbeat semantics, and changing mode no longer changes whether the
 * connection appears alive.
 *
 * Extensions required (MakeCode → Extensions):
 *   • mecanum_robot_v2  (https://github.com/keyestudio2019/mecanum_robot_v2)
 *   • Bluetooth         (built in)
 *   • Neopixel          (built in)
 *
 * 🚀 HOW TO USE:
 *    1. Copy this entire file's contents
 *    2. Go to https://makecode.microbit.org
 *    3. Create new project → Switch to JavaScript mode
 *    4. Add the extensions listed above
 *    5. Paste this code → Download to micro:bit
 *    6. Open the remote app and connect — it requests
 *       the layout automatically (GETCFG) and builds the D-pad,
 *       STOP/Buzz buttons, LED toggles and servo sliders.
 *
 * ⚠️ Note on debugging: use dbg() (not serial.writeLine directly) for
 * anything you want to see while testing. It logs over BLE as
 * "LOG <msg>" lines — the app already console.logs every raw BLE line
 * it receives, so dbg() output shows up in the browser DevTools
 * console (F12) with nothing but the BLE connection already open, no
 * USB cable needed. General controls can request LED-matrix diagnostics,
 * but the v43 D-pad hot path intentionally does no display work at all;
 * nothing visual is allowed between the BLE packet and motorRun().
 *
 * 🖥️ LED MATRIX LEGEND — every glyph is distinct on purpose, so the
 * robot can be read untethered without a cable or console:
 *    "v43"        scrolling at boot   — firmware version (check after every flash)
 *    ○            hollow ring         — powered up, idle, waiting for BLE
 *    filling grid pixel by pixel      — sending the layout (GETCFG)
 *    ✓            tick                — connected, layout delivered
 *    ✗            cross               — BLE link lost (motors auto-stopped)
 *    ■            square              — STOP button pressed
 *    ↑ ↓ ← →      arrow               — driving in that direction
 *    ·            centre dot          — motors idle (direction released)
 *    ◇            small diamond       — only one wheel driving
 *    ▌ left band  solid / corners     — LED L toggled on / off
 *    ▐ right band solid / corners     — LED R toggled on / off
 *    ♪            quarter note        — Buzz pressed
 *    bar graph    rising bar          — servo angle (0-180)
 *
 * Most non-drive controls leave a visual mark. The D-pad is the one
 * deliberate exception: visual feedback was removed from its hot path
 * because responsiveness is more important than per-packet animation.
 *
 * 🔌 Wire protocol (bit-rxy's own, NOT Maqueen Lab's #N/ECHO: dialect):
 *    App → micro:bit   <a..p> + newline        (FAST D-pad: 1-byte mask)
 *    App → micro:bit   SET <widgetId> <value...>
 *    App → micro:bit   GETCFG                 (asks for the layout once, on connect)
 *    micro:bit → App   CFGBEGIN <chunkCount> / CFG <b64 chunk> / CFGEND
 *    micro:bit → App   UPD <widgetId> <value>  (optional — push sensor/status updates)
 */

// Bump this on every real change and check it (serial log + LED scroll
// at boot) to confirm what's actually flashed before debugging further —
// no more guessing whether a fix was really re-flashed.
const FIRMWARE_VERSION = "K4-v19"
// Temporary servo instrumentation: a boot sweep plus a per-write BLE echo.
// Set to false to remove both once the servo fault is understood.
const SERVO_DIAG = false

// ── NEOPIXEL STRIP ───────────────────────────────────────────────────
// P7, confirmed empirically by the boot pin scan on this actual board, and
// matching the V2 sample program. NOT P8 — that is the KS4031 *V1* pin, and
// the V1 tutorial documenting it does not describe this chassis.
//
// P7 IS one of the six LED-matrix pins (P3, P4, P6, P7, P9, P10), so the
// display must be off for the strip to work. That costs nothing here: the
// matrix already has to be disabled for the line sensors on P3/P4/P10, so
// both requirements point the same way. See USE_MATRIX below.
const NEOPIXEL_PIN = DigitalPin.P7
const USE_NEOPIXEL = true

// ── THE 5x5 MATRIX MUST STAY OFF — because of the LINE SENSORS ───────
// mecanumRobotV2 reads its three line sensors on P3, P4 and P10, and all
// three are LED-matrix row/column drivers. With the display enabled those
// pins are multiplexed and a digital read returns garbage, so Line mode
// steers on noise. That — not the NeoPixel strip — is why Keyestudio's
// working program calls led.enable(false).
//
// Two earlier revisions of this file got the reason wrong in both
// directions: first disabling the display to free P7 for the strip (wrong
// pin), then re-enabling it once the strip moved to P8 (which broke the
// line sensors). The display has to go, and the trigger is P3/P4/P10.
//
// Every basic.show*/led.* call is gated on USE_MATRIX rather than deleted,
// so this stays a one-line decision.
const USE_MATRIX = false
// Strip instrumentation: a boot red/green/blue flash plus a BLE echo on
// every strip command. Off now that P7 is confirmed; flip on to re-check.
const NP_DIAG = false

// Distance instrumentation: reports the RAW ultra() value and the poll
// gate on every tick, so "no distance" can be told apart from "poll never
// ran". Set to false once distance is understood.
const DIST_DIAG = false

// One-shot boot scan to IDENTIFY which pin the strip is on: it drives each
// candidate in turn, showing the pin number on the matrix immediately
// before it, so whichever number is on screen when the strip lights is the
// answer. ANSWERED — P7. Kept behind this flag rather than deleted because
// the V1/V2 pin differences on these boards make it recur.
const NP_PIN_SCAN = false
const NEOPIXEL_COUNT = 4
let strip: neopixel.Strip = null
let npColorIdx = 0
let npBright = 150   // 60/255 is dim enough to be mistaken for "off"
let npEffect = "Solid"
let npOn = false
let npPhase = 0

// Debug helper — logs ONLY if debugEnabled is true (default false).
// THIS IS THE ROOT CAUSE of "connected, but nothing happens": pxt-
// microbit's serial.writeLine() BLOCKS THE CALLING FIBER when nothing
// is actively reading the USB serial output — which is the normal
// case once you unplug USB and just drive over BLE. v6/v7 called
// dbg()/serial.writeLine() unconditionally on every single command,
// from INSIDE the BLE receive handler, BEFORE the actual motorRun/
// servoRun/writeLED call — so in real untethered use, every command
// handler hung forever right at the logging line and the hardware
// action never ran. It only looked like it worked during debugging
// sessions because USB + the serial monitor happened to be open and
// actively draining the buffer at that moment. Maqueen Lab's own
// firmware has the exact same landmine and defends against it by
// defaulting logging OFF — same fix here. Flip debugEnabled to true
// to see dbg() output over BLE as "LOG <msg>" lines, which the app
// already console.logs for every raw line it receives — so it shows
// up in the browser DevTools console (F12) with the app just
// connected, no USB cable needed at all.
//
// dbg() deliberately does NOT call serial.writeLine() anymore — an
// earlier version of this file did, and it reintroduced the exact
// blocking landmine described above: with only BLE connected (no USB
// serial monitor actively reading), serial.writeLine() blocks the
// calling fiber forever, so the very first dbg() call inside
// handleWidget() hung before the real hardware action ever ran —
// nothing worked at all, not even the log. The queue avoids blocking
// entirely: dbg() only ever PUSHES a string (fast, non-blocking). The
// actual bluetooth.uartWriteLine() call happens later, from the main
// loop below — NEVER synchronously from inside onUartDataReceived.
// Calling uartWriteLine() directly inside the receive handler on every
// command was also tried once before (the "v5" attempt) and broke
// everything (GETCFG hung again), because it raced the BLE stack's own
// turnaround right as a packet was still being processed. Draining one
// line per 100ms loop tick, exactly like the heartbeat, avoids both
// problems.
let debugEnabled = false
let logQueue: string[] = []
const LOG_QUEUE_MAX = 20
function dbg(msg: string) {
    if (!debugEnabled) return
    logQueue.push(msg)
    if (logQueue.length > LOG_QUEUE_MAX) logQueue.shift()
}

// ═══════════════════════════════════════════════════════════════
// 🔌 BLUETOOTH SETUP
// ═══════════════════════════════════════════════════════════════

bluetooth.startUartService()
bluetooth.setTransmitPower(7)
let cfgSent = false

// v48 CONFIG-NATIVE GAUGES + v47 FAST RECONNECT + v46 HARDENING
// ----------------------------------------------
// v46 fixed stale BLE sessions, but still retransmitted an unchanged layout
// on every reconnect. v47 adds a revision handshake:
//   GETCFGVER -> CFGVER <hash>
//   cache hit -> CFGOK <hash>        (no layout transfer)
//   cache miss -> GETCFG             (existing paced transfer)
// The browser caches by BluetoothDevice.id and the robot remains source of
// truth because any layout change produces a different CFG_REV.
//
// v46 RECONNECT HARDENING
// -----------------------
// GETCFG used to send ~2 seconds of CFGBEGIN/CFG/CFGEND notifications from
// INSIDE onUartDataReceived(). That works on a cold boot, but after a real
// disconnect/reconnect the BLE UART stack can be in a fragile turnaround
// state; a large callback-side write burst can leave the device visible in
// the chooser while config notifications no longer flow. Queue the transfer
// here and let the main loop send ONE notification at a time instead.
let cfgTxActive = false
let cfgTxStage = 0       // 0=CFGBEGIN, 1=CFG chunks, 2=CFGEND
let cfgTxPos = 0
let cfgTxChunkIdx = 0
let cfgTxLit = 0
let cfgTxNextAt = 0
const CFG_TX_GAP_MS = 35

// v47: config revision probe. Never write the reply from inside the UART RX
// callback; even this tiny response is queued to the main loop to preserve the
// reconnect hardening learned in v46.
let cfgVerPending = false
let cfgVerReplyAt = 0

// A real disconnect can also leave the Nordic/MakeCode BLE peripheral in a
// connectable-but-unusable GATT state until reset. v46 schedules a SOFTWARE
// reset after showing X, so the user no longer needs the physical reset button.
let bleStackResetAt = 0
const BLE_STACK_RESET_DELAY_MS = 600

// ── LINK LOSS DETECTION BY SILENCE ───────────────────────────────
// bluetooth.onBluetoothDisconnected does NOT fire on this board. Tested
// directly: an explicit gatt.disconnect() from the app never produced
// the ✗, so every safety behaviour hanging off that event — stopping the
// motors when the link drops — has never actually run. A robot driving
// when the connection died would have kept going.
//
// onBluetoothConnected DOES fire (the heartbeat is gated on btConnected
// and it counts), so it is specifically the disconnect event that is
// unreliable. Rather than depend on it, the link is now judged by
// traffic: the app pings every three seconds, lastRxAt is stamped on ANY line
// received, and silence past LINK_TIMEOUT_MS means the peer is gone.
//
// 9s allows roughly two missed 3s pings before declaring the link dead, which is
// tolerant of a momentarily busy radio without leaving a runaway robot
// driving for long.
let lastRxAt = 0
let linkLostHandled = false
const LINK_TIMEOUT_MS = 9000

// True while the link is known alive. Set by onBluetoothConnected() AND,
// from v45 onward, by every successfully received UART line. The receive
// fallback matters because Manual commands can work in the UART callback even
// when a missed connection event would otherwise leave Line/Avoid and UPD
// telemetry disabled in the forever loop.
// Every bluetooth.uartWriteLine() in this file is gated on it, because
// writing to a UART with no peer BLOCKS THE CALLING FIBER once the
// buffer stops draining — the identical failure mode as serial.
// writeLine(). Maqueen Lab's firmware keeps the same flag for the same
// reason. cfgSent is NOT a substitute: it only tracks whether the
// layout was delivered, and it stays true across a link drop until the
// disconnect handler runs.
let btConnected = false

// ── TELEMETRY LEVEL ──────────────────────────────────────────────
// How much the robot pushes back to the app. Everything the firmware
// reports — uptime, distance, line sensors, obstacle alert — is a UPD
// write, and each one competes with the drive commands coming the other
// way. Turning it down is the cheapest way to free the radio.
//
//   All   — everything (default)
//   Basic — uptime and version only, so the link still visibly lives
//   Off   — silence
//
// Firmware starts at All to match the first/default option shown by the app.
// Manual driving still suppresses expensive sensor work, so this does not
// reintroduce the old D-pad latency problem.
//
// Note this does NOT affect link-loss detection: that measures traffic
// arriving FROM the app (its PING), so the robot still notices a dead
// link at Off. Nor does it disable the app's controls, which are the
// other direction entirely.
const UPD_OFF = 0
const UPD_BASIC = 1
const UPD_ALL = 2
let updLevel = UPD_ALL

// 🧭 v51 — CONFIG-DEFINED 1372 × 776 REFERENCE LAYOUT
// ---------------------------------------------------
// The widget geometry below now matches the agreed Arrange-mode reference.
// Unlike earlier releases, the canvas size is also stored in CFG:
//     "canvas":{"w":1372,"h":776}
// so compatible clients can reproduce the same composition instead of
// recalculating a different board size from widget extents.
//
// This is deliberately a configuration/layout change only. The v50 control,
// heartbeat, distance selector, BLE reconnect and low-latency motor behavior
// remain unchanged.
//
// 📦 Remote layout config (Base64 encoded JSON, 2389 bytes, 21 widgets).
// v48 CONFIG-NATIVE GAUGES
// ------------------------
// Servo 1, Servo 2 and Speed now each have a REAL `t:"gauge"` widget
// stored here in the MakeCode-delivered configuration. The gauges are no
// longer synthesized by one particular web app, so every compatible app
// receives the same IDs, positions, ranges, labels and model.
//
// Control/gauge pairs:
//   slider_srv1 -> gauge_srv1   0..180°   (this chassis has ONE servo)
//   spd         -> gauge_spd    24..100
//
// Each gauge also carries `source:"<slider id>"`. Newer clients can mirror
// it locally with zero BLE traffic; older clients still receive paced
// `UPD gauge_* <value>` packets from this firmware.
//
// The config also includes initial `value` fields (90°, 90°, 200), matching
// the actual boot state, so even before telemetry arrives the controls do
// not falsely show minimum.
//
// DESIGN RULE LEARNED:
// If a visual relationship must look the same in several apps, define it
// as widgets + metadata in CFG. Do not hide it in app-specific CSS/JS.
//
// v52: derive the config revision from the actual embedded Base64 CFG.
// Any CFG byte change automatically changes CFGVER; no manual hash can go stale.
function cfgRevisionFromCfg(text: string): string {
    let hash = 5381 >>> 0
    for (let i = 0; i < text.length; i++) {
        hash = ((((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0)
    }
    return "d" + (hash >>> 0)
}

const CFG = "eyJ0aXRsZSI6IktleWVzIDRXRCBNZWNhbnVtIFJlbW90ZSIsIndpZGdldHMiOlt7ImlkIjoiZ3JwX2RyaXZlIiwidCI6Imdyb3VwIiwibGFiZWwiOiJEUklWRSIsIngiOjU2LCJ5Ijo2MCwidyI6Njc4LCJoIjo3NDQsImNvbG9yIjoiIzAwZDRmZiIsImNoaWxkcmVuIjpbImRwYWRfbW92ZSIsImJ0bl9zdG9wIiwic3BkIiwiZ2F1Z2Vfc3BkIl19LHsiaWQiOiJncnBfaGVhZCIsInQiOiJncm91cCIsImxhYmVsIjoiSEVBRCAmIERJU1RBTkNFIiwieCI6Nzg2LCJ5Ijo2MCwidyI6Njg4LCJoIjo1NjksImNvbG9yIjoiI2ZmOTUwMCIsImNoaWxkcmVuIjpbInNsaWRlcl9zcnYxIiwiZ2F1Z2Vfc3J2MSIsImdhdWdlX2Rpc3QiLCJhbGVydCIsImRpc3RfcmVhZCIsImdyYXBoX2Rpc3QiXX0seyJpZCI6ImdycF9hdXRvIiwidCI6Imdyb3VwIiwibGFiZWwiOiJBVVRPTk9NWSIsIngiOjc4NiwieSI6NjcwLCJ3IjozNzgsImgiOjI3NCwiY29sb3IiOiIjMDBlNjc2IiwiY2hpbGRyZW4iOlsibG5fbCIsImxuX2MiLCJsbl9yIiwibW9kZSJdfSx7ImlkIjoiZ3JwX3N5cyIsInQiOiJncm91cCIsImxhYmVsIjoiU1lTVEVNIiwieCI6MTIxNiwieSI6NjcwLCJ3IjoyNjgsImgiOjQ2OSwiY29sb3IiOiIjODg5MmIwIiwiY2hpbGRyZW4iOlsibGJsX3ZlciIsImxibF9oZWFydGJlYXQiLCJ1cGQiLCJidG5fYnV6eiJdfSx7ImlkIjoiZ3JwX2xpZ2h0IiwidCI6Imdyb3VwIiwibGFiZWwiOiJMSUdIVFMiLCJ4Ijo1NiwieSI6OTgwLCJ3IjoxMDk4LCJoIjoyOTksImNvbG9yIjoiI2MwODRmYyIsImNoaWxkcmVuIjpbInRvZ2dsZV9sZWRfbCIsInRvZ2dsZV9sZWRfciIsInRvZ2dsZV9ucCIsIm5wX2NvbG9yIiwibnBfZWZmZWN0IiwibnBfYnJpZ2h0Il19LHsiaWQiOiJncnBfbWljcm8iLCJ0IjoiZ3JvdXAiLCJsYWJlbCI6Ik1JQ1JPOkJJVCIsIngiOjU2LCJ5IjoxMzE1LCJ3IjoxMjE4LCJoIjoyNTQsImNvbG9yIjoiI2Y0NzJiNiIsImNoaWxkcmVuIjpbImdhdWdlX3NvdW5kIiwiZ2F1Z2VfdGVtcCIsImdhdWdlX3RpbHR4IiwiZ2F1Z2VfdGlsdHkiLCJsZWRfYnRuX2EiLCJsZWRfYnRuX2IiLCJsZWRfbG9nbyJdfSx7ImlkIjoic2VwX2NvbHMiLCJ0Ijoic2VwYXJhdG9yIiwieCI6NzUyLCJ5IjoxMDAsInciOjgsImgiOjUwNSwiY29sb3IiOiIjM2E1NTgwIiwidGhpY2tuZXNzIjoyfSx7ImlkIjoic2VwX2JhbmQxIiwidCI6InNlcGFyYXRvciIsIngiOjgwLCJ5Ijo5NTgsInciOjEwNzAsImgiOjgsImNvbG9yIjoiIzNhNTU4MCIsInRoaWNrbmVzcyI6Mn0seyJpZCI6InNlcF9iYW5kMiIsInQiOiJzZXBhcmF0b3IiLCJ4Ijo4MCwieSI6MTI5MSwidyI6MTM4MCwiaCI6OCwiY29sb3IiOiIjM2E1NTgwIiwidGhpY2tuZXNzIjoyfSx7ImlkIjoic2xpZGVyX3NydjEiLCJ0Ijoic2xpZGVyIiwieCI6ODEwLCJ5IjoxMDAsInciOjEyMCwiaCI6MjUwLCJsYWJlbCI6IlVsdHJhc29uaWMgc2Vydm8iLCJtaW4iOjAsIm1heCI6MTgwLCJzdGVwIjoxLCJ2YWx1ZSI6OTAsImdyb3VwSWQiOiJncnBfaGVhZCJ9LHsiaWQiOiJnYXVnZV9zcnYxIiwidCI6ImdhdWdlIiwieCI6OTUwLCJ5IjoxMDAsInciOjE5MCwiaCI6MTkwLCJsYWJlbCI6IlNlcnZvIGFuZ2xlIiwibWluIjowLCJtYXgiOjE4MCwidW5pdHMiOiJkZWciLCJkZWNpbWFscyI6MCwibW9kZWwiOiJtaW4iLCJzb3VyY2UiOiJzbGlkZXJfc3J2MSIsInZhbHVlIjo5MCwiZ3JvdXBJZCI6ImdycF9oZWFkIn0seyJpZCI6InRvZ2dsZV9sZWRfbCIsInQiOiJ0b2dnbGUiLCJ4Ijo4MCwieSI6MTA1MCwidyI6MTMwLCJoIjoxMDUsImxhYmVsIjoiTGVmdCBMRUQiLCJncm91cElkIjoiZ3JwX2xpZ2h0In0seyJpZCI6InRvZ2dsZV9sZWRfciIsInQiOiJ0b2dnbGUiLCJ4IjoyMzAsInkiOjEwNTAsInciOjEzMCwiaCI6MTA1LCJsYWJlbCI6IlJpZ2h0IExFRCIsImdyb3VwSWQiOiJncnBfbGlnaHQifSx7ImlkIjoibG5fbCIsInQiOiJsZWQiLCJ4Ijo4MTAsInkiOjcxMCwidyI6MTAwLCJoIjoxMDUsImxhYmVsIjoiTGluZSBsZWZ0IiwibW9kZWwiOiJkb3QiLCJjb2xvck9uIjoiIzRhZGU4MCIsImdyb3VwSWQiOiJncnBfYXV0byJ9LHsiaWQiOiJsbl9jIiwidCI6ImxlZCIsIngiOjkyNSwieSI6NzEwLCJ3IjoxMDAsImgiOjEwNSwibGFiZWwiOiJMaW5lIGNlbnRlciIsIm1vZGVsIjoiZG90IiwiY29sb3JPbiI6IiM0YWRlODAiLCJncm91cElkIjoiZ3JwX2F1dG8ifSx7ImlkIjoibG5fciIsInQiOiJsZWQiLCJ4IjoxMDQwLCJ5Ijo3MTAsInciOjEwMCwiaCI6MTA1LCJsYWJlbCI6IkxpbmUgcmlnaHQiLCJtb2RlbCI6ImRvdCIsImNvbG9yT24iOiIjNGFkZTgwIiwiZ3JvdXBJZCI6ImdycF9hdXRvIn0seyJpZCI6ImJ0bl9idXp6IiwidCI6ImJ1dHRvbiIsIngiOjEyNDAsInkiOjEwMTAsInciOjE0MCwiaCI6MTA1LCJsYWJlbCI6IkJ1enoiLCJncm91cElkIjoiZ3JwX3N5cyJ9LHsiaWQiOiJkcGFkX21vdmUiLCJ0IjoiZHBhZCIsIngiOjgwLCJ5IjoxMDAsInciOjQ1NSwiaCI6NDU1LCJsYWJlbCI6Ik1lY2FudW0gZHJpdmUiLCJtb2RlbCI6Im1lY2FudW0iLCJncm91cElkIjoiZ3JwX2RyaXZlIn0seyJpZCI6InNwZCIsInQiOiJzbGlkZXIiLCJ4Ijo1NTUsInkiOjI3MCwidyI6MTU1LCJoIjoyMzUsIm1pbiI6MjQsIm1heCI6MTAwLCJzdGVwIjoyLCJ2YWx1ZSI6NzgsImxhYmVsIjoiU3BlZWQiLCJncm91cElkIjoiZ3JwX2RyaXZlIn0seyJpZCI6ImdhdWdlX3NwZCIsInQiOiJnYXVnZSIsIngiOjgwLCJ5Ijo1NzUsInciOjIyNSwiaCI6MjA1LCJsYWJlbCI6Ik1vdG9yIHNwZWVkIiwibWluIjoyNCwibWF4IjoxMDAsInVuaXRzIjoiIiwiZGVjaW1hbHMiOjAsIm1vZGVsIjoibWluIiwic291cmNlIjoic3BkIiwidmFsdWUiOjc4LCJncm91cElkIjoiZ3JwX2RyaXZlIn0seyJpZCI6ImJ0bl9zdG9wIiwidCI6ImJ1dHRvbiIsIngiOjU1NSwieSI6MTAwLCJ3IjoxNDUsImgiOjE1MCwibGFiZWwiOiJTVE9QIiwiZ3JvdXBJZCI6ImdycF9kcml2ZSJ9LHsiaWQiOiJsYmxfdmVyIiwidCI6ImxhYmVsIiwieCI6MTI0MCwieSI6NzEwLCJ3IjoxMzUsImgiOjc1LCJsYWJlbCI6IkZpcm13YXJlIiwiZ3JvdXBJZCI6ImdycF9zeXMifSx7ImlkIjoibGJsX2hlYXJ0YmVhdCIsInQiOiJsYWJlbCIsIngiOjEyNDAsInkiOjgwNSwidyI6MjIwLCJoIjo3NSwibGFiZWwiOiJVcHRpbWUiLCJncm91cElkIjoiZ3JwX3N5cyJ9LHsiaWQiOiJ1cGQiLCJ0Ijoic2VsZWN0IiwieCI6MTI0MCwieSI6OTAwLCJ3IjoxODAsImgiOjkwLCJsYWJlbCI6IlRlbGVtZXRyeSIsIm9wdGlvbnMiOiJBbGwsQmFzaWMsT2ZmIiwiZ3JvdXBJZCI6ImdycF9zeXMifSx7ImlkIjoibW9kZSIsInQiOiJzZWxlY3QiLCJ4Ijo4MTAsInkiOjgzMCwidyI6MTgwLCJoIjo5MCwibGFiZWwiOiJNb2RlIiwib3B0aW9ucyI6Ik1hbnVhbCxMaW5lLEF2b2lkIiwiZ3JvdXBJZCI6ImdycF9hdXRvIn0seyJpZCI6ImRpc3RfcmVhZCIsInQiOiJzZWxlY3QiLCJ4Ijo5MjUsInkiOjM3MCwidyI6MTgwLCJoIjo4MCwibGFiZWwiOiJEaXN0YW5jZSByZWFkIiwib3B0aW9ucyI6IkF1dG8sUmVhZCBub3ciLCJncm91cElkIjoiZ3JwX2hlYWQifSx7ImlkIjoiZ2F1Z2VfZGlzdCIsInQiOiJnYXVnZSIsIngiOjExNjAsInkiOjEwMCwidyI6MjIwLCJoIjoxOTUsImxhYmVsIjoiRGlzdGFuY2UiLCJtaW4iOjAsIm1heCI6MjAwLCJ1bml0cyI6ImNtIiwiZGVjaW1hbHMiOjAsIm1vZGVsIjoiY2xhc3NpYyIsImdyb3VwSWQiOiJncnBfaGVhZCJ9LHsiaWQiOiJncmFwaF9kaXN0IiwidCI6ImdyYXBoIiwieCI6MTEyMCwieSI6MzIwLCJ3IjozMzAsImgiOjI4NSwibGFiZWwiOiJEaXN0YW5jZSBjbSIsIm1vZGVsIjoiZ3JpZCIsIndpbmRvd1NlYyI6MzAsInNlcmllcyI6MSwiZ3JvdXBJZCI6ImdycF9oZWFkIn0seyJpZCI6ImFsZXJ0IiwidCI6Im5vdGlmaWNhdGlvbiIsIngiOjgxMCwieSI6MzcwLCJ3Ijo5NSwiaCI6MTkwLCJsYWJlbCI6Ik9ic3RhY2xlIiwiZ3JvdXBJZCI6ImdycF9oZWFkIn0seyJpZCI6InRvZ2dsZV9ucCIsInQiOiJ0b2dnbGUiLCJ4Ijo0MDAsInkiOjEwNTAsInciOjEzMCwiaCI6MTA1LCJsYWJlbCI6IlN0cmlwIiwiZ3JvdXBJZCI6ImdycF9saWdodCJ9LHsiaWQiOiJsZWRfYnRuX2EiLCJ0IjoibGVkIiwieCI6OTIwLCJ5IjoxMzU1LCJ3IjoxMDAsImgiOjEwNSwibGFiZWwiOiJCdXR0b24gQSIsIm1vZGVsIjoiZG90IiwiY29sb3JPbiI6IiM2MGE1ZmEiLCJncm91cElkIjoiZ3JwX21pY3JvIn0seyJpZCI6ImxlZF9idG5fYiIsInQiOiJsZWQiLCJ4IjoxMDM1LCJ5IjoxMzU1LCJ3IjoxMDAsImgiOjEwNSwibGFiZWwiOiJCdXR0b24gQiIsIm1vZGVsIjoiZG90IiwiY29sb3JPbiI6IiM2MGE1ZmEiLCJncm91cElkIjoiZ3JwX21pY3JvIn0seyJpZCI6ImxlZF9sb2dvIiwidCI6ImxlZCIsIngiOjExNTAsInkiOjEzNTUsInciOjEwMCwiaCI6MTA1LCJsYWJlbCI6IkxvZ28gdG91Y2giLCJtb2RlbCI6ImRvdCIsImNvbG9yT24iOiIjZjQ3MmI2IiwiZ3JvdXBJZCI6ImdycF9taWNybyJ9LHsiaWQiOiJucF9jb2xvciIsInQiOiJzZWxlY3QiLCJ4Ijo1NjAsInkiOjEwNTUsInciOjE4MCwiaCI6OTAsImxhYmVsIjoiU3RyaXAgY29sb3VyIiwib3B0aW9ucyI6IlJlZCxPcmFuZ2UsWWVsbG93LEdyZWVuLEJsdWUsSW5kaWdvLFZpb2xldCxQdXJwbGUsV2hpdGUiLCJncm91cElkIjoiZ3JwX2xpZ2h0In0seyJpZCI6Im5wX2VmZmVjdCIsInQiOiJzZWxlY3QiLCJ4Ijo3NjAsInkiOjEwNTUsInciOjE4MCwiaCI6OTAsImxhYmVsIjoiU3RyaXAgZWZmZWN0Iiwib3B0aW9ucyI6IlNvbGlkLFJhaW5ib3csQ2hhc2UsU3BhcmtsZSIsImdyb3VwSWQiOiJncnBfbGlnaHQifSx7ImlkIjoibnBfYnJpZ2h0IiwidCI6InNsaWRlciIsIngiOjk3NSwieSI6MTAyMCwidyI6MTU1LCJoIjoyMzUsImxhYmVsIjoiQnJpZ2h0bmVzcyIsIm1pbiI6MCwibWF4IjoyNTUsInN0ZXAiOjUsInZhbHVlIjoxNTAsImdyb3VwSWQiOiJncnBfbGlnaHQifSx7ImlkIjoiZ2F1Z2Vfc291bmQiLCJ0IjoiZ2F1Z2UiLCJ4Ijo4MCwieSI6MTM1NSwidyI6MTkwLCJoIjoxOTAsImxhYmVsIjoiU291bmQiLCJtaW4iOjAsIm1heCI6MjU1LCJ1bml0cyI6IiIsImRlY2ltYWxzIjowLCJtb2RlbCI6ImNsYXNzaWMiLCJncm91cElkIjoiZ3JwX21pY3JvIn0seyJpZCI6ImdhdWdlX3RlbXAiLCJ0IjoiZ2F1Z2UiLCJ4IjoyOTAsInkiOjEzNTUsInciOjE5MCwiaCI6MTkwLCJsYWJlbCI6IlRlbXBlcmF0dXJlIiwibWluIjowLCJtYXgiOjUwLCJ1bml0cyI6IkMiLCJkZWNpbWFscyI6MCwibW9kZWwiOiJjbGFzc2ljIiwiZ3JvdXBJZCI6ImdycF9taWNybyJ9LHsiaWQiOiJnYXVnZV90aWx0eCIsInQiOiJnYXVnZSIsIngiOjUwMCwieSI6MTM1NSwidyI6MTkwLCJoIjoxOTAsImxhYmVsIjoiVGlsdCBYIiwibWluIjotMTAwLCJtYXgiOjEwMCwidW5pdHMiOiIlIiwiZGVjaW1hbHMiOjAsIm1vZGVsIjoiY2xhc3NpYyIsImdyb3VwSWQiOiJncnBfbWljcm8ifSx7ImlkIjoiZ2F1Z2VfdGlsdHkiLCJ0IjoiZ2F1Z2UiLCJ4Ijo3MTAsInkiOjEzNTUsInciOjE5MCwiaCI6MTkwLCJsYWJlbCI6IlRpbHQgWSIsIm1pbiI6LTEwMCwibWF4IjoxMDAsInVuaXRzIjoiJSIsImRlY2ltYWxzIjowLCJtb2RlbCI6ImNsYXNzaWMiLCJncm91cElkIjoiZ3JwX21pY3JvIn1dLCJjYW52YXMiOnsidyI6MTUyNCwiaCI6MTYwOX19"
// v52: computed from CFG itself at boot.
let CFG_REV = cfgRevisionFromCfg(CFG)

// ═══════════════════════════════════════════════════════════════
// 📡 BLUETOOTH COMMUNICATION
// ═══════════════════════════════════════════════════════════════

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    let cmd = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))

    // Stamp on EVERY line, whatever it is — including the app's PING,
    // which exists purely to keep this fresh while nobody is driving.
    // This is what the link-loss timeout below measures against.
    lastRxAt = input.runningTime()
    linkLostHandled = false

    // v45: receiving a UART packet is stronger evidence of a live BLE link
    // than the platform connection callback. Manual D-pad commands execute
    // inside this receive handler, but Line/Avoid + telemetry run in the
    // forever loop and are gated on btConnected. If onBluetoothConnected()
    // is missed on a device/browser combination, Manual still appears to
    // work while BOTH autonomous modes and all UPD telemetry stay dead.
    // Any successfully received packet proves the peer is connected, so
    // recover the flag here. Link loss is still detected by RX silence.
    btConnected = true

    // Fastest D-pad wire format: one byte 'a'..'p' encodes mask 0..15.
    // The browser sends exactly two bytes total: command + newline.
    if (cmd.length == 1 && cmd.charCodeAt(0) >= 97 && cmd.charCodeAt(0) <= 112) {
        handleDpadMask(cmd.charCodeAt(0) - 97)
    }
    else if (cmd == "BYE") {
        // Intentional app disconnect: stop safely and schedule a clean BLE
        // peripheral reboot before the next session.
        handleLinkLost()
    }
    else if (cmd == "GETCFGVER") {
        // v47 fast reconnect: answer with only the layout revision first.
        // The browser can reuse its cached config and avoid the ~2 second
        // CFGBEGIN/CFG/CFGEND stream when nothing changed.
        cfgVerPending = true
        cfgVerReplyAt = input.runningTime() + 20
    }
    else if (cmd.indexOf("CFGOK ") == 0) {
        // Cache-hit acknowledgement from the browser. cfgSent means
        // "the peer has a usable layout", not strictly "we transmitted CFG
        // this session". This keeps Line/Avoid + telemetry enabled on the
        // fast reconnect path.
        let rev = cmd.substr(6)
        if (rev == CFG_REV) {
            cfgSent = true
            cfgTxActive = false
            versionSent = false
            scheduleInitialUiSync()
            requestGlyph(GLYPH_CONNECTED)
        }
    }
    else if (cmd == "GETCFG") {
        // v46: arm the transfer and RETURN from the RX callback immediately.
        // The forever loop below emits CFGBEGIN/chunks/CFGEND one at a time.
        dbg("GETCFG received (firmware " + FIRMWARE_VERSION + "), queueing layout...")
        cfgSent = false
        cfgTxActive = true
        cfgTxStage = 0
        cfgTxPos = 0
        cfgTxChunkIdx = 0
        cfgTxLit = 0
        cfgTxNextAt = input.runningTime() + 20
        debugDirty = false
        if (USE_MATRIX) basic.clearScreen()
    }
    else if (cmd.indexOf("M ") == 0) {
        // Ultra-low-latency D-pad packet. The number is the COMPLETE
        // current button state (U=1,D=2,L=4,R=8), so stale queued events
        // never need to be replayed.
        handleDpadMask(parseInt(cmd.substr(2)))
    }
    else if (cmd.indexOf("D ") == 0) {
        // Compact D-pad packet: D <u|d|l|r> <0|1>. Keeping this under
        // one 20-byte BLE payload avoids an extra connection event.
        let parts = cmd.split(" ")
        let d = parts[1]
        let dir = d == "u" ? "up" : d == "d" ? "down" : d == "l" ? "left" : "right"
        handleWidget("dpad_move", dir + " " + parts[2])
    }
    else if (cmd.indexOf("SET ") == 0) {
        let parts = cmd.substr(4).split(" ")
        let id = parts[0]
        let val = parts.slice(1).join(" ")
        handleWidget(id, val)
    }
})

// ═══════════════════════════════════════════════════════════════
// 🕹️ DRIVE MIX — ported from Maqueen Lab's js/maqueen-tab.js
// joystick handler. nx = turn (right positive), ny = forward
// (up positive), both in -1..1.
// ═══════════════════════════════════════════════════════════════

// Top speed, live-adjustable from the Speed slider instead of a
// constant. Autonomous modes below use it too, so one slider governs
// manual and self-driving alike.
//
// This is the mecanumRobotV2 extension's 0-100 scale, NOT a 0-255 PWM
// duty. 78 is the old 200/255 ceiling carried across proportionally,
// which keeps the same headroom Maqueen Lab deliberately left rather
// than maxing out the driver. Keyestudio's own remote runs this chassis
// at 25 — drop the default if 78 turns out to be twitchy indoors.
let driveSpeed = 78

// v48 UI MIRROR STATE
// -------------------
// The Servo 1, Servo 2 and Speed gauges are real widgets in CFG.
// Do NOT transmit their UPD messages from the BLE RX callback: v46 showed
// that callback-side TX can destabilize reconnects. Handlers only mark the
// latest value dirty; the forever loop coalesces and publishes it later.
let uiServo1 = 90
let uiServo2 = 90
let uiGaugeSrv1Dirty = false
let uiGaugeSrv2Dirty = false
let uiGaugeSpdDirty = false
let uiGaugeLastInputAt = 0
let uiGaugeTxNextAt = 0
let uiInitialSyncStage = 0
const UI_GAUGE_SETTLE_MS = 90
const UI_GAUGE_TX_GAP_MS = 45

function scheduleInitialUiSync() {
    uiInitialSyncStage = 1
    uiGaugeTxNextAt = input.runningTime() + 80
}

function sendUiValue(id: string, val: string) {
    // These are control-state mirrors, not optional sensor telemetry.
    if (!btConnected || !cfgSent) return
    bluetooth.uartWriteLine("UPD " + id + " " + val)
}

const DRIVE_SPEED_MIN = 24      // below this the motors stall rather than crawl
const DRIVE_SPEED_MAX = 100     // the mecanumRobotV2 extension takes 0-100, NOT a 0-255 PWM duty
const DEAD_ZONE = 0.12  // below this magnitude on both axes, treat as stopped

// Visual-only diagnostic — no USB required. Shows what the firmware
// computed for the last drive command directly on the 5x5 LED matrix:
// an arrow for the dominant direction, or a small square when stopped.
//
// ⚠️ NEVER CALL THIS FROM THE BLE RECEIVE HANDLER. Every basic.show*
// function RENDERS AND THEN PAUSES for its interval argument — the
// defaults are ~600ms for showArrow and ~400ms for showLeds/showIcon.
// Earlier versions called this straight from driveMix(), i.e. from
// inside onUartDataReceived, so every press blocked the receive
// callback ~600ms and every release ~400ms. A release routinely
// arrived while the handler was still blocked on the press's arrow,
// which is what made directions go missing and stalled the heartbeat
// (the watchdog called it from the forever loop too, blocking that).
//
// Maqueen Lab's own firmware is the reference here: its drive path
// (handleMotor) issues the two motorRun() calls and NOTHING else —
// every basic.showArrow/showIcon call in that file belongs to a
// dedicated display verb (JOY:UP, SHOW:, icon names), never to the
// motor path. That is the entire difference between the firmware
// that works and the one that didn't.
//
// So: driveMix() only records what it wants drawn (pendingDebugL/R +
// debugDirty), and the forever loop renders it here with an explicit
// interval of 0 so nothing ever pauses.
function showDriveDebug(l: number, r: number) {
    if (!USE_MATRIX) return
    if (l == 0 && r == 0) {
        basic.showLeds(`
            . . . . .
            . . . . .
            . . # . .
            . . . . .
            . . . . .
            `, 0)
    } else if (l > 0 && r > 0) {
        basic.showArrow(ArrowNames.North, 0)       // both forward
    } else if (l < 0 && r < 0) {
        basic.showArrow(ArrowNames.South, 0)       // both backward
    } else if (l < 0 && r > 0) {
        basic.showArrow(ArrowNames.West, 0)        // spin left
    } else if (l > 0 && r < 0) {
        basic.showArrow(ArrowNames.East, 0)        // spin right
    } else {
        basic.showIcon(IconNames.SmallDiamond, 0)  // one wheel only
    }
}

// What driveMix() wants drawn, rendered later by the forever loop.
// Kept separate from lastDriveL/lastDriveR because those are also the
// I2C rate-limit's "what's currently spinning" state — conflating the
// two would re-render on every rate-limited refresh.
let pendingDebugL = 0, pendingDebugR = 0
let debugDirty = false
// Which glyph the loop should paint. ONE renderer, in the forever loop,
// is the whole point: event handlers (BLE connect/disconnect, STOP) used
// to call basic.show* directly while the loop was also drawing. Those
// run on different fibers, so a handler's icon could be overwritten by a
// showDriveDebug() call the loop had already committed to — which is why
// the ✗ on disconnect never stuck and the micro:bit kept showing ✓.
// Clearing debugDirty could not prevent it: the loop had already passed
// that check. Handlers now only ever REQUEST a glyph.
const GLYPH_DRIVE = 0
const GLYPH_STOP = 1
const GLYPH_DISCONNECTED = 2
const GLYPH_CONNECTED = 3
const GLYPH_LED_L = 4
const GLYPH_LED_R = 5
const GLYPH_BUZZ = 6
const GLYPH_SERVO = 7
let pendingGlyph = GLYPH_DRIVE
// Extra payload for glyphs that show a value: 0/1 for the LED toggles,
// 0-180 for the servo bar graph.
let pendingValue = 0

function requestGlyph(g: number) {
    pendingGlyph = g
    debugDirty = true
}
function requestGlyphValue(g: number, v: number) {
    pendingValue = v
    requestGlyph(g)
}
function requestDriveDebug(l: number, r: number) {
    // The pendingGlyph term matters: after STOP or a disconnect has
    // painted its own icon, the next release (0,0) must still repaint the
    // dot even though pendingDebugL/R already read 0,0.
    if (l == pendingDebugL && r == pendingDebugR && pendingGlyph == GLYPH_DRIVE) return
    pendingDebugL = l
    pendingDebugR = r
    pendingGlyph = GLYPH_DRIVE
    debugDirty = true
}
function requestStopIcon() {
    pendingDebugL = 0
    pendingDebugR = 0
    requestGlyph(GLYPH_STOP)
}

// The motor driver is I2C-based (not direct PWM). Generic
// continuous controls still use change detection so they do not hammer
// I2C with essentially identical values. HOWEVER, real-hardware latency
// testing showed that a fixed 125 ms / 8 Hz gate is unacceptable for
// manual steering. MIN_DRIVE_INTERVAL_MS is therefore ZERO in this
// latency build, and the dedicated D-pad path below bypasses driveMix()
// altogether so every actual state change reaches motorRun immediately.
// Keep the change threshold for noisy continuous controls; do not add a
// fixed time gate back into handleDpadMask().
let lastDriveL = 0, lastDriveR = 0
let lastDriveAt = 0
const MIN_DRIVE_INTERVAL_MS = 0    // latency build: state changes write immediately
const DRIVE_CHANGE_THRESHOLD = 15  // ignore jitter smaller than this

// Safety watchdog for the final state-mask protocol. A held D-pad
// periodically re-sends the SAME complete mask (currently ~1000 ms in
// script.js). That refresh is not for steering fidelity; it is a safety
// heartbeat. If the physical release or BLE link disappears, the robot
// must not keep driving forever. 2500 ms leaves room for missed refreshes
// without making a normal held button cut out. Every fresh mask stamps
// lastDriveCmdAt, and link-loss handling independently stops the motors.
let lastDriveCmdAt = 0
const DRIVE_WATCHDOG_MS = 2500

// ═══════════════════════════════════════════════════════════════
// 🤖 DRIVING MODES
// Manual = the D-pad drives. Line / Avoid run autonomously from the
// forever loop. Every autonomous step is a plain state update — no
// blocking waits — so the radio, watchdog and display keep running.
// ═══════════════════════════════════════════════════════════════
const MODE_MANUAL = 0
const MODE_LINE = 1
const MODE_AVOID = 2
let driveMode = MODE_MANUAL

// Line sensors. The V2 chassis has THREE of them (left, center, right).
//
// Unlike Maqueen — whose readPatrol returns 0 on the black line, and whose
// inverted convention this file used to document — mecanumRobotV2's
// LineTracking returns 1 when the sensor IS over the line. Keyestudio's own
// program relies on that directly: center == 1 means drive straight. So the
// raw value already means "on the line" and is passed to the LED widgets
// unchanged; a lit LED means that sensor is on the line.
let lastLineL = -1
let lastLineC = -1
let lastLineR = -1
const LINE_INTERVAL_MS = 100

// NeoPixel animation cadence. ~14 fps is smooth enough to read as motion
// while leaving the radio plenty of air — strip.show() disables interrupts
// for the duration of the bit-bang, so this is deliberately not faster.
const NP_FRAME_MS = 70
// Pixel-stepping effects (Chase, Sparkle) look frantic at frame rate; a
// slower step reads as deliberate movement instead of a flicker.
const NP_STEP_MS = 250
let nextNpAt = 0

// On-board sensors. 500ms is well below anything a human reads as lag and
// keeps the link quiet; every value is also change-gated below.
const SENSOR_INTERVAL_MS = 500
let nextSensorAt = 0
let lastSound = -1
let lastTemp = -999
let lastTiltX = -999
let lastTiltY = -999

// Buttons poll faster than the sensors so a short press is not missed
// between ticks. -1 forces a first send once the layout is delivered.
const BUTTON_INTERVAL_MS = 120
let nextButtonAt = 0
let lastBtnA = -1
let lastBtnB = -1
let lastLogo = -1

// Obstacle-avoid + alert thresholds.
const AVOID_STOP_CM = 20        // back away closer than this
const ALERT_CM = 25             // notify the app below this
const ALERT_CLEAR_CM = 40       // ...and only re-arm once well clear again
let alertActive = false
// The version label is pushed once per session, from the main loop.
// Deliberately NOT sent from the GETCFG handler: writing to the UART
// synchronously inside onUartDataReceived is what broke the handshake in
// the v5 attempt. The loop sends it on the first tick after cfgSent.
let versionSent = false
// Avoid runs as a timed reverse-then-turn so nothing blocks the loop.
let avoidUntil = 0
let avoidPhase = 0              // 0 = cruising, 1 = reversing, 2 = turning

// Declared up here (not next to the forever loop that uses them)
// because onBluetoothDisconnected resets them, and that handler appears
// earlier in the file — static TypeScript rejects use-before-declaration.
let heartbeat = 0

function setKeyesWheel(wheel: LR, value: number) {
    mecanumRobotV2.Motor(wheel, value >= 0 ? MD.Forward : MD.Back, Math.abs(value))
}

// Mecanum mixer: x is strafe (right positive), y is forward.
// Diagonal commands naturally stop two wheels and drive the other two.
function runMecanum(nx: number, ny: number) {
    let fl = Math.constrain(Math.round((ny + nx) * driveSpeed), -driveSpeed, driveSpeed)
    let fr = Math.constrain(Math.round((ny - nx) * driveSpeed), -driveSpeed, driveSpeed)
    let rl = Math.constrain(Math.round((ny - nx) * driveSpeed), -driveSpeed, driveSpeed)
    let rr = Math.constrain(Math.round((ny + nx) * driveSpeed), -driveSpeed, driveSpeed)
    setKeyesWheel(LR.Upper_left, fl)
    setKeyesWheel(LR.Upper_right, fr)
    setKeyesWheel(LR.Lower_left, rl)
    setKeyesWheel(LR.Lower_right, rr)
    lastDriveL = fl
    lastDriveR = fr
}

// Autonomous steering uses rotation rather than sideways translation.
function runMecanumTurn(turn: number, forward: number) {
    let left = Math.constrain(Math.round((forward + turn) * driveSpeed), -driveSpeed, driveSpeed)
    let right = Math.constrain(Math.round((forward - turn) * driveSpeed), -driveSpeed, driveSpeed)
    setKeyesWheel(LR.Upper_left, left)
    setKeyesWheel(LR.Lower_left, left)
    setKeyesWheel(LR.Upper_right, right)
    setKeyesWheel(LR.Lower_right, right)
    lastDriveL = left
    lastDriveR = right
}

function driveMix(nx: number, ny: number) {
    if (Math.abs(nx) < DEAD_ZONE && Math.abs(ny) < DEAD_ZONE) {
        mecanumRobotV2.state()
        dbg("drive: STOP (nx=" + nx + " ny=" + ny + ")")
        requestDriveDebug(0, 0)
        lastDriveL = 0
        lastDriveR = 0
        lastDriveAt = input.runningTime()
        return
    }
    let l = Math.constrain(Math.round((ny + nx) * driveSpeed), -driveSpeed, driveSpeed)
    let r = Math.constrain(Math.round((ny - nx) * driveSpeed), -driveSpeed, driveSpeed)

    let now = input.runningTime()
    let changedEnough = Math.abs(l - lastDriveL) >= DRIVE_CHANGE_THRESHOLD || Math.abs(r - lastDriveR) >= DRIVE_CHANGE_THRESHOLD
    let dueForRefresh = (now - lastDriveAt) >= MIN_DRIVE_INTERVAL_MS
    if (!changedEnough && !dueForRefresh) {
        return  // skip redundant/too-frequent I2C write
    }

    // Drive path, deliberately identical in shape to Maqueen Lab's
    // handleMotor(): two motorRun() calls and nothing that can block.
    // dbg() only pushes to a queue; requestDriveDebug() only sets a
    // flag. No basic.show* here — see showDriveDebug()'s comment.
    runMecanum(nx, ny)
    dbg("drive: nx=" + nx + " ny=" + ny + " -> L=" + l + " R=" + r)
    requestDriveDebug(l, r)
    lastDriveL = l
    lastDriveR = r
    lastDriveAt = now
}

// Same rate-limit/change-detection guard as driveMix(), applied to the
// servo sliders — see the comment at the slider_srv1/2 handlers above.
let lastServo1 = -1, lastServo2 = -1
let lastServo1At = 0, lastServo2At = 0
function servoWriteAllowed(port: number, angle: number): boolean {
    let now = input.runningTime()
    let last = port == 1 ? lastServo1 : lastServo2
    let lastAt = port == 1 ? lastServo1At : lastServo2At
    let changedEnough = Math.abs(angle - last) >= DRIVE_CHANGE_THRESHOLD
    let dueForRefresh = (now - lastAt) >= MIN_DRIVE_INTERVAL_MS
    if (!changedEnough && !dueForRefresh) {
        return false
    }
    if (port == 1) { lastServo1 = angle; lastServo1At = now }
    else { lastServo2 = angle; lastServo2At = now }
    return true
}

// ── NEOPIXEL STRIP ───────────────────────────────────────────────────
// Colours match the order of the np_color select in the layout, so the
// index the app sends is used directly rather than re-parsed from a name.
function npColorAt(i: number): number {
    if (i == 0) return neopixel.colors(NeoPixelColors.Red)
    if (i == 1) return neopixel.colors(NeoPixelColors.Orange)
    if (i == 2) return neopixel.colors(NeoPixelColors.Yellow)
    if (i == 3) return neopixel.colors(NeoPixelColors.Green)
    if (i == 4) return neopixel.colors(NeoPixelColors.Blue)
    if (i == 5) return neopixel.colors(NeoPixelColors.Indigo)
    if (i == 6) return neopixel.colors(NeoPixelColors.Violet)
    if (i == 7) return neopixel.colors(NeoPixelColors.Purple)
    return neopixel.colors(NeoPixelColors.White)
}
// Repaint from current state. Called on every change AND once per animation
// tick; strip.show() is the only expensive part, so effects that are not
// animating simply do not schedule ticks.
function npRender() {
    if (!USE_NEOPIXEL || !strip) return
    if (!npOn) {
        strip.clear()
        strip.show()
        return
    }
    strip.setBrightness(npBright)
    if (npEffect == "Rainbow") {
        // Rotating hue wheel across the four pixels.
        for (let i = 0; i < NEOPIXEL_COUNT; i++) {
            let hue = (npPhase + Math.idiv(i * 360, NEOPIXEL_COUNT)) % 360
            strip.setPixelColor(i, neopixel.hsl(hue, 99, 50))
        }
    } else if (npEffect == "Chase") {
        strip.clear()
        strip.setPixelColor(npPhase % NEOPIXEL_COUNT, npColorAt(npColorIdx))
    } else if (npEffect == "Sparkle") {
        // One lit pixel walking the strip in a random colour, per the
        // reference sketch. randint's floor of 10 keeps every channel above
        // the level where the LEDs read as off rather than dim.
        strip.clear()
        strip.setPixelColor(npPhase % NEOPIXEL_COUNT,
            neopixel.rgb(randint(10, 255), randint(10, 255), randint(10, 255)))
    } else {
        strip.showColor(npColorAt(npColorIdx))
        return          // showColor already pushes
    }
    strip.show()
}

// Boot-scan helper: label the pin on the matrix, then drive it. The display
// is disabled across the flash because P7 is one of its own pins — leaving
// it on would make the P7 test meaningless — and re-enabled afterwards so
// the next label is readable.
function npScanPin(label: string, pin: DigitalPin) {
    basic.showString(label)
    basic.pause(200)
    led.enable(false)
    let s = neopixel.create(pin, NEOPIXEL_COUNT, NeoPixelMode.RGB)
    s.setBrightness(255)
    s.showColor(neopixel.colors(NeoPixelColors.Red)); basic.pause(400)
    s.showColor(neopixel.colors(NeoPixelColors.Green)); basic.pause(400)
    s.showColor(neopixel.colors(NeoPixelColors.Blue)); basic.pause(400)
    s.clear()
    s.show()
    led.enable(true)
    basic.pause(250)
}

// D-pad direction state, driven by the dpad_move handler in
// handleWidget() below. More than one can be true at once (e.g. up+
// right held together) for a diagonal.
let btnFwd = false, btnBack = false, btnLeft = false, btnRight = false
function updateButtonDrive() {
    let ny = 0, nx = 0
    if (btnFwd) ny += 1
    if (btnBack) ny -= 1
    if (btnLeft) nx -= 1
    if (btnRight) nx += 1
    driveMix(nx, ny)
}

function handleDpadMask(mask: number) {
    if (driveMode != MODE_MANUAL) return
    // HOT PATH: a D-pad packet goes straight to the motor driver.
    // Do not route through handleWidget()/dbg()/LED rendering/rate limiting.
    // Those are useful for general controls but add scheduler and BLE work
    // exactly when manual driving needs the lowest possible latency.
    lastDriveCmdAt = input.runningTime()
    btnFwd = (mask & 1) != 0
    btnBack = (mask & 2) != 0
    btnLeft = (mask & 4) != 0
    btnRight = (mask & 8) != 0

    let ny = 0, nx = 0
    if (btnFwd) ny += 1
    if (btnBack) ny -= 1
    if (btnLeft) nx -= 1
    if (btnRight) nx += 1

    if (nx == 0 && ny == 0) {
        mecanumRobotV2.state()
        lastDriveL = 0
        lastDriveR = 0
        lastDriveAt = lastDriveCmdAt
        return
    }

    let l = Math.constrain((ny + nx) * driveSpeed, -driveSpeed, driveSpeed)
    let r = Math.constrain((ny - nx) * driveSpeed, -driveSpeed, driveSpeed)
    runMecanum(nx, ny)
    lastDriveL = l
    lastDriveR = r
    lastDriveAt = lastDriveCmdAt
}

// ═══════════════════════════════════════════════════════════════
// 🎮 WIDGET HANDLERS — driving the robot via mecanumRobotV2
// ═══════════════════════════════════════════════════════════════

// v44 autonomous motor path. Manual D-pad packets have their own direct
// path above; Line/Avoid need the same ownership model. Autonomous motion
// is generated on the micro:bit, so it must not depend on browser D-pad
// keepalives or the Manual drive watchdog.
function driveAuto(nx: number, ny: number) {
    if (driveMode == MODE_MANUAL) return
    let now = input.runningTime()
    if (Math.abs(nx) < DEAD_ZONE && Math.abs(ny) < DEAD_ZONE) {
        mecanumRobotV2.state()
        lastDriveL = 0
        lastDriveR = 0
        lastDriveAt = now
        lastDriveCmdAt = now
        requestDriveDebug(0, 0)
        return
    }
    let l = Math.constrain(Math.round((ny + nx) * driveSpeed), -driveSpeed, driveSpeed)
    let r = Math.constrain(Math.round((ny - nx) * driveSpeed), -driveSpeed, driveSpeed)
    runMecanumTurn(nx, ny)
    lastDriveL = l
    lastDriveR = r
    lastDriveAt = now
    lastDriveCmdAt = now
    requestDriveDebug(l, r)
}

function handleWidget(id: string, val: string) {
    // Every SET command lands here first — logged unconditionally so
    // you can see exactly what the app sent, even for widgets/ids the
    // handlers below don't recognize.
    dbg("recv: " + id + " = " + val)

    // Button: STOP — kill both motors immediately.
    if (id == "btn_stop" && val == "1") {
        mecanumRobotV2.state()
        // Was basic.showIcon(IconNames.No) — blocking, and this runs
        // inside the BLE receive handler. Still shows the ✗, but via
        // the deferred renderer so nothing blocks here.
        lastDriveL = 0
        lastDriveR = 0
        requestStopIcon()
        dbg("stop button pressed")
    }

    // Slider: Speed — top speed for BOTH manual and autonomous driving.
    if (id == "spd") {
        driveSpeed = Math.constrain(parseInt(val), DRIVE_SPEED_MIN, DRIVE_SPEED_MAX)
        uiGaugeSpdDirty = true
        uiGaugeLastInputAt = input.runningTime()
        requestGlyphValue(GLYPH_SERVO, Math.idiv(driveSpeed * 180, DRIVE_SPEED_MAX))
        dbg("speed -> " + driveSpeed)
    }

    // Select: Telemetry — how much the robot reports back.
    if (id == "upd") {
        if (val == "Off") updLevel = UPD_OFF
        else if (val == "Basic") updLevel = UPD_BASIC
        else updLevel = UPD_ALL
        // Re-announce the version on the way back up, since the label
        // would otherwise stay blank from whatever was missed while
        // silenced. Cheap, and it confirms the setting took effect.
        if (updLevel != UPD_OFF) versionSent = false
        dbg("telemetry -> " + val)
    }

    // Select: Distance read — Auto / Read now.
    //
    // "Read now" is intentionally a ONE-SHOT override. It may be used in
    // Manual, Line or Avoid without enabling continuous ultrasonic polling.
    // That preserves the low-latency lesson from v43: a no-echo HC-SR04 read
    // can busy-wait for ~250 ms, so polling it continuously in Manual/Line
    // makes motor control feel laggy. The forever loop performs the actual
    // measurement (never this BLE callback), updates gauge + graph, then
    // publishes UPD dist_read Auto so compatible clients reset the selector.
    if (id == "dist_read" && val == "Read now") {
        forceDistanceOnce = true
        dbg("distance: forced one-shot requested")
    }

    // Select: Mode — Manual / Line / Avoid.
    if (id == "mode") {
        // Always stop first. Switching mode while the wheels are turning
        // would otherwise carry the old command into the new mode.
        mecanumRobotV2.state()
        lastDriveL = 0
        lastDriveR = 0
        btnFwd = false
        btnBack = false
        btnLeft = false
        btnRight = false
        avoidPhase = 0
        avoidUntil = 0
        if (val == "Line") driveMode = MODE_LINE
        else if (val == "Avoid") driveMode = MODE_AVOID
        else driveMode = MODE_MANUAL
        // Reset ownership timing at the mode boundary. The age of the last
        // Manual D-pad packet must never decide whether autonomous motors run.
        lastDriveCmdAt = input.runningTime()
        requestDriveDebug(0, 0)
        dbg("mode -> " + val)
    }

    // Button: Buzz — short confirmation beep.
    if (id == "btn_buzz" && val == "1") {
        requestGlyph(GLYPH_BUZZ)
        music.playTone(440, music.beat(BeatFraction.Quarter))
    }

    // Slider: Servo 1 / Servo 2 — widget's min/max (0-180) already match
    // the extension's servo range, so val is a direct degree value.
    // Same rate-limit/change-detection guard as driveMix(): dragging a
    // slider fires many rapid SET messages, and unthrottled servoRun()
    // calls at that frequency can lock up the I2C bus hard enough to
    // freeze the WHOLE firmware (confirmed: the heartbeat, which never
    // touches I2C, stopped incrementing the moment Servo 1 was dragged).
    if (id == "slider_srv1") {
        // 0..180 is correct despite the extension annotating setServo as
        // -90..90: its body is just pins.servoWritePin(P14, angle), which
        // takes 0..180 and clamps anything negative to 0. Keyestudio's own
        // program passes 0..180 values here too. Do not "fix" this to -90..90.
        let angle1 = Math.constrain(parseInt(val), 0, 180)
        uiServo1 = angle1
        uiGaugeSrv1Dirty = true
        uiGaugeLastInputAt = input.runningTime()
        // Glyph updates on EVERY message, outside the rate-limit gate:
        // the guard exists to protect the I2C bus, not the display, and
        // suppressing feedback while dragging would look like a dropped
        // command. Drawing is deferred to the loop, so it is cheap.
        requestGlyphValue(GLYPH_SERVO, angle1)
        // DIAGNOSTIC (SERVO_DIAG): dbg() only fills an opt-in queue, so it
        // cannot tell us over BLE whether the write actually happened. Echo
        // the branch instead: "SRV w <a>" = written, "SRV s <a>" = skipped by
        // the rate-limit gate. Both appear in the browser console as
        // [BLE RX] Received. Set SERVO_DIAG = false once this is settled.
        if (servoWriteAllowed(1, angle1)) {
            mecanumRobotV2.setServo(angle1)
            dbg("servo S1 -> " + angle1)
            if (SERVO_DIAG) bluetooth.uartWriteLine("SRV w " + angle1)
        } else {
            if (SERVO_DIAG) bluetooth.uartWriteLine("SRV s " + angle1)
        }
    }

    // ── NeoPixel strip ───────────────────────────────────────────
    // Repaint immediately on every change: these are direct responses to a
    // deliberate action, and strip.show() on four pixels is cheap.
    if (id == "toggle_np") {
        npOn = val == "1"
        npRender()
        // DIAGNOSTIC (NP_DIAG): shows in the browser console as
        // [BLE RX] Received: NP on 1 — proves the command reached the
        // firmware, separate from whether the strip physically lit.
        if (NP_DIAG) bluetooth.uartWriteLine("NP on " + val)
    }
    if (id == "np_color") {
        // The select sends the option TEXT; map it back to the index the
        // colour table uses, keeping layout and firmware in one order.
        if (val == "Red") npColorIdx = 0
        else if (val == "Orange") npColorIdx = 1
        else if (val == "Yellow") npColorIdx = 2
        else if (val == "Green") npColorIdx = 3
        else if (val == "Blue") npColorIdx = 4
        else if (val == "Indigo") npColorIdx = 5
        else if (val == "Violet") npColorIdx = 6
        else if (val == "Purple") npColorIdx = 7
        else npColorIdx = 8
        npOn = true
        npRender()
        if (NP_DIAG) bluetooth.uartWriteLine("NP col " + npColorIdx)
    }
    if (id == "np_bright") {
        npBright = Math.constrain(parseInt(val), 0, 255)
        npRender()
        if (NP_DIAG) bluetooth.uartWriteLine("NP br " + npBright)
    }
    if (id == "np_effect") {
        npEffect = val
        npPhase = 0
        npOn = true
        npRender()
        if (NP_DIAG) bluetooth.uartWriteLine("NP fx " + npEffect)
    }

    // Toggle: LED L / LED R
    if (id == "toggle_led_l") {
        requestGlyphValue(GLYPH_LED_L, val == "1" ? 1 : 0)
        mecanumRobotV2.setLed(LedCount.Left, val == "1" ? LedState.ON : LedState.OFF)
    }
    if (id == "toggle_led_r") {
        requestGlyphValue(GLYPH_LED_R, val == "1" ? 1 : 0)
        mecanumRobotV2.setLed(LedCount.Right, val == "1" ? LedState.ON : LedState.OFF)
    }

    // D-pad: Drive (val = "<dir> <1|0>", dir = up/down/left/right).
    // All 4 directions share this ONE widget id — see the header
    // comment on the app-side reliable-send fix (sendReliable() /
    // bleSend.queue) that makes this safe. Each direction just sets
    // its own boolean; multiple can be held at once for a diagonal,
    // same as the earlier 4-separate-buttons approach.
    if (id == "dpad_move") {
        // Ignored while an autonomous mode owns the motors — otherwise a
        // stray press would fight the behaviour for control of the same
        // two wheels. Switch the Mode selector back to Manual to drive.
        if (driveMode != MODE_MANUAL) {
            dbg("dpad ignored (mode " + driveMode + ")")
            return
        }
        lastDriveCmdAt = input.runningTime()
        let parts = val.split(" ")
        let dir = parts[0]
        let pressed = parts[1] == "1"
        if (dir == "up") btnFwd = pressed
        else if (dir == "down") btnBack = pressed
        else if (dir == "left") btnLeft = pressed
        else if (dir == "right") btnRight = pressed
        dbg("dpad: " + dir + " = " + pressed)
        updateButtonDrive()
    }
}

// ═══════════════════════════════════════════════════════════════
// 📤 SEND VALUES TO APP (optional — none of this layout's widgets
// are output widgets, but sendValue() is here if you add a gauge,
// label or LED-output widget later, e.g. to show DIST:cm)
// ═══════════════════════════════════════════════════════════════

function sendValue(id: string, val: string) {
    // btConnected as well as cfgSent — see the flag's declaration for
    // why writing to a dead UART is not merely wasteful but blocking.
    if (!btConnected || !cfgSent) return
    if (updLevel == UPD_OFF) return
    // Basic keeps the uptime clock and the version label — the two that
    // answer "is it alive?" and "what is flashed?" — and drops the rest.
    if (updLevel == UPD_BASIC && id != "lbl_heartbeat" && id != "lbl_ver") return
    bluetooth.uartWriteLine("UPD " + id + " " + val)
}

// ═══════════════════════════════════════════════════════════════
// 🚀 STARTUP
// ═══════════════════════════════════════════════════════════════

// Safety: stop any leftover motion and center servos on boot.
mecanumRobotV2.state()
mecanumRobotV2.setServo(90)

// DIAGNOSTIC (SERVO_DIAG): sweep the servo before Bluetooth, the display
// glyphs or the motors are involved. This isolates the hardware from the
// runtime path — if the head visibly moves 90 -> 140 -> 40 -> 90 here but
// not from the slider, P14, the servo, its power and the extension are all
// proven good and the fault is downstream in handleWidget/servoWriteAllowed.
// If it does NOT move here either, stop looking at the app entirely.
if (SERVO_DIAG) {
    if (USE_MATRIX) basic.showString("S")
    mecanumRobotV2.setServo(140); basic.pause(600)
    mecanumRobotV2.setServo(40); basic.pause(600)
    mecanumRobotV2.setServo(90); basic.pause(300)
}

// Boot pin scan — runs before the real strip is created, and only when
// NP_PIN_SCAN is on. Full brightness so there is no ambiguity about whether
// something lit. The scan is the one place the display is deliberately used
// even when USE_MATRIX is false: it needs to label each pin, and it turns
// the display off across every flash so a matrix pin like P7 gets a fair
// test. The permanent handover below runs afterwards.
if (USE_NEOPIXEL && NP_PIN_SCAN) {
    // Ordered by how likely each is, so the answer usually arrives early:
    //   P8  - the KS4031 V1 tutorial's documented WS2812 pin
    //   P7  - the pin the V2 sample program uses
    //   P1/P2 - freed on V2, which moved the line sensors to P3/P4/P10
    //   P12/P13/P0 - the remaining unclaimed pins on this chassis
    // P3, P4, P10 (line), P14 (servo), P15/P16 (ultrasonic) and P9 (IR) are
    // all spoken for, so they are not worth driving.
    npScanPin("8", DigitalPin.P8)
    npScanPin("7", DigitalPin.P7)
    npScanPin("1", DigitalPin.P1)
    npScanPin("2", DigitalPin.P2)
    npScanPin("12", DigitalPin.P12)
    npScanPin("13", DigitalPin.P13)
    npScanPin("0", DigitalPin.P0)
    basic.showString("?")
    basic.pause(400)
}

// Release the matrix pins for good: P3/P4/P10 to the line sensors and P7 to
// the NeoPixel strip. Must come AFTER the scan, which re-enables the display
// to draw its labels, or both would spend the session fighting the matrix.
if (!USE_MATRIX) {
    basic.clearScreen()
    led.enable(false)
}

// P7 is a matrix pin, so this only works with the display off — which the
// handover above has already done, for the line sensors' sake as well.
if (USE_NEOPIXEL) {
    strip = neopixel.create(NEOPIXEL_PIN, NEOPIXEL_COUNT, NeoPixelMode.RGB)
    strip.setBrightness(npBright)

    // DIAGNOSTIC (NP_DIAG): drive the strip red/green/blue before Bluetooth,
    // the app, or any widget exists. This separates the hardware from the
    // command path. If the strip lights here but not from the app, the pin,
    // power and extension are all proven good and the fault is in
    // handleWidget/npRender. If it stays dark here, nothing in the app or
    // the layout matters — it is the pin, the power, or the strip itself.
    if (NP_DIAG) {
        strip.showColor(neopixel.colors(NeoPixelColors.Red)); basic.pause(500)
        strip.showColor(neopixel.colors(NeoPixelColors.Green)); basic.pause(500)
        strip.showColor(neopixel.colors(NeoPixelColors.Blue)); basic.pause(500)
    }

    strip.clear()
    strip.show()
}

if (USE_MATRIX) {
    basic.showString(FIRMWARE_VERSION)
    // Idle indicator: a hollow ring, held until BLE connects. Deliberately
    // not a filled shape — ■ already means "STOP pressed" and the centre dot
    // means "motors idle", so a solid glyph here would be confusable. The
    // ring reads as "powered, waiting", and it must be visibly different
    // from a blank screen, otherwise a booted-but-unconnected robot looks
    // indistinguishable from a flat battery.
    basic.showLeds(`
    . # # # .
    # . . . #
    # . . . #
    # . . . #
    . # # # .
    `, 0)
}
dbg("Keyes Mecanum firmware " + FIRMWARE_VERSION + " ready, waiting for BLE connection...")

bluetooth.onBluetoothConnected(function () {
    btConnected = true
    dbg("BLE connected")
})

// Safety: kill motors when the link goes away, so the robot does not
// keep driving on the last command it received.
//
// Called from TWO places: the BLE disconnect event (which does not fire
// on this board, but costs nothing to keep wired up in case another one
// behaves) and the silence timeout in the forever loop, which is what
// actually catches it here. Idempotent — whichever arrives first wins.
function handleLinkLost() {
    if (linkLostHandled) return
    linkLostHandled = true
    // FIRST: stop anything else from touching the radio. Every write
    // after this point would block on a dead link and wedge the BLE
    // stack, which is what made the next connect hang in service
    // discovery. Also drop any queued log lines — they are addressed to
    // a peer that is gone.
    btConnected = false
    cfgSent = false
    cfgTxActive = false
    cfgTxStage = 0
    cfgTxPos = 0
    cfgTxChunkIdx = 0
    cfgVerPending = false
    cfgVerReplyAt = 0
    uiInitialSyncStage = 0
    uiGaugeSrv1Dirty = false
    uiGaugeSrv2Dirty = false
    uiGaugeSpdDirty = false
    uiGaugeTxNextAt = 0
    logQueue = []
    // v46: reboot the BLE peripheral after the X is painted. This is the
    // automatic replacement for the physical RESET that was previously
    // required before GETCFG would work after a disconnect.
    bleStackResetAt = input.runningTime() + BLE_STACK_RESET_DELAY_MS
    mecanumRobotV2.state()
    // Clear the drive state too, not just the motors. Otherwise, if the
    // link dropped mid-drive, lastDriveL/R stay non-zero and the loop's
    // watchdog fires ~700ms later, calling requestDriveDebug(0,0) and
    // repainting the centre dot straight over the ✗ — so a disconnect
    // that happened while moving looked like an ordinary stop.
    lastDriveL = 0
    lastDriveR = 0
    lastDriveCmdAt = input.runningTime()
    btnFwd = false
    btnBack = false
    btnLeft = false
    btnRight = false
    // Reset the drive glyph state, then request ✗ through the single
    // renderer below so nothing can overwrite it.
    pendingDebugL = 0
    pendingDebugR = 0
    requestGlyph(GLYPH_DISCONNECTED)
    // Heartbeat restarts per session, so the clock reads session uptime
    // rather than time since power-on.
    heartbeat = 0
    // Force the next line readings to be transmitted even if they match
    // the last ones from the previous session — otherwise the line LEDs
    // sit blank until something happens to change. (The graph is not
    // deduped at all, so it needs no reset.)
    lastLineL = -1
    lastLineC = -1
    lastLineR = -1
    // Same reasoning for the on-board sensors and buttons: the app rebuilds
    // its widgets empty on every connect, so change-gated values must be
    // forced to re-send. Temperature in particular can sit unchanged for
    // minutes, which would leave that gauge blank for the whole session.
    lastSound = -1
    lastTemp = -999
    lastTiltX = -999
    lastTiltY = -999
    lastBtnA = -1
    lastBtnB = -1
    lastLogo = -1
    alertActive = false
    // Re-announce the version on the next connect; the app rebuilds its
    // widgets from scratch each session, so the label would be blank.
    versionSent = false
    // Drop out of any autonomous mode. The loop already stops running
    // behaviours once btConnected goes false, but resetting here means a
    // reconnect starts in a known, stationary state rather than silently
    // resuming Line or Avoid the moment the link returns.
    driveMode = MODE_MANUAL
    avoidPhase = 0
    avoidUntil = 0
    dbg("link lost, motors stopped")
}

// Kept wired up even though it does not fire on this board — it costs
// nothing, and handleLinkLost() is idempotent so it cannot double-run
// with the silence timeout.
bluetooth.onBluetoothDisconnected(function () {
    dbg("BLE disconnect event")
    handleLinkLost()
    // If the main loop is ever stuck in a UART write, reset from this event
    // fiber anyway. X remains visible briefly, then Bluetooth starts clean.
    basic.pause(BLE_STACK_RESET_DELAY_MS)
    control.reset()
})

// ═══════════════════════════════════════════════════════════════
// 💓 HEARTBEAT — proves the firmware loop AND the BLE link are both
// genuinely alive, independent of pressing any button. Uses the same
// sendValue()/"UPD id val" mechanism the app already understands (see
// script.js's processLine handling of "UPD " lines) — NOT a bare
// bluetooth.uartWriteLine() call from inside a receive handler, which
// is exactly what broke everything in the v5 attempt. This only ever
// fires from the main forever loop, never from inside
// onUartDataReceived, so there's no receive/send conflict.
// ═══════════════════════════════════════════════════════════════

// 1s tick, reported as an uptime clock ("0d 00:01:05") rather than a
// raw count — it reads as session duration at a glance instead of a
// number you have to divide.
const HEARTBEAT_INTERVAL_MS = 1000
let nextHeartbeatAt = 0

// Zero-pad to two digits so the clock columns stay aligned.
function pad2(n: number): string {
    return n < 10 ? "0" + n : "" + n
}
// heartbeat counts seconds since the session started, so it doubles as
// the uptime source. Math.idiv is integer division — plain / would give
// a float and print "0.0166d".
//
// Leading all-zero units are omitted, so the display stays as short as
// the elapsed time actually requires and each unit only appears once it
// means something:
//        7s -> "07"
//       65s -> "01:05"
//     3661s -> "01:01:01"
//    90061s -> "1d 01:01:01"
// Padding is kept on the units that DO show, so the digits stay aligned
// and the value does not jitter in width every second.
function uptimeString(totalSec: number): string {
    let d = Math.idiv(totalSec, 86400)
    let h = Math.idiv(totalSec % 86400, 3600)
    let m = Math.idiv(totalSec % 3600, 60)
    let s = totalSec % 60
    if (d > 0) return d + "d " + pad2(h) + ":" + pad2(m) + ":" + pad2(s)
    if (h > 0) return pad2(h) + ":" + pad2(m) + ":" + pad2(s)
    if (m > 0) return pad2(m) + ":" + pad2(s)
    return pad2(s)
}
// Ultrasonic polling cadence.
//
// The ultrasonic read is the most expensive call in this firmware, and
// its cost depends entirely on whether an echo comes back. From the
// library source, one readUlt() is basic.pause(1) + basic.pause(20) +
// pins.pulseIn(..., 500*58) — a 29ms timeout. An echo returns almost at
// once; no echo waits the timeout out, and Ultrasonic() then retries up
// to four more times. So a working sensor at ~30cm costs ~25ms, while a
// disconnected or out-of-range one costs ~250ms — and pulseIn BUSY-WAITS
// without yielding, freezing the whole runtime rather than just this
// loop. Polling this carelessly is what made the robot feel frozen.
//
// Two mitigations, both still earning their place:
//   1. Skipped while the wheels are turning (except in Avoid, where the
//      distance IS the input). A stall nobody notices while parked is
//      ruinous mid-drive.
//   2. Adaptive backoff — brisk while real distances come back, doubling
//      to DIST_INTERVAL_MAX_MS while the sensor reports nothing. The
//      expensive case is exactly the uninformative one.
const DIST_INTERVAL_MS = 400          // when the sensor is returning real distances
const DIST_INTERVAL_MAX_MS = 5000     // when it keeps reporting "no echo"
let distInterval = DIST_INTERVAL_MS
const DIST_MAX_CM = 200          // matches the gauge's max in CFG
let nextDistAt = 0
let nextDistDiagAt = 0
let forceDistanceOnce = false   // v49: selector-triggered one-shot in ANY mode
let nextLineAt = 0

// The ultrasonic read used in the earlier build of this controller, and the
// one proven on this robot (66, 35, 51 cm then; 67 cm now). Differences from
// mecanumRobotV2.ultra(): a 15us trigger instead of 10us, an explicit
// PullNone on the ECHO pin (the extension only sets it on the trigger), and
// *0.017 instead of /58 — arithmetically the same.
//
// Used first simply because it is the version with a track record here. An
// earlier comment claimed the extension's ultra() "times out on this board";
// that was wrong. Both routines returned 0 during a spell when the sensor
// itself was disconnected, so the extension was never actually given a fair
// test — it is kept below as a fallback rather than dismissed.
// Is anything actually attached to the echo line? A powered HC-SR04 drives
// ECHO low between pings, and its push-pull output beats a weak internal
// pull-up. So: pull P16 up, read it, and put it back.
//   0 -> something is driving the line: sensor present and powered
//   1 -> nothing is: disconnected, or its 5V rail is dead
// This distinguishes "sensor is there but not answering" from "no sensor",
// which no amount of pulseIn tuning can.
function echoIdleLevel(): number {
    pins.setPull(DigitalPin.P16, PinPullMode.PullUp)
    control.waitMicros(200)
    let lvl = pins.digitalReadPin(DigitalPin.P16)
    pins.setPull(DigitalPin.P16, PinPullMode.PullNone)
    return lvl
}

function ultraRaw(): number {
    pins.setPull(DigitalPin.P15, PinPullMode.PullNone)
    pins.setPull(DigitalPin.P16, PinPullMode.PullNone)
    pins.digitalWritePin(DigitalPin.P15, 0); control.waitMicros(2)
    pins.digitalWritePin(DigitalPin.P15, 1); control.waitMicros(15)
    pins.digitalWritePin(DigitalPin.P15, 0)
    let t = pins.pulseIn(DigitalPin.P16, PulseValue.High, 35000)
    return Math.round(t * 0.017)
}

basic.forever(function () {
    let now = input.runningTime()

    // Drive watchdog runs every 100ms (finer than the 1s heartbeat
    // cadence below) so a stalled/dropped "stop" packet gets caught
    // within DRIVE_WATCHDOG_MS instead of up to a full second late.
    // Manual safety watchdog only. v43 accidentally supervised Line/Avoid
    // with the D-pad keepalive timeout too. Avoid can legitimately spend
    // longer than that between ultrasonic polls after no-echo backoff.
    if (driveMode == MODE_MANUAL && (lastDriveL != 0 || lastDriveR != 0) && now - lastDriveCmdAt > DRIVE_WATCHDOG_MS) {
            mecanumRobotV2.state()
        dbg("watchdog: no drive update for " + DRIVE_WATCHDOG_MS + "ms, auto-stop")
        requestDriveDebug(0, 0)
        lastDriveL = 0
        lastDriveR = 0
    }

    // ── DISPLAY FIRST, RADIO LAST ────────────────────────────────
    // Order is load-bearing, not cosmetic. bluetooth.uartWriteLine()
    // BLOCKS the calling fiber when the link is down or its buffer
    // cannot drain — the same landmine as serial.writeLine(). The two
    // writes below used to run BEFORE this render block, so at the
    // moment of a disconnect the loop would block inside a write that
    // never completes, and since this loop is the only thing that draws
    // the LED matrix, the ✗ was never painted. Drawing first means a
    // wedged radio can no longer starve the display.
    if (USE_MATRIX && debugDirty) {
        debugDirty = false
        if (pendingGlyph == GLYPH_STOP) {
            // Square = "stop" (like a stop button). Deliberately NOT
            // IconNames.No — that ✗ means "BLE disconnected", and the
            // two must stay visually distinct. Also distinct from
            // showDriveDebug's centre dot (motors idle) and
            // SmallDiamond (one wheel only).
            basic.showIcon(IconNames.Square, 0)
        } else if (pendingGlyph == GLYPH_DISCONNECTED) {
            basic.showIcon(IconNames.No, 0)
        } else if (pendingGlyph == GLYPH_CONNECTED) {
            basic.showIcon(IconNames.Yes, 0)
        } else if (pendingGlyph == GLYPH_LED_L) {
            // Left band solid when that LED is on, just its corners when
            // off — so the side tells you WHICH led and the fill tells
            // you its state, readable at a glance from across the table.
            if (pendingValue == 1) {
                basic.showLeds(`
                    # # . . .
                    # # . . .
                    # # . . .
                    # # . . .
                    # # . . .
                    `, 0)
            } else {
                basic.showLeds(`
                    # . . . .
                    . . . . .
                    . . . . .
                    . . . . .
                    # . . . .
                    `, 0)
            }
        } else if (pendingGlyph == GLYPH_LED_R) {
            if (pendingValue == 1) {
                basic.showLeds(`
                    . . . # #
                    . . . # #
                    . . . # #
                    . . . # #
                    . . . # #
                    `, 0)
            } else {
                basic.showLeds(`
                    . . . . #
                    . . . . .
                    . . . . .
                    . . . . .
                    . . . . #
                    `, 0)
            }
        } else if (pendingGlyph == GLYPH_BUZZ) {
            basic.showIcon(IconNames.QuarterNote, 0)
        } else if (pendingGlyph == GLYPH_SERVO) {
            // Bar graph scaled 0-180 — shows the angle as a magnitude
            // rather than a number, and unlike showNumber() it never
            // scrolls (scrolling would block this loop for seconds).
            led.plotBarGraph(pendingValue, 180)
        } else {
            showDriveDebug(pendingDebugL, pendingDebugR)
        }
    }

    // ── LINK LOSS BY SILENCE ─────────────────────────────────────
    // The real disconnect detector on this board, since the BLE event
    // never fires. The app pings once a second, so silence past
    // LINK_TIMEOUT_MS means the peer is gone — a closed tab, a reload,
    // a crashed browser, or simply walking out of range. Checked BEFORE
    // the radio gate below, because btConnected is set by an event that
    // is exactly the thing we cannot trust here.
    // ── BLE STACK RECOVERY (v46) ────────────────────────────────
    // The disconnect event resets from its own fiber too, but the silence
    // detector uses this path when the platform callback is missed.
    if (bleStackResetAt > 0 && now >= bleStackResetAt) {
        control.reset()
        return
    }

    // ── CONFIG REVISION REPLY (v47) ─────────────────────────────
    // This one short notification is the normal reconnect path. If the
    // browser already cached this revision it answers CFGOK and the robot is
    // ready immediately; otherwise it asks for the full transfer below.
    if (btConnected && cfgVerPending && now >= cfgVerReplyAt) {
        bluetooth.uartWriteLine("CFGVER " + CFG_REV)
        cfgVerPending = false
        basic.pause(20)
        return
    }

    // ── CONFIG TX STATE MACHINE (v46) ───────────────────────────
    // Never stream the whole layout from onUartDataReceived(). Sending one
    // notification per pass keeps RX and TX decoupled and lets disconnect
    // handling run between chunks.
    if (btConnected && cfgTxActive) {
        if (now >= cfgTxNextAt) {
            if (cfgTxStage == 0) {
                // Announce how many chunks are coming. The app matches this line
                // with startsWith(), so a client that does not read the count is
                // unaffected -- but one that does can show a truthful progress
                // bar instead of guessing. The same total is already computed
                // below for the LED sweep, so this costs nothing new.
                bluetooth.uartWriteLine("CFGBEGIN " + Math.idiv(CFG.length + 17, 18))
                cfgTxStage = 1
                cfgTxNextAt = now + CFG_TX_GAP_MS
            } else if (cfgTxStage == 1) {
                if (cfgTxPos < CFG.length) {
                    bluetooth.uartWriteLine("CFG " + CFG.substr(cfgTxPos, 18))
                    cfgTxPos += 18
                    cfgTxChunkIdx += 1
                    let totalChunks = Math.idiv(CFG.length + 17, 18)
                    let target = Math.idiv(cfgTxChunkIdx * 25, totalChunks)
                    while (cfgTxLit < target) {
                        if (USE_MATRIX) led.plot(cfgTxLit % 5, Math.idiv(cfgTxLit, 5))
                        cfgTxLit += 1
                    }
                    cfgTxNextAt = now + CFG_TX_GAP_MS
                } else {
                    cfgTxStage = 2
                }
            } else {
                bluetooth.uartWriteLine("CFGEND")
                cfgTxActive = false
                cfgSent = true
                scheduleInitialUiSync()
                requestGlyph(GLYPH_CONNECTED)
                dbg("layout sent, cfgSent = true")
            }
        }
        // Keep the transfer loop tighter than the normal 100 ms control loop,
        // and do not mix heartbeat/sensor/log notifications into CFG traffic.
        basic.pause(20)
        return
    }

    if (cfgSent && !linkLostHandled && now - lastRxAt > LINK_TIMEOUT_MS) {
        handleLinkLost()
    }

    // Everything below talks to the radio, so it is all gated on
    // btConnected — set by the connect/disconnect events rather than
    // inferred from cfgSent. Writing to a dead UART is what wedges the
    // BLE stack, and a wedged stack is why getPrimaryService() hung
    // forever on the next connect attempt.
    if (!btConnected) {
        basic.pause(100)
        return
    }


    // ── CONFIG-NATIVE CONTROL GAUGES (v48) ───────────────────────
    // First publish the true boot/control values for both sliders and
    // gauges. After that, publish only a coalesced gauge update when a
    // slider has been quiet for a moment. A client that understands the
    // CFG `source` field mirrors instantly with zero BLE; older clients
    // still receive the firmware UPD shortly after the drag settles.
    if (cfgSent && now >= uiGaugeTxNextAt) {
        let uiSent = false
        if (uiInitialSyncStage > 0) {
            if (uiInitialSyncStage == 1) sendUiValue("slider_srv1", "" + uiServo1)
            else if (uiInitialSyncStage == 2) sendUiValue("gauge_srv1", "" + uiServo1)
            else if (uiInitialSyncStage == 3) sendUiValue("spd", "" + driveSpeed)
            else if (uiInitialSyncStage == 4) sendUiValue("gauge_spd", "" + driveSpeed)
            uiInitialSyncStage += 1
            if (uiInitialSyncStage > 4) uiInitialSyncStage = 0
            uiGaugeTxNextAt = now + UI_GAUGE_TX_GAP_MS
            uiSent = true
        } else if (now - uiGaugeLastInputAt >= UI_GAUGE_SETTLE_MS) {
            if (uiGaugeSrv1Dirty) {
                sendUiValue("gauge_srv1", "" + uiServo1)
                uiGaugeSrv1Dirty = false
                uiSent = true
            } else if (uiGaugeSpdDirty) {
                sendUiValue("gauge_spd", "" + driveSpeed)
                uiGaugeSpdDirty = false
                uiSent = true
            }
            if (uiSent) uiGaugeTxNextAt = now + UI_GAUGE_TX_GAP_MS
        }
        if (uiSent) {
            basic.pause(20)
            return
        }
    }

    // Scheduled off runningTime(), NOT by accumulating an assumed
    // 100ms per iteration. Each pass is pause(100) PLUS however long
    // the work took, so the old counter drifted slow exactly when the
    // firmware was busy — the heartbeat under-reported trouble at the
    // precise moment it was supposed to reveal it.
    if (now >= nextHeartbeatAt) {
        nextHeartbeatAt = now + HEARTBEAT_INTERVAL_MS
        if (cfgSent) {
            heartbeat += 1
            // v50: heartbeat visibility follows the Telemetry selector, not
            // the drive mode. sendValue() already enforces the policy:
            //   All/Basic -> heartbeat is transmitted
            //   Off       -> heartbeat is silent
            // Do not suppress heartbeat merely because Line/Avoid motors
            // are moving; autonomous drive is local to the micro:bit and
            // should not make the connection appear frozen.
            sendValue("lbl_heartbeat", uptimeString(heartbeat))
        }
    }

    // Firmware version, pushed once per session on the first tick after
    // the layout is delivered. Same value the LED matrix scrolls at
    // boot, but readable in the app — so "which build is actually on
    // this robot?" can be answered without watching the matrix or
    // plugging in USB. That question cost real time more than once.
    if (cfgSent && !versionSent) {
        versionSent = true
        if ((lastDriveL == 0 && lastDriveR == 0) || now - lastDriveCmdAt > 500) sendValue("lbl_ver", FIRMWARE_VERSION)
    }

    // ── NeoPixel animation ───────────────────────────────────────
    // Only animating effects schedule work. Solid repaints on change and
    // then costs nothing, which matters because strip.show() bit-bangs P7
    // with interrupts disabled and is the one thing here that can disturb
    // BLE timing if run flat out.
    if (USE_NEOPIXEL && npOn && now >= nextNpAt && npEffect != "Solid") {
        // Sparkle steps a whole pixel per frame like Chase, so it wants the
        // slower cadence; only Rainbow sweeps hue and needs a big step.
        nextNpAt = now + (npEffect == "Rainbow" ? NP_FRAME_MS : NP_STEP_MS)
        npPhase = (npPhase + (npEffect == "Rainbow" ? 12 : 1)) % 360
        npRender()
    }

    // ── micro:bit on-board sensors ───────────────────────────────
    // All cheap, non-blocking reads — unlike the ultrasonic, none of these
    // busy-wait, so a fixed 500ms cadence is safe even while driving.
    // Change-only sending keeps a still robot from filling the link.
    //
    // ⚠️ DO NOT ADD input.lightLevel() HERE. The micro:bit senses light with
    // the LED matrix itself, so that call re-enables the display — which
    // reclaims P3, P4, P7, P9 and P10. Polling it every 500ms silently stole
    // P7 back from the NeoPixel strip and corrupted the line sensors, while
    // the boot self-test still passed because it runs before this loop.
    // Light level is fundamentally incompatible with this chassis's pinout.
    if (cfgSent && now >= nextSensorAt) {
        nextSensorAt = now + SENSOR_INTERVAL_MS

        let snd = input.soundLevel()
        if (snd != lastSound) { lastSound = snd; sendValue("gauge_sound", "" + snd) }

        let tmp = input.temperature()
        if (tmp != lastTemp) { lastTemp = tmp; sendValue("gauge_temp", "" + tmp) }

        // Milli-g mapped to a -100..100 percentage of 1g, which reads far
        // better on a gauge than a raw 4-digit acceleration value.
        let tx = Math.constrain(Math.idiv(input.acceleration(Dimension.X), 10), -100, 100)
        let ty = Math.constrain(Math.idiv(input.acceleration(Dimension.Y), 10), -100, 100)
        if (tx != lastTiltX) { lastTiltX = tx; sendValue("gauge_tiltx", "" + tx) }
        if (ty != lastTiltY) { lastTiltY = ty; sendValue("gauge_tilty", "" + ty) }
    }

    // ── micro:bit buttons / logo touch ───────────────────────────
    // Polled fast and sent on change so a press is not swallowed between
    // slower sensor ticks. These are inputs ON the robot mirrored INTO the
    // app, which is the only way to see them once the matrix is off.
    if (cfgSent && now >= nextButtonAt) {
        nextButtonAt = now + BUTTON_INTERVAL_MS
        let a = input.buttonIsPressed(Button.A) ? 1 : 0
        let b = input.buttonIsPressed(Button.B) ? 1 : 0
        let lg = input.logoIsPressed() ? 1 : 0
        if (a != lastBtnA) { lastBtnA = a; sendValue("led_btn_a", "" + a) }
        if (b != lastBtnB) { lastBtnB = b; sendValue("led_btn_b", "" + b) }
        if (lg != lastLogo) { lastLogo = lg; sendValue("led_logo", "" + lg) }
    }

    // ── Line sensors ─────────────────────────────────────────────
    // Polled every 100ms and pushed to the three LED widgets on CHANGE
    // only. LineTracking is a plain digital pin read — no echo wait, so
    // unlike the ultrasonic it costs nothing to poll often.
    if (driveMode != MODE_MANUAL && now >= nextLineAt) {
        nextLineAt = now + LINE_INTERVAL_MS
        let onL = mecanumRobotV2.LineTracking(LT.Left)
        let onC = mecanumRobotV2.LineTracking(LT.Center)
        let onR = mecanumRobotV2.LineTracking(LT.Right)
        if (cfgSent && onL != lastLineL) {
            lastLineL = onL
            if ((lastDriveL == 0 && lastDriveR == 0) || driveMode != MODE_MANUAL) sendValue("ln_l", "" + onL)
        }
        if (cfgSent && onC != lastLineC) {
            lastLineC = onC
            if ((lastDriveL == 0 && lastDriveR == 0) || driveMode != MODE_MANUAL) sendValue("ln_c", "" + onC)
        }
        if (cfgSent && onR != lastLineR) {
            lastLineR = onR
            if ((lastDriveL == 0 && lastDriveR == 0) || driveMode != MODE_MANUAL) sendValue("ln_r", "" + onR)
        }

        // Line-following. This truth table is Keyestudio's own, ported from
        // their working three-sensor program rather than reasoned out: the
        // center sensor decides "straight", and an outer sensor firing on its
        // own means the line has drifted to that side, so steer toward it.
        if (driveMode == MODE_LINE) {
            if (onL == 1 && onR == 1) {
                driveAuto(0, 1)          // both outers lit (junction) -> straight
            } else if (onC == 1 && onL == 0 && onR == 0) {
                driveAuto(0, 1)          // centered -> straight
            } else if (onL == 1 && onR == 0) {
                driveAuto(-0.6, 0.4)     // line is off to the left -> bear left
            } else if (onR == 1 && onL == 0) {
                driveAuto(0.6, 0.4)      // line is off to the right -> bear right
            } else {
                // Nothing sees the line. The reference program stops here
                // rather than hunting, so a lost line does not turn into the
                // robot spinning off across the room.
                driveAuto(0, 0)
            }
            lastDriveCmdAt = now        // keep the watchdog satisfied
        }
    }

    // ── Ultrasonic (HC-SR04) — AVOID MODE ONLY ───────────────────
    //
    // This sensor is expensive enough to define the feel of the whole
    // robot. Measured from the original pxt-maqueen source, one read is
    // basic.pause(1) + basic.pause(20) + pins.pulseIn(..., 500*58) — a
    // 29ms timeout, so ~50ms per attempt. With no echo Ultrasonic()
    // retries up to four more times: ~250ms per call. pulseIn BUSY-WAITS
    // without yielding, so that is a hard freeze of the entire runtime,
    // not merely of this loop.
    //
    // "No echo" is the normal state for a robot pointing at open space,
    // so it hit that worst case almost every poll. Polling it
    // continuously to feed a gauge and a graph cost roughly 83% of the
    // robot's life at the original 300ms interval, and the symptom was
    // exactly what you would expect: motors and servos unresponsive,
    // then outright freezing.
    //
    // Earlier experiments tried mitigations such as skipping reads while
    // driving and adaptive backoff. The final latency fix is stronger:
    //
    //   - Manual/Line: never POLL Ultrasonic(); only an explicit v49 one-shot may read it.
    //   - Avoid: distance is required, so poll there and use adaptive
    //     backoff when the expensive no-echo result persists.
    // This is why Telemetry alone is not enough: even an unsent sensor
    // reading can freeze the runtime before BLE gets a chance to run.
    // A no-echo read can busy-wait for ~250ms and freeze BLE command handling,
    // so polling is gated three ways: it never runs while the wheels are
    // turning (busyDriving), it is rate-limited by distInterval, and that
    // interval backs off to DIST_INTERVAL_MAX_MS while no-echo persists.
    //
    // Distance has TWO triggers:
    //   1) automatic polling in EVERY mode, subject to the gates above;
    //   2) an explicit one-shot from the CFG selector.
    // The one-shot deliberately ignores busyDriving because the operator asked
    // for it explicitly, so it can cause one brief HC-SR04 timeout stall.
    let forceDist = forceDistanceOnce
    // "Distance read: Auto" now means auto in EVERY mode. This used to
    // require MODE_AVOID, so in Manual the only source of samples was a
    // Read-now click — a single point, which a time-series graph cannot plot
    // and which made the distance graph look permanently dead. busyDriving
    // still suppresses polling while the wheels turn, so the ~29ms echo wait
    // never lands in the middle of manual steering.
    let autoDistDue = now >= nextDistAt
    let busyDriving = (lastDriveL != 0 || lastDriveR != 0) && driveMode != MODE_AVOID
    // DIAGNOSTIC (DIST_DIAG): if no "DST" line ever appears, the poll itself
    // is being gated -- report why, once a second, rather than staying silent.
    if (DIST_DIAG && cfgSent && now >= nextDistDiagAt) {
        nextDistDiagAt = now + 1000
        if (!(forceDist || (autoDistDue && !busyDriving))) {
            bluetooth.uartWriteLine("DST gate busy=" + (busyDriving ? 1 : 0) + " due=" + (autoDistDue ? 1 : 0) + " int=" + distInterval)
            // Console only. This used to write the label too, once a second,
            // which meant it continually overwrote the raw reading that fires
            // on the slower poll — the label showed the gate state almost
            // always and the actual measurement almost never.
        }
    }
    if (cfgSent && (forceDist || (autoDistDue && !busyDriving))) {
        if (forceDist) forceDistanceOnce = false
        // Must advance unconditionally now that autoDistDue is mode-independent —
        // leaving it un-stamped outside Avoid would poll on every loop pass.
        nextDistAt = now + distInterval
        {
            // ultraRaw() first, mecanumRobotV2.ultra() as a fallback: the
            // former is the routine with a proven history on this hardware,
            // and trying it first avoids burning a 35ms timeout per reading
            // if the other one turns out not to suit this sensor.
            let cm = ultraRaw()
            let cmAlt = 0
            if (cm <= 0) {
                cmAlt = mecanumRobotV2.ultra()
                if (cmAlt > 0) cm = cmAlt
            }
            // DIAGNOSTIC (DIST_DIAG): both raw values, before any mapping or
            // the cm > 0 guard that would otherwise swallow them silently.
            // Label shows "r<final>/<fallback>": r66/0 = ultraRaw works (the
            // expected result), r66/66 = only the extension works, r0/0 =
            // neither echoes, which would point at the sensor itself.
            if (DIST_DIAG) {
                let echo = echoIdleLevel()
                bluetooth.uartWriteLine("DST raw " + cm + " alt " + cmAlt + " echo " + echo)
                sendUiValue("lbl_ver", FIRMWARE_VERSION + " r" + cm + "/" + cmAlt + " e" + echo)
            }
            // Adapt the next interval to what we just got back. 500 is
            // the "no echo" sentinel and is the reading that costs the
            // full ~250ms retry stall, so keep backing off while it
            // persists; any real distance restores the fast rate.
            if (DIST_DIAG) {
                // Backing off to 5s while diagnosing hides the very reading we
                // are trying to see. Stay at the fast interval until the raw
                // value is understood.
                distInterval = DIST_INTERVAL_MS
            } else if (cm >= 500 || cm <= 0) {
                distInterval = Math.min(distInterval * 2, DIST_INTERVAL_MAX_MS)
            } else {
                distInterval = DIST_INTERVAL_MS
            }
            // Decide what we'd report; -1 means "nothing to report".
            let reported = -1
            if (cm >= 500) {
                // "no echo" sentinel. No echo means
                // nothing bounced back, i.e. the path is CLEAR — so
                // report the top of the gauge, not 0. Reporting 0 would
                // read as "obstacle touching the bumper", the exact
                // opposite of the truth.
                reported = DIST_MAX_CM
            } else if (cm > 0) {
                reported = Math.min(cm, DIST_MAX_CM)
            } else {
                // cm <= 0 is a bad read, not a measurement. Skip the
                // update and leave the last good value on screen rather
                // than inventing a number in either direction.
                dbg("dist: bad read (" + cm + ")")
            }
            // Raw value logged on every poll, so flipping debugEnabled
            // on answers "is this sensor alive at all?" directly rather
            // than by inference from the graph.
            dbg("dist raw=" + cm + " next=" + distInterval + "ms")

            // Sent on EVERY poll, deliberately not deduped. A change-only
            // rule is right for a gauge — a repeated identical number
            // tells the viewer nothing — but wrong for a graph, which is
            // a time series: with no new samples a steady reading draws
            // no points at all and looks like a dead feed. That is
            // exactly how it appeared when parked facing open space,
            // where every reading is the same 200 "no echo" sentinel.
            //
            // The cost is one short message per poll, and polls are
            // already rate-limited by distInterval and skipped entirely
            // while driving, so this adds very little traffic.
            //
            // The graph widget takes comma-separated numbers, one per
            // series; a single series means a bare number is the payload.
            //
            // The RAW cm goes to the graph, not the mapped `reported`.
            // `reported` folds the 500 "no echo" sentinel down
            // to DIST_MAX_CM (200), which made "nothing bounced back"
            // indistinguishable from "an object exactly 200cm away" — so
            // a sensor that never echoes looked identical to a clear
            // path, and the graph could not tell us which. Raw values
            // are unambiguous: a flat line at 500 means no echo, ever;
            // anything under 400 is a real measurement. The graph
            // auto-scales, so the wider range costs nothing.
            //
            // `reported` is still what drives the alert and Avoid mode,
            // where "no echo == far away" is the correct reading.
            if (cm > 0) {
                if (forceDist) sendUiValue("graph_dist", "" + cm)
                else sendValue("graph_dist", "" + cm)
            }
            // The gauge gets the MAPPED value: on a dial, "no echo"
            // should read as a clear path (full scale), not as an
            // obstacle against the bumper. The graph gets the raw value
            // instead, so the two together still distinguish a dead
            // sensor from an empty room.
            if (reported >= 0) {
                if (forceDist) sendUiValue("gauge_dist", "" + reported)
                else sendValue("gauge_dist", "" + reported)
            }

            // Reset the momentary CFG selector after the requested sample.
            // sendUiValue bypasses the Telemetry selector on purpose: this is
            // direct feedback to an explicit user action, not background data.
            if (forceDist) sendUiValue("dist_read", "Auto")

            // Obstacle alert, with hysteresis so it fires once on
            // approach instead of chattering around the threshold: it
            // arms below ALERT_CM and only re-arms once the path is
            // clear past ALERT_CLEAR_CM.
            if (reported >= 0) {
                if (!alertActive && reported < ALERT_CM) {
                    alertActive = true
                    sendValue("alert", "Obstacle " + reported + "cm")
                    dbg("alert: obstacle at " + reported + "cm")
                } else if (alertActive && reported > ALERT_CLEAR_CM) {
                    alertActive = false
                    dbg("alert: cleared")
                }
            }

            // Obstacle avoidance: reverse briefly, then pivot, then
            // resume. Phases are driven by timestamps, never by pauses,
            // so the loop keeps servicing the radio and the watchdog.
            if (driveMode == MODE_AVOID) {
                if (avoidPhase == 0) {
                    if (reported >= 0 && reported < AVOID_STOP_CM) {
                        avoidPhase = 1
                        avoidUntil = now + 600
                        driveAuto(0, -1)         // back up
                    } else {
                        driveAuto(0, 1)          // path clear -> cruise
                    }
                } else if (avoidPhase == 1 && now >= avoidUntil) {
                    avoidPhase = 2
                    avoidUntil = now + 500
                    driveAuto(1, 0)              // pivot away
                } else if (avoidPhase == 2 && now >= avoidUntil) {
                    avoidPhase = 0
                }
                lastDriveCmdAt = now            // keep the watchdog satisfied
            }
        }
    }

    // Drain ONE queued debug line per tick (see dbg() above for why
    // this can't happen synchronously from onUartDataReceived). At
    // most 10/sec — plenty for discrete dpad/button/servo events,
    // and naturally paced by the same 100ms this loop already pauses.
    if (cfgSent && logQueue.length > 0 && (lastDriveL == 0 && lastDriveR == 0) && now - lastDriveCmdAt > 500) {
        bluetooth.uartWriteLine("LOG " + logQueue.shift())
    }

    basic.pause(100)
})

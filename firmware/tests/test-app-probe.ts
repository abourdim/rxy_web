/**
 * PROBE — not a robot test. Paste this to find what MakeCode objects to.
 *
 * Extensions: bluetooth  (nothing else)
 *
 * test-ble.ts compiles. The test-app-*.ts files do not: MakeCode reports
 * "!!proc || !bin.finalPass" pointing at the uartReadUntil line, which is the
 * same line test-ble.ts uses happily. So the call is fine and something
 * structural around it is not.
 *
 * This file is test-ble.ts plus exactly one new thing: the CFG pump that every
 * test-app-*.ts shares. Nothing robot-related, no extensions beyond bluetooth,
 * no helper functions.
 *
 *   COMPILES  -> the shared skeleton is innocent; the fault is in the
 *                per-test code (helper functions, extension calls, or the
 *                order they appear in) and I will bisect from there.
 *   FAILS     -> the fault is in the pump itself, and this 45-line file is
 *                small enough to fix properly instead of by guesswork.
 *
 * Expected if it runs: connect from the app and it sends a tiny two-widget
 * layout, so a PROBE panel appears with one button.
 */

// A minimal valid layout: one group, one button, one label.
const CFG = "eyJ0aXRsZSI6IlByb2JlIiwid2lkZ2V0cyI6W3siaWQiOiJidG5fYSIsInQiOiJidXR0b24iLCJ4Ijo4MCwieSI6ODAsInciOjE0MCwiaCI6MTQwLCJsYWJlbCI6IlByZXNzIG1lIn1dLCJjYW52YXMiOnsidyI6MzAwLCJoIjozMDB9fQ=="

bluetooth.startUartService()
bluetooth.setTransmitPower(7)

let cfgWanted = false
let cfgTxPos = 0
let cfgTxActive = false
let cfgTxNextAt = 0

bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
})

bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
})

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    let cmd = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    if (cmd == "GETCFG") {
        cfgWanted = true
    }
})

basic.forever(function () {
    if (cfgWanted) {
        cfgWanted = false
        cfgTxPos = 0
        cfgTxActive = true
        bluetooth.uartWriteLine("CFGBEGIN")
        cfgTxNextAt = input.runningTime() + 35
    }
    if (cfgTxActive && input.runningTime() >= cfgTxNextAt) {
        if (cfgTxPos < CFG.length) {
            bluetooth.uartWriteLine("CFG " + CFG.substr(cfgTxPos, 18))
            cfgTxPos += 18
            cfgTxNextAt = input.runningTime() + 35
        } else {
            bluetooth.uartWriteLine("CFGEND")
            cfgTxActive = false
        }
    }
    basic.pause(5)
})

basic.showIcon(IconNames.SmallSquare)

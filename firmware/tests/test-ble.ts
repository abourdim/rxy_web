/**
 * TEST: BLUETOOTH — flash this alone.
 *
 * Extensions: Bluetooth  (mecanum_robot_v2 is NOT needed)
 * Project Settings: enable "No Pairing Required".
 *
 * A bare UART echo. It proves the radio, the pairing setting and the
 * browser side, with no robot hardware involved at all — so when the real
 * firmware will not connect, this tells you whether the problem is BLE or
 * everything else.
 *
 * HOW TO USE
 *   1. Flash. The display shows a small square = advertising, waiting.
 *   2. In Chrome open any Web Bluetooth console, or the remote app's
 *      Connect button, and pick "BBC micro:bit [xxxxx]".
 *   3. Connected shows a tick. Anything you send comes back as "ECHO <text>".
 *
 * PASS: tick on connect, and every line you send echoes back.
 * FAIL: the chooser is empty -> you are filtering on the UART SERVICE. The
 *         micro:bit never advertises it; filter by namePrefix instead.
 *       "GATT Error: Not supported" -> your TX/RX UUIDs are swapped.
 *         On micro:bit 6e400002 NOTIFIES and 6e400003 takes WRITES —
 *         the opposite of the usual Nordic convention.
 *       connects then drops -> "No Pairing Required" is probably off.
 */
bluetooth.startUartService()
bluetooth.setTransmitPower(7)

bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
    bluetooth.uartWriteLine("HELLO from micro:bit")
})

bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
})

bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    let line = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    bluetooth.uartWriteLine("ECHO " + line)
    basic.showIcon(IconNames.SmallDiamond)
    basic.pause(150)
    basic.showIcon(IconNames.Yes)
})

basic.showIcon(IconNames.SmallSquare)   // advertising, waiting for a connection

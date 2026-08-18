/**
 * TEST: LINE SENSORS — flash this alone.
 *
 * Extensions: mecanum_robot_v2
 *
 * ⚠️ The three sensors are on P3, P4 and P10 — all LED-matrix pins. The
 * display MUST be off or every read is noise. That is why this test cannot
 * show anything on the matrix, and reports through the HEADLIGHTS instead
 * (they are on I2C, so they are free):
 *
 *      left sensor  on the line -> LEFT headlight on
 *      right sensor on the line -> RIGHT headlight on
 *      centre sensor on the line -> short beep
 *
 * Serial also prints all three, if you have a USB cable.
 *
 * PASS: sliding the robot across a black stripe lights left, then centre
 *       (beep), then right, one at a time.
 * FAIL: all three stuck, or flickering randomly -> the display is still on;
 *       confirm led.enable(false) really ran
 *       always 0 on white AND black -> sensor height, or the trim pot
 */
led.enable(false)   // must come before any read. P3/P4/P10 belong to the matrix.

let lastC = -1

basic.forever(function () {
    let l = mecanumRobotV2.LineTracking(LT.Left)
    let c = mecanumRobotV2.LineTracking(LT.Center)
    let r = mecanumRobotV2.LineTracking(LT.Right)

    serial.writeLine("L=" + l + " C=" + c + " R=" + r)

    mecanumRobotV2.setLed(LedCount.Left, l == 1 ? LedState.ON : LedState.OFF)
    mecanumRobotV2.setLed(LedCount.Right, r == 1 ? LedState.ON : LedState.OFF)

    // Beep only on the transition, or it screams continuously on a line.
    if (c == 1 && lastC != 1) {
        music.playTone(880, 120)
    }
    lastC = c

    basic.pause(120)
})

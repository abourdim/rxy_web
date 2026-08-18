/**
 * TEST: HEADLIGHTS — flash this alone.
 *
 * Extensions: mecanum_robot_v2
 *
 * The two headlights are driven over I2C (address 0x30), not by a pin, so
 * this test conflicts with nothing and the display stays usable.
 *
 * PASS: left on, right on, both on, both off — in a loop, with L/R/B/-
 *       on the display naming the expected state.
 * FAIL: neither ever lights -> the I2C driver has no power (battery switch),
 *                              or the firmware is using the V1 extension
 *       both light together -> LedCount.Left/Right are reversed on this board
 */
function show(label: string, l: LedState, r: LedState) {
    basic.showString(label)
    mecanumRobotV2.setLed(LedCount.Left, l)
    mecanumRobotV2.setLed(LedCount.Right, r)
    basic.pause(1000)
}

basic.forever(function () {
    show("L", LedState.ON, LedState.OFF)
    show("R", LedState.OFF, LedState.ON)
    show("B", LedState.ON, LedState.ON)
    show("-", LedState.OFF, LedState.OFF)
})

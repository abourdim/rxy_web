/**
 * TEST: MOTORS — flash this alone, nothing else needed.
 *
 * Extensions: mecanum_robot_v2
 * (Bluetooth is NOT needed. Leave it out — it only slows the flash.)
 *
 * Drives each wheel on its own, then the four whole-robot moves.
 * The display shows which step is running, so you can tell a dead wheel
 * from a mis-wired one without guessing.
 *
 * PASS: 1 2 3 4 each spin ONE wheel forward then back. Then the robot
 *       goes forward, back, strafes left, strafes right.
 * FAIL: nothing moves at all      -> wrong extension (V1 vs V2), or the
 *                                    battery switch is off. USB alone does
 *                                    not power the motor rail.
 *       one number spins nothing  -> that motor's connector
 *       "strafe" spins on the spot-> two wheels are swapped
 */
let SPEED = 40

function step(label: string, which: LR) {
    basic.showString(label)
    mecanumRobotV2.Motor(which, MD.Forward, SPEED)
    basic.pause(1200)
    mecanumRobotV2.state()
    basic.pause(400)
    mecanumRobotV2.Motor(which, MD.Back, SPEED)
    basic.pause(1200)
    mecanumRobotV2.state()
    basic.pause(600)
}

function allWheels(ul: number, ll: number, ur: number, lr: number) {
    mecanumRobotV2.Motor(LR.Upper_left, ul > 0 ? MD.Forward : MD.Back, ul == 0 ? 0 : SPEED)
    mecanumRobotV2.Motor(LR.Lower_left, ll > 0 ? MD.Forward : MD.Back, ll == 0 ? 0 : SPEED)
    mecanumRobotV2.Motor(LR.Upper_right, ur > 0 ? MD.Forward : MD.Back, ur == 0 ? 0 : SPEED)
    mecanumRobotV2.Motor(LR.Lower_right, lr > 0 ? MD.Forward : MD.Back, lr == 0 ? 0 : SPEED)
}

function move(label: string, ul: number, ll: number, ur: number, lr: number) {
    basic.showString(label)
    allWheels(ul, ll, ur, lr)
    basic.pause(1500)
    mecanumRobotV2.state()
    basic.pause(800)
}

basic.forever(function () {
    step("1", LR.Upper_left)
    step("2", LR.Lower_left)
    step("3", LR.Upper_right)
    step("4", LR.Lower_right)

    move("F", 1, 1, 1, 1)     // forward
    move("B", -1, -1, -1, -1) // back
    move("L", -1, 1, 1, -1)   // strafe left
    move("R", 1, -1, -1, 1)   // strafe right

    basic.showIcon(IconNames.Yes)
    basic.pause(1500)
})

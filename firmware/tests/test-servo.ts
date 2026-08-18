/**
 * TEST: HEAD SERVO — flash this alone.
 *
 * Extensions: mecanum_robot_v2
 *
 * Sweeps the ultrasonic head and shows the angle as a bar.
 * SERVO_OFFSET is the mechanical trim: on this chassis 90 alone does not
 * point straight ahead. Adjust it here until the head is square with the
 * robot, then copy the value into the real firmware.
 *
 * PASS: the head sweeps smoothly right, left, then centres.
 * FAIL: no movement at all -> P14 wiring, or the servo's 5V rail (battery
 *                             switch off; USB alone will not drive it)
 *       jitter / buzzing   -> weak battery, or the servo is fighting an end stop
 */
const SERVO_OFFSET = 20

function head(angle: number) {
    let a = Math.constrain(angle + SERVO_OFFSET, 0, 180)
    mecanumRobotV2.setServo(a)
    led.plotBarGraph(angle, 180)
}

basic.forever(function () {
    for (let a = 20; a <= 160; a += 10) {
        head(a)
        basic.pause(120)
    }
    basic.pause(400)
    for (let b = 160; b >= 20; b -= 10) {
        head(b)
        basic.pause(120)
    }
    basic.pause(400)
    head(90)              // centre — the head should now face straight ahead
    basic.showIcon(IconNames.Yes)
    basic.pause(1200)
})

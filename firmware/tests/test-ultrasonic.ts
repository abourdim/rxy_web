/**
 * TEST: ULTRASONIC — flash this alone.
 *
 * Extensions: mecanum_robot_v2
 *
 * Reads the HC-SR04 twice: once with the 15us trigger this project uses,
 * once with the extension's own ultra(). Showing both tells you whether a
 * zero is the sensor or the read routine.
 *
 * The number scrolls on the display, so no USB cable is needed.
 *
 * PASS: a plausible distance in cm that tracks your hand.
 * FAIL: 0 from BOTH  -> the sensor: 5V rail (battery switch), or the
 *                       connector, which rides the moving servo head
 *       0 from ONE   -> that read routine does not suit this module;
 *                       keep the one that answers
 */
function ultraRaw(): number {
    pins.setPull(DigitalPin.P15, PinPullMode.PullNone)
    pins.setPull(DigitalPin.P16, PinPullMode.PullNone)
    pins.digitalWritePin(DigitalPin.P15, 0); control.waitMicros(2)
    pins.digitalWritePin(DigitalPin.P15, 1); control.waitMicros(15)
    pins.digitalWritePin(DigitalPin.P15, 0)
    let t = pins.pulseIn(DigitalPin.P16, PulseValue.High, 35000)
    return Math.round(t * 0.017)
}

// Is anything attached at all? A powered HC-SR04 drives ECHO low between
// pings and beats a weak pull-up. 1 here means nothing is driving the line.
function echoIdle(): number {
    pins.setPull(DigitalPin.P16, PinPullMode.PullUp)
    control.waitMicros(200)
    let lvl = pins.digitalReadPin(DigitalPin.P16)
    pins.setPull(DigitalPin.P16, PinPullMode.PullNone)
    return lvl
}

basic.forever(function () {
    let a = ultraRaw()
    let b = mecanumRobotV2.ultra()
    serial.writeLine("raw=" + a + " ext=" + b + " echoIdle=" + echoIdle())
    if (a > 0) {
        basic.showNumber(a)
    } else if (b > 0) {
        basic.showNumber(b)
    } else {
        basic.showIcon(IconNames.No)   // nothing echoed
    }
    basic.pause(600)
})

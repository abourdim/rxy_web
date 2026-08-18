/**
 * TEST: NEOPIXEL STRIP — flash this alone.
 *
 * Extensions: mecanum_robot_v2, Neopixel
 *
 * ⚠️ On this chassis the strip is on P7, which is an LED-matrix pin, so the
 * display must be off. P8 is the V1 pin and is WRONG here — if you are
 * working from the KS4031 tutorial, that is why nothing lights.
 *
 * Cycles red / green / blue, then a moving dot, then a random sparkle.
 *
 * PASS: all four LEDs light in each colour, then one dot walks the strip.
 * FAIL: nothing at all -> set PIN to P8 below and re-flash. If P8 works,
 *                          you have a V1 chassis.
 *       wrong colours   -> change NeoPixelMode.RGB to RGB_RGB or RGB_GRB
 */
const PIN = DigitalPin.P7      // V2. Use P8 for a V1 chassis.
const COUNT = 4

let strip = neopixel.create(PIN, COUNT, NeoPixelMode.RGB)
led.enable(false)              // P7 belongs to the matrix; hand it over
strip.setBrightness(120)

let phase = 0

basic.forever(function () {
    strip.showColor(neopixel.colors(NeoPixelColors.Red)); basic.pause(600)
    strip.showColor(neopixel.colors(NeoPixelColors.Green)); basic.pause(600)
    strip.showColor(neopixel.colors(NeoPixelColors.Blue)); basic.pause(600)

    // Moving dot — proves each pixel individually, not just the whole strip.
    for (let i = 0; i < COUNT * 2; i++) {
        strip.clear()
        strip.setPixelColor(i % COUNT, neopixel.colors(NeoPixelColors.White))
        strip.show()
        basic.pause(220)
    }

    // Random sparkle
    for (let k = 0; k < 12; k++) {
        strip.clear()
        strip.setPixelColor(randint(0, COUNT - 1),
            neopixel.rgb(randint(10, 255), randint(10, 255), randint(10, 255)))
        strip.show()
        basic.pause(150)
    }

    strip.clear()
    strip.show()
    basic.pause(500)
})

/**
 * TEST: MICRO:BIT ON-BOARD SENSORS — flash this alone.
 *
 * Extensions: none (micro:bit V2 only, for the microphone)
 *
 * Cycles through the sensors the remote reports, one per display page, so
 * you can confirm each before wiring it into the app.
 *
 * ⚠️ Light level is deliberately NOT here. The micro:bit senses light with
 * the LED matrix itself, so reading it re-enables the display — which on
 * this chassis steals P3/P4/P10 from the line sensors and P7 from the
 * NeoPixel strip. It is unusable on this robot; do not add it back.
 *
 * PASS: sound rises when you clap, temperature is roughly room temperature,
 *       tilt changes as you tip the board, A/B/logo register presses.
 */
basic.forever(function () {
    basic.showString("S")
    basic.showNumber(input.soundLevel())      // 0-255, V2 microphone
    basic.pause(300)

    basic.showString("T")
    basic.showNumber(input.temperature())     // CPU sensor, degrees C
    basic.pause(300)

    // Milli-g mapped to a percentage of 1g — easier to read than raw values.
    basic.showString("X")
    basic.showNumber(Math.constrain(Math.idiv(input.acceleration(Dimension.X), 10), -100, 100))
    basic.pause(300)

    basic.showString("Y")
    basic.showNumber(Math.constrain(Math.idiv(input.acceleration(Dimension.Y), 10), -100, 100))
    basic.pause(300)

    // Inputs: hold one down to see it register on this pass.
    if (input.buttonIsPressed(Button.A)) {
        basic.showString("A")
    }
    if (input.buttonIsPressed(Button.B)) {
        basic.showString("B")
    }
    if (input.logoIsPressed()) {
        basic.showString("O")
    }
    basic.pause(200)
})

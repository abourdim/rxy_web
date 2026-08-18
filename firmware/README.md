# Keyes 4WD Mecanum RXY firmware

This MakeCode project embeds the complete widget layout in `main.ts`. When the web app connects, it requests that configuration from the micro:bit and renders the controls supplied by the firmware.

## MakeCode

1. Create a micro:bit project and add `github:keyestudio2019/mecanum_robot_v2` plus the Bluetooth extension.
2. Switch to JavaScript and replace `main.ts` with this project’s `main.ts`.
3. In Project Settings, select **No Pairing Required** for Bluetooth.
4. Download to a micro:bit V2 installed in the KS4031/KS4032 robot.

Test with the wheels lifted. Manual left/right D-pad input strafes; diagonals use two wheels. Line and Avoid modes retain rotational steering.

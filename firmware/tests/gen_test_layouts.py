"""Generate the app-driven test layouts for the mecanum robot.

One panel per subsystem, sized for children: few widgets, large targets, a
one-line instruction, and a CFG small enough that the 18-char/35ms chunk
pacing these tests inherit from main.ts still loads it in a couple of seconds.

Widget ids deliberately match main.ts, so each test's handler is the real one
rather than a lookalike that can quietly drift away from it.
"""
import json, base64, itertools, os, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
PAD, TITLE = 24, 34


def W(id, t, x, y, w, h, label, **kw):
    d = dict(id=id, t=t, x=x, y=y, w=w, h=h, label=label)
    d.update(kw)
    return d


def panel(title, label, color, members, hint):
    members = list(members)
    x1 = min(m["x"] for m in members); y1 = min(m["y"] for m in members)
    x2 = max(m["x"] + m["w"] for m in members); y2 = max(m["y"] + m["h"] for m in members)
    grp = dict(id="grp_test", t="group", label=label, color=color,
               x=x1 - PAD, y=y1 - PAD - TITLE,
               w=(x2 + PAD) - (x1 - PAD), h=(y2 + PAD) - (y1 - PAD - TITLE),
               children=[m["id"] for m in members])
    for m in members:
        m["groupId"] = "grp_test"
    # The hint must go in `value`, not only `label`. The runtime renders a label
    # as `val || label`, and getRuntimeWidgetValue() falls back to the STRING "0"
    # when nothing has been sent -- which is truthy, so the label fallback never
    # fires. lbl_hint never receives an UPD, so it would read "0" forever.
    note = W("lbl_hint", "label", x1, y2 + 40, min(760, x2 - x1), 70, hint, value=hint, model="card")
    widgets = [grp] + members + [note]
    cfg = {"title": title, "widgets": widgets,
           "canvas": {"w": max(w["x"] + w["w"] for w in widgets) + 56,
                      "h": max(w["y"] + w["h"] for w in widgets) + 56}}

    box = lambda w: (w["x"], w["y"], w["x"] + w["w"], w["y"] + w["h"])
    def ov(a, b):
        a1, b1, a2, b2 = box(a); c1, d1, c2, d2 = box(b)
        return not (a2 <= c1 or c2 <= a1 or b2 <= d1 or d2 <= b1)
    ctrls = [w for w in widgets if w["t"] != "group"]
    errs = [f"{a['id']}~{b['id']}" for a, b in itertools.combinations(ctrls, 2) if ov(a, b)]
    gx1, gy1, gx2, gy2 = box(grp)
    for m in members:
        mx1, my1, mx2, my2 = box(m)
        if mx1 < gx1 + PAD or mx2 > gx2 - PAD or my1 < gy1 + TITLE or my2 > gy2 - PAD:
            errs.append(f"{m['id']} escapes group")
    assert not errs, f"{label}: {errs}"
    return cfg


P = {}

# Link test first: it is the precondition for every other panel here, so it
# proves both directions (a button in, a label out) and touches no hardware
# beyond the buzzer.
P["ble"] = panel("Mecanum - Link test", "LINK", "#60a5fa", [
    W("lbl_ver", "label",       80, 100, 300, 80, "Firmware", model="card"),
    W("lbl_heartbeat", "label", 80, 200, 300, 80, "Uptime", model="card"),
    W("btn_buzz", "button",    420, 100, 150, 150, "Beep"),
], "If the uptime counts and Beep makes a sound, the link works.")

P["leds"] = panel("Mecanum - Headlights test", "HEADLIGHTS", "#fbbf24", [
    W("toggle_led_l", "toggle",  80, 100, 160, 140, "Left lamp"),
    W("toggle_led_r", "toggle", 260, 100, 160, 140, "Right lamp"),
], "Switch each lamp on and off. They are the cheapest thing on the robot.")

P["motors"] = panel("Mecanum - Motors test", "MOTORS", "#00d4ff", [
    W("dpad_move", "dpad",    80, 100, 420, 420, "Mecanum drive", model="mecanum"),
    W("spd", "slider",       540, 100, 150, 240, "Speed", min=24, max=100, step=2, value=78),
    W("btn_stop", "button",  540, 380, 150, 140, "STOP"),
    W("gauge_spd", "gauge",   80, 560, 220, 200, "Motor speed", min=24, max=100,
      decimals=0, model="min", source="spd", value=78),
], "Press an arrow. The robot moves that way. The corners go diagonally.")

P["servo"] = panel("Mecanum - Head test", "HEAD", "#ff9500", [
    W("slider_srv1", "slider", 80, 100, 150, 260, "Head angle", min=0, max=180, step=1, value=90),
    W("gauge_srv1", "gauge",  270, 100, 220, 200, "Angle", min=0, max=180, units="deg",
      decimals=0, model="min", source="slider_srv1", value=90),
], "Slide it. The sensor head should turn to match the number.")

P["distance"] = panel("Mecanum - Distance test", "DISTANCE", "#ffb020", [
    W("gauge_dist", "gauge",   80, 100, 220, 200, "Distance", min=0, max=200,
      units="cm", decimals=0, model="classic"),
    W("alert", "notification", 330, 110, 110, 180, "Obstacle"),
    W("graph_dist", "graph",    80, 340, 420, 240, "Distance cm", model="grid",
      windowSec=30, series=1),
], "Move your hand in front of the sensor and watch the line move.")

P["line"] = panel("Mecanum - Line test", "LINE SENSORS", "#00e676", [
    W("ln_l", "led",  80, 100, 120, 130, "Left",   model="dot", colorOn="#4ade80"),
    W("ln_c", "led", 220, 100, 120, 130, "Center", model="dot", colorOn="#4ade80"),
    W("ln_r", "led", 360, 100, 120, 130, "Right",  model="dot", colorOn="#4ade80"),
], "Slide black tape under the robot. The light above it should change.")

P["lights"] = panel("Mecanum - Strip test", "LIGHTS", "#c084fc", [
    W("toggle_led_l", "toggle",  80, 100, 140, 120, "Left lamp"),
    W("toggle_led_r", "toggle", 240, 100, 140, 120, "Right lamp"),
    W("toggle_np", "toggle",    400, 100, 140, 120, "Strip"),
    W("np_color", "select",      80, 260, 190,  90, "Colour",
      options="Red,Orange,Yellow,Green,Blue,Indigo,Violet,Purple,White"),
    W("np_effect", "select",    290, 260, 190,  90, "Effect",
      options="Solid,Rainbow,Chase,Sparkle"),
    W("np_bright", "slider",    510, 240, 150, 240, "Bright", min=0, max=255, step=5, value=150),
], "Switch the lamps on, then pick a colour for the strip.")

P["microbit"] = panel("Mecanum - micro:bit test", "MICRO:BIT", "#f472b6", [
    W("gauge_sound", "gauge",  80, 100, 200, 190, "Sound", min=0, max=255, decimals=0),
    W("gauge_temp", "gauge",  300, 100, 200, 190, "Temperature", min=0, max=50,
      units="C", decimals=0),
    W("gauge_tiltx", "gauge",  80, 330, 200, 190, "Tilt X", min=-100, max=100,
      units="%", decimals=0),
    W("gauge_tilty", "gauge", 300, 330, 200, 190, "Tilt Y", min=-100, max=100,
      units="%", decimals=0),
    W("led_btn_a", "led",     540, 110, 110, 120, "Button A", model="dot", colorOn="#60a5fa"),
    W("led_btn_b", "led",     540, 250, 110, 120, "Button B", model="dot", colorOn="#60a5fa"),
    W("led_logo", "led",      540, 390, 110, 120, "Logo",     model="dot", colorOn="#f472b6"),
], "Clap, tilt the robot, press A and B. Everything should move.")

ORDER = ["ble", "leds", "motors", "servo", "distance", "line", "lights", "microbit"]

print(f"{'panel':10} {'widgets':>7} {'JSON':>6} {'base64':>7} {'chunks':>7} {'load':>7}")
out = {}
for name in ORDER:
    cfg = P[name]
    mini = json.dumps(cfg, separators=(",", ":"))
    b64 = base64.b64encode(mini.encode()).decode()
    n = -(-len(b64) // 18)          # these tests keep main.ts's 18-char chunks
    out[name] = b64
    print(f"{name:10} {len(cfg['widgets']):7} {len(mini):6} {len(b64):7} {n:7} {n*0.035:6.1f}s")
    json.dump(cfg, open(f"{HERE}/layout_{name}.json", "w"), indent=1)

with open(f"{HERE}/layouts_b64.txt", "w", newline="\n") as f:
    for name in ORDER:
        f.write(f"### {name}\n")
        f.write("\n".join(textwrap.wrap(out[name], 100)) + "\n\n")
print(f"\nwrote {len(ORDER)} layout JSONs + layouts_b64.txt")

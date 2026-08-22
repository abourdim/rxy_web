"""Bake the share QR into index.html.

The address is a constant, so the app ships a picture rather than an encoder:
nothing to maintain, nothing to run on every page load, and it works offline
and from file:// alike. Run this only if the published address changes.

    python tools/make-qr.py
"""
import io, os, re, sys

import qrcode

URL = "https://abourdim.github.io/rxy_web/"
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "..", "index.html")


def matrix(url):
    # Level Q, not L: this gets scanned off a phone screen at an angle, often
    # a fingerprinted one. The extra correction costs a few modules and buys
    # back every one of those.
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_Q,
                      box_size=1, border=4)
    q.add_data(url)
    q.make(fit=True)
    return q.get_matrix(), q.version


def to_svg(m, url):
    n = len(m)
    # One <path> of horizontal runs, not one <rect> per module: the same
    # picture in a third of the bytes.
    d = []
    for y, row in enumerate(m):
        x = 0
        while x < n:
            if row[x]:
                run = 1
                while x + run < n and row[x + run]:
                    run += 1
                d.append("M%d %dh%dv1h-%dz" % (x, y, run, run))
                x += run
            else:
                x += 1
    return ('<svg class="qr-img" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" '
            'shape-rendering="crispEdges" role="img" aria-label="QR code for %s">'
            '<rect width="%d" height="%d" fill="#fff"/>'
            '<path fill="#000" d="%s"/></svg>') % (n, n, url, n, n, "".join(d))


def read_back(svg, n):
    """Parse the path back into a matrix. The run-length packing is the only
    hand-written part here, so it is the only part worth proving."""
    got = [[False] * n for _ in range(n)]
    for x, y, run in re.findall(r"M(\d+) (\d+)h(\d+)v1h-\d+z", svg):
        for i in range(int(run)):
            got[int(y)][int(x) + i] = True
    return got


m, version = matrix(URL)
svg = to_svg(m, URL)
if read_back(svg, len(m)) != [[bool(v) for v in row] for row in m]:
    sys.exit("FAILED: the SVG does not reproduce the QR matrix")

page = io.open(PAGE, encoding="utf-8").read()
new, n_sub = re.subn(r"<!--qr:begin-->.*?<!--qr:end-->",
                     lambda _m: "<!--qr:begin-->" + svg + "<!--qr:end-->",
                     page, count=1, flags=re.S)
assert n_sub == 1, "qr markers not found in index.html"
io.open(PAGE, "w", encoding="utf-8", newline="\n").write(new)

print("  %s" % URL)
print("  version %d, %dx%d modules including the 4-module quiet zone" % (version, len(m), len(m)))
print("  %d bytes of SVG, verified to reproduce the matrix exactly" % len(svg))

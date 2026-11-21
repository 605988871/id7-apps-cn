#!/usr/bin/env python3
"""Mirror of decode.c's geometry, checked against pictures of the sizes CarLife uses.

The decoder itself cannot run on the build machine: it needs the unit's MSDK
library and a VA display. Its arithmetic can run anywhere, and that is where a
mistake is silent - a rectangle one pixel too wide does not fail, it reads the
row next door, and nobody sees it on a 480-row picture until the map is shifted
by a hair.

So this is rect_of(), blit() and read_crop()'s clamps again, in Python, with the
same arithmetic, run over the sizes a phone actually asks for (1920x720,
1920x1080, 1280x720) and the crops and HUD sizes the settings allow. It asserts
what the C cannot assert on a build machine:

  * the crop stays inside the picture
  * with fit=filled the result has the target's aspect, within a pixel
  * every source coordinate blit() would read is inside the plane it reads from
  * the number of bytes written is exactly the atlas the app expects
  * the chroma it writes is U in the left half of each row and V in the right
    half, which is what the app's atlas.js and cluster-render's
    pack_nv12_atlas read - and not the interleaved NV12 that MSDK hands out

The last one is the reason this file exists at all: an interleaved atlas is a
valid-looking frame of the right length, so nothing on the unit complains - it
just draws a map in the wrong colours, and the car is the only place to see it.

    python3 test/decode_math_test.py
"""

import sys

MAP_W, MAP_H = 1088, 480
CARD_W, CARD_H = 480, 168
# The biggest a crop.json may ask for (decode.c's MAP_MAX_/CARD_MAX_).
MAP_MAX_W, MAP_MAX_H = 1088, 480
CARD_MAX_W, CARD_MAX_H = 640, 256

# What the HUD layer can be: hudWidth 40..100% of 560, height from the card's
# aspect (168/480), capped by the HUD box's 200 rows.
CARD_SIZES = [(480, 168), (560, 196), (320, 112), (452, 200), (640, 224)]


def even(v, lo=0, hi=1 << 20):
    u = int(v) if v > 0 else 0
    u &= ~1
    if u < lo:
        u = lo & ~1
    if u > hi:
        u = hi & ~1
    return u


class Rect:
    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    def __repr__(self):
        return "Rect(%d,%d %dx%d)" % (self.x, self.y, self.w, self.h)


def rect_of(pw, ph, top, bottom, left, right, dw, dh, keep_aspect):
    """The C function, line for line."""
    x0 = even(pw * left / 100.0)
    x1 = even(pw - pw * right / 100.0)
    y0 = even(ph * top / 100.0)
    y1 = even(ph - ph * bottom / 100.0)
    if x1 <= x0 + 16:
        x1 = x0 + 16
    if y1 <= y0 + 16:
        y1 = y0 + 16
    if x1 > pw:
        x1 = pw
    if y1 > ph:
        y1 = ph
    r = Rect(x0, y0, x1 - x0, y1 - y0)
    if not dw or not dh:
        return r
    if keep_aspect:
        if r.w / r.h > dw / dh:
            nw = even(r.h * dw / dh, 16, pw)
            if nw < r.w:
                r.x += (r.w - nw) // 2
                r.w = nw
        else:
            nh = even(r.w * dh / dw, 16, ph)
            if nh < r.h:
                r.y += (r.h - nh) // 2
                r.h = nh
    r.x &= ~1
    r.y &= ~1
    r.w &= ~1
    r.h &= ~1
    return r


def blit_spans(dw, dh, pitch, pheight, r):
    """Every (plane, row) blit() would touch, and the last column of each: a read
    past the plane is what this is looking for."""
    worst = []
    for y in range(dh):
        syy = r.y + y * r.h // dh
        last = (r.x + r.w - 1) if r.w != dw else (r.x + dw - 1)
        worst.append(("y", syy * pitch + last))
    hh, hw = dh // 2, dw // 2
    rx, ry, rw, rh = r.x // 2, r.y // 2, r.w // 2, r.h // 2
    for y in range(hh):
        syy = ry + y * rh // hh
        last = (rx + rw - 1) if rw != hw else (rx + hw - 1)
        worst.append(("uv", syy * pitch + last * 2 + 1))
    return worst


def blit(dst, dw, dh, sy, spitch, suv, r):
    """The C function, line for line, including the chroma split it must do."""
    for y in range(dh):
        syy = r.y + y * r.h // dh
        base = syy * spitch + r.x
        row = y * dw
        if r.w == dw:
            dst[row:row + dw] = sy[base:base + dw]
        else:
            for x in range(dw):
                dst[row + x] = sy[base + x * r.w // dw]
    half_h, half_w = dh // 2, dw // 2
    duv = dw * dh
    rw, rh = r.w // 2, r.h // 2
    for y in range(half_h):
        syy = r.y // 2 + y * rh // half_h
        base = syy * spitch + (r.x // 2) * 2
        ru = duv + y * dw
        rv = ru + half_w
        for x in range(half_w):
            k = x if rw == half_w else x * rw // half_w
            dst[ru + x] = suv[base + k * 2]          # U
            dst[rv + x] = suv[base + k * 2 + 1]      # V


def main():
    sizes = [(1920, 720), (1920, 1080), (1280, 720), (2360, 1080)]
    crops = [
        (0, 0, 0, 0), (8, 0, 0, 0), (8, 4, 0, 0), (4, 12, 6, 6), (20, 20, 10, 10),
        (0, 16, 0, 24),
    ]
    fits = [True, False]
    targets = [(MAP_W, MAP_H)] + CARD_SIZES
    bad = 0
    cases = 0

    for pw, ph in sizes:
        pitch = (pw + 63) & ~63
        for top, bottom, left, right in crops:
            for keep in fits:
                for (dw, dh) in targets:
                    cases += 1
                    r = rect_of(pw, ph, top, bottom, left, right, dw, dh, keep)

                    # inside the picture
                    if r.x < 0 or r.y < 0 or r.x + r.w > pw or r.y + r.h > ph:
                        print("OUT   %dx%d %s -> %s" % (pw, ph, (top, bottom, left, right), r))
                        bad += 1
                        continue
                    # even, or NV12 chroma is off by one
                    if r.x % 2 or r.y % 2 or r.w % 2 or r.h % 2:
                        print("ODD   %dx%d %s -> %s" % (pw, ph, (top, bottom, left, right), r))
                        bad += 1
                    # the aspect the layer will be drawn at
                    if keep:
                        want, got = dw / dh, r.w / r.h
                        if abs(want - got) > 0.02:
                            print("ASPECT %dx%d %s -> %s  %.3f vs %.3f"
                                  % (pw, ph, (top, bottom, left, right), r, got, want))
                            bad += 1
                    # reads: inside both planes
                    plane_y = pitch * ph
                    limit_y = plane_y
                    limit_uv = plane_y + pitch * (ph // 2)
                    for plane, off in blit_spans(dw, dh, pitch, ph, r):
                        if plane == "y" and off >= limit_y:
                            print("READ-Y %dx%d %s off=%d limit=%d"
                                  % (pw, ph, (top, bottom, left, right), off, limit_y))
                            bad += 1
                            break
                        if plane == "uv" and off >= limit_uv:
                            print("READ-UV %dx%d %s off=%d limit=%d"
                                  % (pw, ph, (top, bottom, left, right), off, limit_uv))
                            bad += 1
                            break

    # ---- the atlas blit() writes: colour, not just length ----
    # A source whose U is 100 everywhere and V is 200 everywhere. Whatever the
    # rectangle, every byte of the atlas' U half must be 100 and every byte of
    # its V half 200: that is the only way to tell a split atlas from an
    # interleaved one without a screen.
    bad += chroma_checks()
    bad += blank_checks()
    bad += header_search_checks()

    # the atlas the app checks a frame's length against
    for (w, h) in targets:
        n = w * h + (w // 2) * (h // 2) * 2
        assert n == w * h * 3 // 2, "atlas size is not w*h*3/2"

    print("%d cases, %d problems" % (cases, bad))
    if bad:
        return 1
    print("geometry ok: crops inside the picture, even, aspect kept, reads in-plane")
    return 0


def picture_ok(uv, pitch, w, h):
    """Mirror of decode.c's picture_ok(): a VPP surface with an entirely empty
    chroma plane is a dropped frame that BT.601 would paint green."""
    live = 0
    for gy in range(8):
        ry = ((gy * h) // 8) & ~1
        for gx in range(16):
            rx = ((gx * w) // 16) & ~1
            base = (ry // 2) * pitch + rx
            if uv[base] > 16 or uv[base + 1] > 16:
                live += 1
    return live != 0


def blank_checks():
    """An all-zero chroma plane (the frame MSDK hands back after a torn NAL,
    or the first one after a session restart) must be rejected; an ordinary
    picture, including a white map and a black night one, must survive. NV12
    neutral chroma is 128 whatever the brightness, so a real frame always has
    samples well above 16."""
    bad = 0
    cases = [(1920, 720), (1920, 1080), (1280, 720), (1088, 480)]
    for (w, h) in cases:
        pitch = (w + 63) & ~63
        rows = h // 2
        size = pitch * rows + 4      # slack for the last interleaved sample

        blank = bytearray(size)      # chroma never written: what paints green
        if picture_ok(blank, pitch, w, h):
            print("BLANK %dx%d: an empty chroma plane was accepted" % (w, h))
            bad += 1

        # a real map: neutral 128 U/V is the common case (grey/white roads)
        neutral = bytearray([128]) * size
        if not picture_ok(neutral, pitch, w, h):
            print("BLANK %dx%d: neutral chroma 128 was rejected" % (w, h))
            bad += 1

        # a night / black picture: luma dark but chroma still neutral
        if not picture_ok(bytearray([129]) * size, pitch, w, h):
            print("BLANK %dx%d: night chroma was rejected" % (w, h))
            bad += 1

        # a fully saturated colour frame must also survive
        colour = bytearray([240]) * size
        if not picture_ok(colour, pitch, w, h):
            print("BLANK %dx%d: saturated chroma was rejected" % (w, h))
            bad += 1
    return bad


def chroma_checks():
    bad = 0
    U, V = 100, 200
    for pw, ph in ((1920, 720), (1280, 720)):
        pitch = (pw + 63) & ~63
        sy = bytearray(b"\x80" * (pitch * ph))
        suv = bytearray(pitch * (ph // 2))
        for i in range(0, len(suv), 2):
            suv[i] = U
            suv[i + 1] = V
        for (dw, dh) in [(MAP_W, MAP_H)] + CARD_SIZES:
            for r in (rect_of(pw, ph, 0, 0, 0, 0, dw, dh, True),
                      rect_of(pw, ph, 8, 16, 0, 24, dw, dh, False)):
                dst = bytearray(dw * dh * 3 // 2)
                blit(dst, dw, dh, sy, pitch, suv, r)
                hw, hh = dw // 2, dh // 2
                for y in range(hh):
                    row = dw * dh + y * dw
                    if any(b != U for b in dst[row:row + hw]):
                        print("CHROMA-U %dx%d %s: U half is not all %d"
                              % (pw, ph, r, U))
                        bad += 1
                        break
                    if any(b != V for b in dst[row + hw:row + dw]):
                        print("CHROMA-V %dx%d %s: V half is not all %d"
                              % (pw, ph, r, V))
                        bad += 1
                        break
                # and nothing outside the atlas
                assert len(dst) == dw * dh * 3 // 2
    return bad


def header_search_checks():
    """What the buffer does while the decoder waits for a sequence header.

    The tap joins CarLife's stream in the middle of a picture, so the first
    bytes are the tail of some NAL and the sequence header may be a long way
    behind. The old rule dropped "everything before the next start code" -
    which, once the buffer is aligned to a start code, is zero bytes, so it
    consumed nothing and the buffer only grew, up to MAX_IN. A header that
    arrives in a packet too big for what is left is then dropped with the rest
    of that packet: 0 frames, no error, and a socket the tap keeps filling.

    The numbers are decode.c's: MAX_IN 8 MB, READ_SZ 256 KB. The stream here is
    deliberately hard - 10 MB of slices before the header, and the header rides
    inside a full-size packet rather than arriving on its own."""
    MAX_IN, READ_SZ = 8 * 1024 * 1024, 256 * 1024
    SLICE = b'\x00\x00\x01\x41' + bytes(60)
    SPS = b'\x00\x00\x01\x67' + bytes(8)
    bad = 0

    def have_sps(b):
        return b.find(b'\x00\x00\x01\x67') >= 0

    def run(new_rule):
        buf, iconsumed, frames, peak = b'', 0, 0, 0
        chunks = [SLICE * 4000 for _ in range(40)] + [SLICE * 3200 + SPS]
        for c in chunks:
            if not new_rule:
                if len(buf) + len(c) > MAX_IN:
                    if iconsumed:
                        buf = buf[iconsumed:]
                        iconsumed = 0
                    if len(buf) + len(c) > MAX_IN:
                        continue            # the read never happens: full buffer
            buf += c
            if not have_sps(buf[iconsumed:]):
                if new_rule:
                    keep = min(3, len(buf) - iconsumed)
                    buf = buf[len(buf) - keep:]
                    iconsumed = 0
                else:
                    i = buf.find(b'\x00\x00\x01', iconsumed)
                    buf = buf[i:] if i >= 0 else b''
                    iconsumed = 0
                peak = max(peak, len(buf))
            else:
                frames += 1
            if new_rule and len(buf) > MAX_IN:
                return frames, len(buf), peak, "buffer grew past MAX_IN"
        return frames, len(buf), peak, ""

    got, size, peak, why = run(True)
    if got < 1:
        print("HEADER new rule: no sequence header found (%d frames, %d B)" % (got, size))
        bad += 1
    if why:
        print("HEADER " + why)
        bad += 1
    if peak > 1024:
        print("HEADER new rule held %d bytes while waiting: waiting is not consuming" % peak)
        bad += 1
    old, _, opeak, _ = run(False)
    if old >= got:
        print("HEADER the old rule was not the bug? old=%d new=%d" % (old, got))
        bad += 1
    return bad


def sps_wedge_checks():
    """The 0.4.8 regression: SPS present but fed from mid-picture.

    The car reported "0 frames, 0 fps - no sequence header in 4197587 bytes"
    while the tap had sent 226 MB and dropped 121918 chunks. Both ends were
    stuck on the same buffer: find_sps said there *was* an SPS somewhere in
    the four megabytes, so the no-SPS rule never ran; DecodeHeader was handed
    the buffer from its mid-picture start and answered MORE_DATA; MORE_DATA
    consumed nothing; once the buffer was full the read stopped; and the tap
    could no longer write. Repeat for ever with a growing drop count.

    The fix has two parts, both checked here: the SPS is aligned to byte 0
    before DecodeHeader sees it, and every MORE_DATA consumes bytes so new
    input can arrive. A stream whose SPS+PPS is split by a tap drop must also
    get there in the end rather than wedging on the first one.
    """
    MAX_IN, READ_SZ = 8 * 1024 * 1024, 256 * 1024
    bad = 0

    def find_sps(b):
        """decode.c's find_sps: offset of the first SPS, or len(b)."""
        for i in range(len(b) - 3):
            if b[i] == 0 and b[i + 1] == 0 and b[i + 2] == 1 and (b[i + 3] & 0x1f) == 7:
                return i
        return len(b)

    def run(chunks, fixed):
        """Model the header phase of decode.c's poll loop.

        `fixed` switches the two rules:
          old: feed the whole buffer from its mid-picture start; 'more'
               consumes nothing; compaction only when consumed > 0
          new: align to the SPS first; 'more' advances to the next start
               code; the read loop always makes room
        Returns (headers found, chunks read, bytes held at the end).
        """
        buf, consumed, frames, reads = b'', 0, 0, 0
        for c in chunks:
            if len(buf) + READ_SZ > MAX_IN:
                if consumed:
                    buf = buf[consumed:]
                    consumed = 0
                elif fixed:
                    # the read loop now drops the oldest bytes to make room
                    buf = buf[len(buf) + READ_SZ - MAX_IN:]
                else:
                    continue                    # old: no read, for ever
            if len(buf) + READ_SZ > MAX_IN:
                continue
            buf += c
            reads += 1
            avail = len(buf) - consumed
            if avail <= 4:
                continue
            sps = find_sps(buf[consumed:])
            if sps == avail:
                keep = min(3, avail)
                buf = buf[len(buf) - keep:]
                consumed = 0
                continue
            if fixed:
                consumed += sps                  # byte 0 is the SPS
                avail -= sps
            # MFX only accepts a bitstream that starts at an SPS and has its
            # PPS: that is the whole reason alignment matters here.
            ok = (buf[consumed:consumed + 4] == b'\x00\x00\x01\x67' and
                  buf[consumed:].find(b'\x00\x00\x01\x68') >= 0)
            if ok:
                frames += 1
            elif fixed:
                skip = 4
                while skip + 3 < avail and not (
                        buf[consumed + skip] == 0 and buf[consumed + skip + 1] == 0
                        and buf[consumed + skip + 2] == 1):
                    skip += 1
                consumed += min(skip, avail)     # 'more' still makes progress
        return frames, reads, len(buf)

    SPS = b'\x00\x00\x01\x67' + bytes(8)
    PPS = b'\x00\x00\x01\x68' + bytes(4)
    JUNK = b'\x00\x00\x01\x41' + bytes(64)
    chunks = [JUNK * 2000 for _ in range(20)] + [JUNK * 1000 + SPS + PPS]

    old_frames, old_reads, old_buf = run(chunks, False)
    new_frames, new_reads, new_buf = run(chunks, True)

    if old_frames >= 1:
        print("SPS wedge: old rule found a header from a mid-picture start")
        bad += 1
    if new_frames < 1:
        print("SPS wedge: fixed rule found no header (%d frames, %d B)" %
              (new_frames, new_buf))
        bad += 1
    if new_reads < 21:
        print("SPS wedge: fixed rule stopped reading after %d chunks" % new_reads)
        bad += 1

    # A split SPS+PPS must be skipped, with a later complete pair used.
    split = [JUNK * 100 + SPS] + [JUNK * 500] + [JUNK * 100 + SPS + PPS] * 4
    split_frames, split_reads, split_buf = run(split, True)
    if split_frames < 1:
        print("SPS wedge: a split SPS+PPS wedged the stream (%d reads)" % split_reads)
        bad += 1
    return bad


if __name__ == "__main__":
    sys.exit(main() + sps_wedge_checks())

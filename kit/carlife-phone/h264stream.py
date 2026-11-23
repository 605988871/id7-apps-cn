"""Annex-B helpers for the fake phone: make a stream, split it, prove it survives.

Why this exists: the unit's video channel does not take "a blob of H.264". The
unit's own traffic showed one message per NAL, each beginning with a 4-byte
start code, and several of those messages sharing one timestamp (the NALs of a
single picture). So a stand-in has to cut the stream the same way, or the
decoder is handed a run of pictures in one message and shows the first and
nothing else.

Two things here were read off the unit rather than assumed:

    outer  [chan][len]            USB channel header, 8 bytes, separate transfer
    inner  [len][ts][0x00020001]  video header, len = payload only
    body   Annex-B NAL            starts 00 00 00 01

and `ts` is Unix seconds, not milliseconds: the unit's traffic carried
1795395829, which is 2026-11-23. A monotonic millisecond clock cannot be that
number, and the values step by 1 across a second of video, which settles it.
"""

import os
import shutil
import struct
import subprocess
import sys

# NAL unit types (ITU-T H.264 table 7-1, the ones that matter here).
NAL_SLICE = 1
NAL_SLICE_IDR = 5
NAL_SEI = 6
NAL_SPS = 7
NAL_PPS = 8
NAL_AUD = 9

TYPE_NAME = {
    1: "slice", 2: "slice-b", 3: "slice-c", 4: "slice-d", 5: "idr",
    6: "sei", 7: "sps", 8: "pps", 9: "aud", 10: "end-seq", 11: "end-stream",
    12: "filler", 13: "sps-ext", 15: "subset-sps",
}


def find_ffmpeg():
    """PATH first, then the copy imageio-ffmpeg leaves in site-packages.

    The Windows machine this was written on has no ffmpeg on PATH; having the
    module look for the one bundled with a Python package avoids telling the
    user to install something they already have.
    """
    env = os.environ.get("FFMPEG")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    return None


def make_test_stream(path, width=1920, height=720, fps=30, seconds=10,
                     bitrate="1800k", text=True):
    """A stream whose every frame is identifiable, at the unit's own geometry.

    A big frame counter plus a bar that sweeps once a second: if the counter
    jumps, frames are being dropped; if the bar stutters, the pacing is wrong;
    if the screen is black, none of this reached the decoder. testsrc2 was the
    obvious pick but it is noisy enough to cost 4.6 Mbps where the unit's real
    stream sits near 1.5, and the extra load would be blamed on the bridge.
    """
    exe = find_ffmpeg()
    if not exe:
        raise RuntimeError(
            "ffmpeg not found: put it on PATH, install imageio-ffmpeg, or set FFMPEG")
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)

    chain = []
    if text:
        font = "C\\:/Windows/Fonts/consola.ttf"
        chain.append(
            "drawtext=fontfile='%s':text='%%{n}':fontsize=%d:fontcolor=0x34d1ff"
            ":x=(w-text_w)/2:y=(h-text_h)/2" % (font, max(60, height // 2)))
    # mod(t*W, w-box) sweeps once per (w-box)/W seconds; 1720/500 = 1.72 s.
    chain.append("drawbox=x='mod(t*500\\,%d)':y=%d:w=%d:h=%d"
                 ":color=0xffffff@0.85:t=fill"
                 % (max(1, width - 200), int(height * 0.88),
                    max(40, width // 10), max(20, height // 18)))

    cmd = [
        exe, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=0x0d1b2a:s=%dx%d:r=%d" % (width, height, fps),
        "-t", str(seconds),
        "-vf", ",".join(chain),
        "-c:v", "libx264",
        # baseline: no B-frames, no CABAC - the profile a car head unit's
        # decoder is least likely to refuse.
        "-profile:v", "baseline", "-pix_fmt", "yuv420p",
        "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", "3000k",
        # aud=1 gives every access unit a delimiter, which makes the split
        # below exact instead of heuristic. repeat-headers puts SPS/PPS in
        # front of every IDR, so a decoder that joins mid-stream still works.
        "-x264-params", "aud=1:repeat-headers=1:keyint=%d:min-keyint=%d:scenecut=0"
                        % (fps, fps),
        "-an", "-f", "h264", path,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError("ffmpeg failed: %s" % result.stderr.decode("utf-8", "replace").strip())
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise RuntimeError("ffmpeg produced nothing at %s" % path)
    return path


def split_nals(data):
    """Cut an Annex-B byte string into NAL units, keeping their start codes.

    Both 3- and 4-byte start codes occur in the wild; a decoder accepts either,
    so they are preserved rather than normalised.
    """
    marks = []
    i = 0
    n = len(data)
    while i + 2 < n:
        if data[i] == 0 and data[i + 1] == 0:
            if data[i + 2] == 1:
                marks.append((i, 3))
                i += 3
                continue
            if i + 3 < n and data[i + 2] == 0 and data[i + 3] == 1:
                marks.append((i, 4))
                i += 4
                continue
        i += 1
    if not marks:
        return []
    out = []
    for k, (start, width) in enumerate(marks):
        end = marks[k + 1][0] if k + 1 < len(marks) else n
        if end - start > width:
            out.append(data[start:end])
    return out


def nal_type(nal):
    """Type byte, skipping whatever length start code sits in front."""
    if nal.startswith(b"\x00\x00\x01"):
        head = 3
    elif nal.startswith(b"\x00\x00\x00\x01"):
        head = 4
    else:
        head = 0
    if len(nal) <= head:
        return -1
    return nal[head] & 0x1F


def nal_body(nal):
    return nal[4:] if nal.startswith(b"\x00\x00\x00\x01") else (
        nal[3:] if nal.startswith(b"\x00\x00\x01") else nal)


def group_access_units(nals):
    """Group NALs into pictures, one picture per send interval.

    Primary rule is the access unit delimiter. The fallback (streams without
    AUD, e.g. something recorded elsewhere) starts a new picture on a second
    slice, or on parameter sets that follow a slice - the same boundaries the
    spec defines, minus the first_mb_in_slice test.
    """
    units = []
    current = []
    has_slice = False
    for nal in nals:
        kind = nal_type(nal)
        starts_new = False
        if kind == NAL_AUD:
            starts_new = True
        elif kind in (NAL_SLICE, NAL_SLICE_IDR):
            starts_new = has_slice
        elif kind in (NAL_SPS, NAL_PPS, NAL_SEI) and has_slice:
            starts_new = True
        if starts_new and current:
            units.append(current)
            current = []
            has_slice = False
        current.append(nal)
        if kind in (NAL_SLICE, NAL_SLICE_IDR):
            has_slice = True
    if current:
        units.append(current)
    return units


class _Bits:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def bit(self):
        byte = self.data[self.pos >> 3]
        value = (byte >> (7 - (self.pos & 7))) & 1
        self.pos += 1
        return value

    def bits(self, count):
        value = 0
        for _ in range(count):
            value = (value << 1) | self.bit()
        return value

    def ue(self):
        zeros = 0
        while self.pos < len(self.data) * 8 and self.bit() == 0:
            zeros += 1
            if zeros > 32:
                raise ValueError("bad exp-golomb")
        return (1 << zeros) - 1 + self.bits(zeros) if zeros else 0

    def se(self):
        value = self.ue()
        return (value + 1) // 2 if value & 1 else -(value // 2)


def sps_geometry(nal):
    """(width, height, profile) from an SPS, or None if it will not parse.

    Worth the bit-twiddling: if the stream geometry does not match the
    1920x720@30 the unit asked for in VIDEO_ENCODER_INIT, the decoder has
    nothing sensible to do and the symptom is a black screen with no error
    anywhere - the exact failure this check is meant to rule out before a
    trip to the car.
    """
    body = nal_body(nal)
    if len(body) < 4 or (body[0] & 0x1F) != NAL_SPS:
        return None
    # body[0] is the NAL header byte, then profile_idc, the constraint flags and
    # level_idc - the RBSP starts at body[4]. Off by one here reads the level as
    # a parameter-set id and every dimension after it comes out wrong.
    profile = body[1]
    bits = _Bits(body[4:])
    try:
        bits.ue()                                    # seq_parameter_set_id
        if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            chroma = bits.ue()
            if chroma == 3:
                bits.bit()
            bits.ue()                                # bit_depth_luma_minus8
            bits.ue()                                # bit_depth_chroma_minus8
            bits.bit()                               # qpprime_y_zero_transform_bypass
            if bits.bit():                           # seq_scaling_matrix_present
                for i in range(8 if chroma != 3 else 12):
                    if bits.bit():
                        size = 16 if i < 6 else 64
                        last = nxt = 8
                        for _ in range(size):
                            if nxt:
                                nxt = (last + bits.se() + 256) % 256
                            last = nxt if nxt else last
        bits.ue()                                    # log2_max_frame_num_minus4
        poc = bits.ue()
        if poc == 0:
            bits.ue()                                # log2_max_pic_order_cnt_lsb_minus4
        elif poc == 1:
            bits.bit()
            bits.se()
            bits.se()
            for _ in range(bits.ue()):
                bits.se()
        bits.ue()                                    # max_num_ref_frames
        bits.bit()                                   # gaps_in_frame_num_allowed
        width_mbs = bits.ue() + 1
        height_units = bits.ue() + 1
        frame_mbs_only = bits.bit()
        height = height_units * 16 * (2 - frame_mbs_only)
        return width_mbs * 16, height, profile
    except (IndexError, ValueError):
        return None


def describe(data):
    """Everything the caller might want to sanity-check, as plain values."""
    nals = split_nals(data)
    units = group_access_units(nals)
    kinds = [nal_type(n) for n in nals]
    geometry = None
    for nal in nals:
        if nal_type(nal) == NAL_SPS:
            geometry = sps_geometry(nal)
            if geometry:
                break
    return {
        "nals": nals,
        "units": units,
        "bytes": len(data),
        "keyframes": kinds.count(NAL_SLICE_IDR),
        "has_aud": kinds.count(NAL_AUD),
        "has_pps": kinds.count(NAL_PPS),
        "geometry": geometry,
        "kinds": kinds,
    }


def decode_check(path):
    """Decode the file back with ffmpeg and report frames it actually produced.

    Proves the stream is intact before it is blamed on the bridge.
    """
    exe = find_ffmpeg()
    if not exe:
        return None
    probe = subprocess.run(
        [exe, "-hide_banner", "-i", path, "-f", "null", "-"],
        capture_output=True)
    text = probe.stderr.decode("utf-8", "replace")
    frames = None
    for line in text.splitlines():
        if "frame=" in line:
            part = line.split("frame=")[1].split()[0].strip()
            if part.isdigit():
                frames = int(part)
    return probe.returncode == 0, frames


def main(argv):
    if len(argv) < 2:
        print("usage: python h264stream.py make <out.h264> [--seconds N] [--size WxH] [--fps N]\n"
              "       python h264stream.py check <file.h264>\n"
              "       python h264stream.py selftest")
        return 2

    where = argv[1]
    if where == "make":
        if len(argv) < 3:
            print("make needs an output path")
            return 2
        out = argv[2]
        seconds, width, height, fps = 10, 1920, 720, 30
        rest = argv[3:]
        for i in range(0, len(rest) - 1, 2):
            key, value = rest[i], rest[i + 1]
            if key == "--seconds":
                seconds = int(value)
            elif key == "--fps":
                fps = int(value)
            elif key == "--size":
                width, height = (int(x) for x in value.lower().split("x"))
        make_test_stream(out, width, height, fps, seconds)
        info = describe(open(out, "rb").read())
        print("%s: %.1f KiB, %d NALs, %d pictures, %d keyframes, geometry %s"
              % (out, info["bytes"] / 1024.0, len(info["nals"]), len(info["units"]),
                 info["keyframes"], info["geometry"]))
        return 0

    if where == "check":
        if len(argv) < 3:
            print("check needs a file")
            return 2
        data = open(argv[2], "rb").read()
        info = describe(data)
        print("%d bytes, %d NALs, %d pictures, %d keyframes, %d AUD, geometry %s"
              % (info["bytes"], len(info["nals"]), len(info["units"]),
                 info["keyframes"], info["has_aud"], info["geometry"]))
        first = info["units"][0] if info["units"] else []
        print("first picture: %s"
              % " ".join(TYPE_NAME.get(nal_type(n), str(nal_type(n))) for n in first))
        result = decode_check(argv[2])
        if result:
            print("decodes back: %s, %s frames" % ("ok" if result[0] else "FAILED", result[1]))
        return 0

    if where == "selftest":
        return selftest()

    print("unknown command %r" % where)
    return 2


def selftest():
    """Splitter cases, no ffmpeg needed - the byte patterns are hand-written."""
    ok = True

    def check(name, condition):
        nonlocal ok
        print("%-54s %s" % (name, "ok" if condition else "FAIL"))
        ok = ok and condition

    def nal(kind, payload=b"\xaa" * 8, short=False):
        # NAL header: forbidden_zero | nal_ref_idc (2 bits) | type (5 bits), so
        # the type lives in the low five bits. Shifting the type up by 5 writes
        # a type of zero and every case below would pass for the wrong reason.
        header = bytes([0x60 | (kind & 0x1F)])
        return (b"\x00\x00\x01" if short else b"\x00\x00\x00\x01") + header + payload

    # 1. Plain split, both start code widths.
    blob = nal(NAL_AUD) + nal(NAL_SPS) + nal(NAL_PPS) + nal(NAL_SLICE_IDR) + nal(NAL_SLICE, short=True)
    parts = split_nals(blob)
    check("1 five NALs found", len(parts) == 5)
    check("1 types in order", [nal_type(p) for p in parts] == [9, 7, 8, 5, 1])
    check("1 short start code kept", parts[4].startswith(b"\x00\x00\x01"))
    check("1 nothing lost", b"".join(parts) == blob)

    # 2. One picture = AUD + SPS + PPS + IDR, then a slice-only picture.
    units = group_access_units(parts)
    check("2 two pictures", len(units) == 2)
    check("2 first picture is 4 NALs", len(units[0]) == 4)
    check("2 second picture is the lone slice", len(units[1]) == 1)

    # 3. Without AUD, a second slice still starts a new picture.
    no_aud = split_nals(nal(NAL_SPS) + nal(NAL_PPS) + nal(NAL_SLICE_IDR)
                        + nal(NAL_SLICE) + nal(NAL_SLICE))
    check("3 falls back to slice boundaries",
          [len(u) for u in group_access_units(no_aud)] == [3, 1, 1])

    # 4. Parameter sets arriving after a slice belong to the next picture.
    trailing = split_nals(nal(NAL_SLICE) + nal(NAL_SPS) + nal(NAL_PPS) + nal(NAL_SLICE))
    check("4 parameter sets open a new picture",
          [len(u) for u in group_access_units(trailing)] == [1, 3])

    # 5. Garbage before the first start code is not a NAL.
    check("5 leading junk dropped", split_nals(b"\xff\xff" + nal(NAL_AUD)).__len__() == 1)

    # 6. No start code at all -> nothing, not one bogus NAL.
    check("6 empty on no start code", split_nals(b"\x00\x00\x09\x11" * 4) == [])

    # 7. A start code split across the 0x000001/0x00000001 boundary must not
    #    be counted twice: 00 00 00 01 has to be one 4-byte code, not 0+3.
    check("7 four-byte code counted once",
          split_nals(b"\x00\x00\x00\x01\x09\xf0") == [b"\x00\x00\x00\x01\x09\xf0"])

    # 8. A real SPS from the generated 1920x720 stream, if one is around.
    import glob
    candidates = glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "*.h264"))
    candidates += glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "*.h264"))
    if candidates:
        data = open(candidates[0], "rb").read()
        info = describe(data)
        check("8 sample stream has pictures", len(info["units"]) > 1)
        check("8 sample is 1920x720", info["geometry"][:2] == (1920, 720))
        check("8 every picture starts with a delimiter",
              all(nal_type(u[0]) == NAL_AUD for u in info["units"]))
    else:
        print("%-54s %s" % ("8 (no sample .h264 to inspect)", "skip"))

    print("\n%s" % ("all splitter cases pass" if ok else "SOMETHING FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

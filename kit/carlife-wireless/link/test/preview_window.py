"""Live CarLife screen on a laptop: the phone streams, this window shows the
picture and sends touches back.  A stand-in for the head unit while the real
one is still being built.

    python test/preview_window.py --host 10.96.1.245

The chain is deliberate:

    carlife-link run --video -   ->  H.264 on stdout
    ffmpeg -i pipe:0 ... rawvideo    ->  BGRA frames on stdout
    this window                      ->  QImage per frame, drawn by OpenGL

and every mouse press turns into a touch frame in the 0..10000 space the
protocol expects, so what you feel here is what the unit will feel.

Three things here are load-bearing, each one learned the hard way:

* **Only the newest frame is drawn.**  A signal per frame looks tidier but
  queues every frame into the GUI thread; the queue then outruns the drawing
  and the window shows pictures from minutes ago, which reads exactly like the
  phone being stuck on its launch page.

* **No -fflags nobuffer.**  On a pipe it makes the demuxer give up after a
  couple of frames, which again looks like a frozen phone.  -flags low_delay
  is what actually keeps the delay down.

* **The picture is scaled by the GPU, not by ffmpeg and not by QLabel.**
  ffmpeg is told to hand over the native 1920x1080 untouched, and the widget
  is a QOpenGLWidget so the scale happens in the texture unit.  A plain
  QLabel draws into a raster surface: with Windows at 200% the pixmap was
  smoothed up to 2560x1440 on the CPU every frame, which capped the window at
  19 fps on a machine whose decoder happily runs at 28x real time.
"""
import argparse
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

from PyQt5 import QtCore, QtGui, QtWidgets

HERE = os.path.dirname(os.path.abspath(__file__))
LINK = os.path.normpath(os.path.join(HERE, "..", "link.exe"))

BPP = 4                       # bgra, which is what QImage.Format_RGB32 wants


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


class Reader(threading.Thread):
    """Reads whole frames out of ffmpeg and keeps only the newest one.

    BufferedReader.read(n) blocks until it has n bytes, so one call is one
    frame and there is no reassembly buffer to copy through.  The bytes object
    handed to the GUI is refcounted, so the image can be built over it with no
    copy at all.
    """

    def __init__(self, proc, w, h):
        super().__init__(daemon=True)
        self.proc = proc
        self.w = w
        self.h = h
        self.alive = True
        self.lock = threading.Lock()
        self.latest = None
        self.seq = 0
        self.seen = 0
        self.ended_at = None

    def run(self):
        need = self.w * self.h * BPP
        out = self.proc.stdout
        while self.alive:
            try:
                data = out.read(need)
            except (OSError, ValueError):
                break
            if not data or len(data) < need:
                break
            with self.lock:
                self.latest = data
                self.seq += 1
                self.seen += 1
        self.ended_at = True

    def take(self):
        with self.lock:
            frame, seq = self.latest, self.seq
            self.latest = None
            return frame, seq


class Screen(QtWidgets.QOpenGLWidget):
    """The picture plus the touch surface.  The cursor stays visible: a hidden
    pointer makes a drag feel like it is happening somewhere else."""

    def __init__(self, ctl_port, w, h):
        super().__init__()
        self.ctl_port = ctl_port
        self.frame_w = w
        self.frame_h = h
        self.raw = None
        self.pressed = False
        self.ended = False
        self.paint_ms = 0.0
        self.status = ""
        self.setMinimumSize(480, 270)
        self.resize(1280, 720)
        self.setCursor(QtCore.Qt.ArrowCursor)
        self.setMouseTracking(True)
        self.setAttribute(QtCore.Qt.WA_OpaquePaintEvent)
        self.setFont(QtGui.QFont("Microsoft YaHei UI", 12))

    def ctl(self, line):
        try:
            s = socket.create_connection(("127.0.0.1", self.ctl_port), timeout=0.5)
            s.sendall((line + "\n").encode())
            s.close()
        except OSError:
            pass

    def pct(self, pos):
        x = max(0, min(10000, int(pos.x() / max(1, self.width()) * 10000)))
        y = max(0, min(10000, int(pos.y() / max(1, self.height()) * 10000)))
        return x, y

    def mousePressEvent(self, e):
        if e.button() == QtCore.Qt.LeftButton:
            self.pressed = True
            x, y = self.pct(e.pos())
            self.ctl("down %d %d" % (x, y))

    def mouseMoveEvent(self, e):
        if self.pressed:
            x, y = self.pct(e.pos())
            self.ctl("move %d %d" % (x, y))

    def mouseReleaseEvent(self, e):
        if self.pressed and e.button() == QtCore.Qt.LeftButton:
            self.pressed = False
            x, y = self.pct(e.pos())
            self.ctl("up %d %d" % (x, y))

    def set_frame(self, raw, w, h):
        self.raw = raw
        self.frame_w = w
        self.frame_h = h
        self.ended = False
        self.update()

    def paintGL(self):
        t0 = time.perf_counter()
        p = QtGui.QPainter(self)
        p.fillRect(self.rect(), QtCore.Qt.black)
        if self.raw is not None:
            # built over the bytes the reader handed us: no copy, and Qt draws
            # from it synchronously inside this call, so the pointer is valid
            img = QtGui.QImage(self.raw, self.frame_w, self.frame_h,
                               self.frame_w * BPP, QtGui.QImage.Format_RGB32)
            # the aspect ratio is already the phone's, so filling the widget is
            # what "no letterboxing" means here; the GPU filters the scale
            p.drawImage(self.rect(), img)
        else:
            p.setPen(QtGui.QColor("#8a8a8a"))
            line = self.status or ("stream ended" if self.ended
                                   else "waiting for the picture…")
            p.drawText(self.rect(), QtCore.Qt.AlignCenter, line)
        p.end()
        self.paint_ms = (time.perf_counter() - t0) * 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", help="the phone's address")
    ap.add_argument("--ctl", type=int, default=17399)
    ap.add_argument("--width", type=int, default=1280,
                    help="window width at start; the picture scales to it on the GPU")
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--scale", metavar="WxH",
                    help="let ffmpeg downscale to this size instead of handing over "
                         "the native frame - costs CPU, only useful on a weak machine")
    ap.add_argument("--on-top", action="store_true",
                    help="keep the window above everything else, so it does not "
                         "hide behind the editor while you are testing")
    ap.add_argument("--fps", type=int, default=60,
                    help="frame rate to ask the phone for (default 60). The phone "
                         "ignores the size but honours this, and a still picture "
                         "is few frames whatever is asked: only motion shows it")
    ap.add_argument("--seconds", type=int, default=3600)
    ap.add_argument("--replay", metavar="FILE",
                    help="play a captured .h264 instead of connecting, to check the "
                         "window and the decoder with no phone in the loop")
    args = ap.parse_args()
    if not args.replay and not args.host:
        ap.error("--host is required unless --replay is used")
    name = args.host or os.path.basename(args.replay)

    QtWidgets.QApplication.setAttribute(QtCore.Qt.AA_EnableHighDpiScaling, True)
    app = QtWidgets.QApplication(sys.argv)

    log_path = os.path.join(tempfile.gettempdir(), "carlife-preview.log")
    log = open(log_path, "w", encoding="utf-8", errors="replace")
    report_path = os.path.join(tempfile.gettempdir(), "carlife-preview-report.txt")

    link = None
    capture = None
    if args.replay:
        capture = open(args.replay, "rb")
        source = capture
    else:
        link = subprocess.Popen(
            [LINK, "run", "--host", args.host, "--video", "-",
             "--ctl", str(args.ctl), "--seconds", str(args.seconds),
             "--width", "1920", "--height", "1080", "--fps", str(args.fps),
             "--report", report_path],
            stdout=subprocess.PIPE, stderr=log)
        source = link.stdout

    ff_cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
              "-flags", "low_delay",
              "-probesize", "200000", "-analyzeduration", "0",
              "-threads", "0"]                    # all cores, frame-parallel
    if args.replay:
        ff_cmd += ["-re"]           # a capture played back at stream speed
    ff_cmd += ["-i", "pipe:0"]
    frame_w, frame_h = 1920, 1080
    if args.scale:
        sw, sh = args.scale.lower().split("x")
        frame_w, frame_h = int(sw), int(sh)
        ff_cmd += ["-vf", "scale=%d:%d:flags=bilinear" % (frame_w, frame_h)]
    ff_cmd += ["-f", "rawvideo", "-pix_fmt", "bgra", "-y", "pipe:1"]

    ff = subprocess.Popen(ff_cmd, stdin=source,
                          stdout=subprocess.PIPE, stderr=log)
    if link is not None:
        link.stdout.close()          # the pipe belongs to ffmpeg now

    win = QtWidgets.QWidget()
    win.setWindowTitle("CarLife — %s" % name)
    win.setStyleSheet("background:#111;")
    if args.on_top:
        win.setWindowFlag(QtCore.Qt.WindowStaysOnTopHint, True)
    layout = QtWidgets.QVBoxLayout(win)
    layout.setContentsMargins(0, 0, 0, 0)
    screen = Screen(args.ctl, frame_w, frame_h)
    layout.addWidget(screen)
    win.resize(args.width, args.height)
    win.show()

    def dump_gl():
        """Written once, so a slow window can be blamed on the right thing: if
        this says llvmpipe or GDI, the scale is on the CPU whatever the widget.
        PyQt5 exposes no glGetString, so the DLL is asked directly."""
        fmt = screen.context().format()
        head = "gl format  : %d.%d %s %s\n" % (
            fmt.majorVersion(), fmt.minorVersion(),
            "ES" if fmt.renderableType() == QtGui.QSurfaceFormat.OpenGLES else "GL",
            fmt.profile())
        try:
            import ctypes
            gl = ctypes.WinDLL("opengl32")
            gl.glGetString.restype = ctypes.c_char_p
            screen.makeCurrent()
            names = {0x1F00: "gl vendor  ", 0x1F01: "gl renderer",
                     0x1F02: "gl version "}
            for code, label in names.items():
                raw = gl.glGetString(code)
                head += "%s: %s\n" % (label, raw.decode("utf-8", "replace") if raw else "?")
        except Exception as exc:
            head += "gl query failed: %r\n" % (exc,)
        log.write(head)
        log.flush()

    QtCore.QTimer.singleShot(300, dump_gl)

    def state_hint(state):
        """The tool's internal state, said in the terms the person watching the
        window can act on."""
        s = state or ""
        if s.startswith("handshake"):
            return ("手机没有回应\n\n"
                    "点亮手机，把 CarLife+ 切到前台，别锁屏\n"
                    "（车机侧每 3 秒重试一次，手机会自己接上）")
        if s.startswith("asked"):
            return ("已经握手，正在请求画面参数\n\n%s" % s)
        if s.startswith("waiting"):
            return "已握手，等手机开始推画面"
        if s.startswith("streaming"):
            return "正在接收画面"
        return s

    def link_report():
        """The tool's own view of the session, so the window can say where it
        stopped instead of showing a blank frame with no explanation."""
        d = {}
        try:
            with open(report_path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if ":" in line:
                        k, v = line.split(":", 1)
                        d[k.strip()] = v.strip()
        except OSError:
            pass
        return d

    reader = Reader(ff, frame_w, frame_h)
    reader.start()

    state = {"seq": 0, "shown": 0, "t": 0.0, "sent": 0}

    def tick():
        frame, seq = reader.take()
        if frame is not None:
            screen.set_frame(frame, frame_w, frame_h)
            state["seq"] = seq
            state["shown"] += 1
        elif reader.ended_at and not screen.ended:
            screen.ended = True
            screen.raw = None
            screen.update()

        now = QtCore.QDateTime.currentMSecsSinceEpoch() / 1000.0
        if state["t"] == 0.0:
            state["t"] = now
            state["shown"] = 0
        elif now - state["t"] >= 1.0:
            span = now - state["t"]
            fps = state["shown"] / span
            note = ""
            rep = link_report() if link is not None else {}
            video = rep.get("video", "")
            sent = dropped = 0
            for part in video.split():
                if part.startswith("frames="):
                    sent = int(part[7:] or 0)
                elif part.startswith("dropped="):
                    dropped = int(part[8:] or 0)
            if video:
                got = sent - state["sent"]
                state["sent"] = sent
                note = " · in %.0f · drop %d" % (got / span, dropped)
            if screen.raw is None and rep.get("state"):
                hint = state_hint(rep["state"])
                if screen.status != hint:
                    screen.status = hint
                    screen.update()
            win.setWindowTitle("CarLife — %s · %.0f fps · draw %.0f ms%s"
                               % (name, fps, screen.paint_ms, note))
            state["t"] = now
            state["shown"] = 0

    timer = QtCore.QTimer()
    timer.timeout.connect(tick)
    timer.start(8)

    def shutdown():
        reader.alive = False
        for p in (ff, link):
            if p is None:
                continue
            try:
                p.terminate()
            except Exception:
                pass
        if capture is not None:
            try:
                capture.close()
            except Exception:
                pass
        log.close()

    app.aboutToQuit.connect(shutdown)
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()

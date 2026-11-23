"""Watch the phone for the moment its CarLife starts listening.

Android drops SYNs to unopened ports, so a silent reply means "not listening"
rather than "unreachable".  Once 7240 opens we do a full sweep and stop.
"""
import socket
import sys
import time

PORTS = [7240, 8240, 9240, 9241, 9242, 9340]


def probe(host, port, timeout=1.5):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return "OPEN"
    except socket.timeout:
        return "TIMEOUT"
    except ConnectionRefusedError:
        return "REFUSED"
    except OSError as e:
        return "ERR %s" % e
    finally:
        s.close()


def main():
    host = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 240.0
    end = time.time() + seconds
    seen_refused = False
    while time.time() < end:
        r = probe(host, 7240)
        stamp = time.strftime("%H:%M:%S")
        if r == "OPEN":
            print("%s 7240 OPEN - the phone is listening" % stamp, flush=True)
            for p in PORTS[1:]:
                print("%s %5d %s" % (stamp, p, probe(host, p)), flush=True)
            print("PHONE_READY", flush=True)
            return 0
        if r == "REFUSED" and not seen_refused:
            print("%s 7240 REFUSED - stack is awake, CarLife still not listening" % stamp, flush=True)
            seen_refused = True
        time.sleep(1.0)
    print("WATCH_TIMEOUT - nothing opened within %.0f s" % seconds, flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())

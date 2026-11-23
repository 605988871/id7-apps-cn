"""Locate the phone's hotspot and probe the CarLife ports on it.

Run after the laptop has joined the phone's hotspot: it reads every IPv4
default gateway (the phone *is* the gateway when it serves the hotspot) and
tries the CarLife base ports on each.  Prints which one answers.
"""
import re
import subprocess
import sys

PORTS = [7240, 8240, 9240, 9241, 9242, 9340]


def powershell(cmd):
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", cmd],
        capture_output=True,
    )
    return out.stdout.decode("utf-8", "replace") + out.stderr.decode("utf-8", "replace")


def gateways():
    """Every IPv4 gateway plus the interface address that owns it."""
    txt = powershell(
        "Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway} | "
        "ForEach-Object { $_.IPv4Address.IPAddress + ' ' + $_.IPv4DefaultGateway.NextHop }"
    )
    pairs = []
    for line in txt.splitlines():
        line = line.strip()
        m = re.match(r"^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)$", line)
        if m:
            pairs.append((m.group(1), m.group(2)))
    return pairs


def reachable(ip, port, ms=2000):
    """True/False for open, None for silent."""
    txt = powershell(
        "$c=New-Object System.Net.Sockets.TcpClient;"
        "$t=$c.BeginConnect('%s',%d,$null,$null);"
        "if(-not $t.AsyncWaitHandle.WaitOne(%d,$false)){'TIMEOUT'}"
        "else{try{$c.EndConnect($t);'OPEN'}catch{'REFUSED'}};"
        "$c.Close()" % (ip, port, ms)
    )
    if "OPEN" in txt:
        return True
    if "REFUSED" in txt:
        return False
    return None


def main():
    gw = gateways()
    if not gw:
        print("no IPv4 gateway found - is the laptop on any network?")
        return 2
    print("interfaces with a gateway:")
    for own, g in gw:
        print("  %-16s -> gateway %s" % (own, g))

    winners = []
    for own, g in gw:
        hits = []
        for p in PORTS:
            r = reachable(g, p)
            if r:
                hits.append(p)
                print("  %s:%d  OPEN" % (g, p))
        if hits:
            winners.append((g, hits))

    print()
    if winners:
        for g, hits in winners:
            print("phone found at %s, listening on %s" % (g, ",".join(map(str, hits))))
        print("\nnow run:  link.exe run --host %s" % winners[0][0])
        return 0
    print("nothing answering on the CarLife ports.")
    print("on the phone: 智能车载 -> 连接车辆 -> 无线连接 -> 百度CarLife+ -> 开始连接")
    print("and keep the phone's hotspot on with the screen awake.")
    return 1


if __name__ == "__main__":
    sys.exit(main())

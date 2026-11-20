#!/usr/bin/env python3
"""Check that a built libcarlife-tap.so will actually load on the unit.

The unit is x86_64 with glibc 2.27. A library that asks for a newer symbol
version fails at load time with "undefined symbol" and nothing on the car
screen says why, so the build has to refuse to hand one over.

Pure stdlib ELF parsing: the build machine (Windows) has no readelf, and the
container does not always have binutils either.

    python3 check_elf.py bin/libcarlife-tap.so

Exit status 1 and a reason on stderr if anything is off.
"""

import struct
import sys

SHT_SYMTAB = 2
SHT_STRTAB = 3
SHT_DYNAMIC = 6
SHT_DYNSYM = 11
DT_NEEDED = 1
ET_DYN = 3
EM_X86_64 = 62
MAX_GLIBC = (2, 27)


class Bad(Exception):
    pass


def sections(d):
    if d[:4] != b"\x7fELF":
        raise Bad("not an ELF file")
    if d[4] != 2:
        raise Bad("not 64-bit (the unit is x86_64)")
    if d[5] != 1:
        raise Bad("not little-endian")
    e_type = struct.unpack_from("<H", d, 16)[0]
    e_machine = struct.unpack_from("<H", d, 18)[0]
    if e_type != ET_DYN:
        raise Bad("not a shared object (e_type=%d, want ET_DYN)" % e_type)
    if e_machine != EM_X86_64:
        raise Bad("wrong machine (e_machine=%d, want %d)" % (e_machine, EM_X86_64))

    shoff = struct.unpack_from("<Q", d, 40)[0]
    shentsize = struct.unpack_from("<H", d, 58)[0]
    shnum = struct.unpack_from("<H", d, 60)[0]
    shstrndx = struct.unpack_from("<H", d, 62)[0]
    if not shoff or not shnum:
        raise Bad("no section headers (stripped too hard to inspect)")

    out = []
    for i in range(shnum):
        off = shoff + i * shentsize
        (name, typ, flags, addr, offset, size,
         link, info, align, entsize) = struct.unpack_from("<IIQQQQIIQQ", d, off)
        out.append(dict(name=name, type=typ, offset=offset, size=size,
                        link=link, entsize=entsize))

    strtab = out[shstrndx]
    for s in out:
        end = d.index(b"\0", strtab["offset"] + s["name"])
        s["sname"] = d[strtab["offset"] + s["name"]:end].decode("ascii", "replace")
    return out


def cstr(d, off):
    return d[off:d.index(b"\0", off)].decode("ascii", "replace")


def dyn_needed(d, secs):
    dyn = next((s for s in secs if s["type"] == SHT_DYNAMIC), None)
    if not dyn:
        raise Bad("no .dynamic section")
    strtab = secs[dyn["link"]]
    needed, soname = [], None
    for off in range(dyn["offset"], dyn["offset"] + dyn["size"], 16):
        tag, val = struct.unpack_from("<qQ", d, off)
        if tag == 0:
            break
        if tag == DT_NEEDED:
            needed.append(cstr(d, strtab["offset"] + val))
        elif tag == 14:                     # DT_SONAME
            soname = cstr(d, strtab["offset"] + val)
    return needed, soname


def exported(d, secs):
    """Global defined symbols in .dynsym."""
    sym = next((s for s in secs if s["type"] == SHT_DYNSYM), None)
    if not sym:
        raise Bad("no .dynsym (nothing would be interposable)")
    strtab = secs[sym["link"]]
    out = set()
    for off in range(sym["offset"], sym["offset"] + sym["size"], sym["entsize"] or 24):
        st_name, st_info, st_other, st_shndx, st_value, st_size = \
            struct.unpack_from("<IBBHQQ", d, off)
        bind = st_info >> 4
        if st_name and bind in (1, 2) and st_shndx != 0:   # GLOBAL, WEAK, defined
            out.add(cstr(d, strtab["offset"] + st_name))
    return out


def glibc_versions(d):
    """Every GLIBC_2.x named anywhere in the file: .gnu.version_r and the
    version strings live in string tables, and a plain scan cannot miss one."""
    seen, i = set(), 0
    needle = b"GLIBC_2."
    while True:
        i = d.find(needle, i)
        if i < 0:
            break
        j = i + len(needle)
        num = b""
        while j < len(d) and (d[j:j + 1].isdigit() or d[j:j + 1] == b"."):
            num += d[j:j + 1]
            j += 1
        seen.add("2." + num.decode())
        i = j
    return seen


def main(path):
    d = open(path, "rb").read()
    secs = sections(d)
    needed, soname = dyn_needed(d, secs)
    syms = exported(d, secs)
    vers = glibc_versions(d)

    print("file      %s (%.1f KB)" % (path, len(d) / 1024.0))
    print("soname    %s" % (soname or "(none)"))
    print("needs     %s" % ", ".join(needed))
    print("glibc     %s" % (", ".join(sorted(vers)) or "(none)"))

    bad = []
    for v in vers:
        # "2.2.5" is the x86_64 baseline and is three parts; only the first
        # two decide whether the unit's glibc is new enough.
        parts = v.split(".")
        major, minor = int(parts[0]), int(parts[1])
        if (major, minor) > MAX_GLIBC:
            bad.append(v)
    if bad:
        raise Bad("asks for GLIBC %s; the unit has %d.%d"
                  % (", ".join(sorted(bad)), *MAX_GLIBC))
    for fn in ("read", "ioctl"):
        if fn not in syms:
            raise Bad("%s() is not exported: that call would not be interposed" % fn)
    print("interpose read, ioctl  ok")

    for fn in ("malloc", "free", "pthread_create", "dlsym"):
        if fn in needed:                    # nonsensical, but cheap to guard
            raise Bad("needs %s? that is not a library name" % fn)
    print("OK")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: check_elf.py <library.so>")
    try:
        main(sys.argv[1])
    except Bad as e:
        sys.stderr.write("FAIL: %s\n" % e)
        sys.exit(1)
    except FileNotFoundError:
        sys.exit("FAIL: %s does not exist" % sys.argv[1])

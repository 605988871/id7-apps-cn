#!/usr/bin/env python3
"""Refuse a binary the unit cannot start, before it is packed.

The unit is x86-64, little-endian, glibc 2.27, and has no /lib64. A toolchain
that grew up on a desktop distribution asks for /lib64/ld-linux-x86-64.so.2 by
default; such a program is present, has its execute bit, passes `test -x`, and
still fails with ENOENT - the *interpreter* is missing - which systemd reports
as "Failed at step EXEC spawning". carlife-tap 0.4.4 shipped that and cost a
build and a drive to find.

The same failure comes back a second way, and did: building under Git Bash let
the shell rewrite -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 into the build
machine's own path before zig saw it, so PT_INTERP held

    D:/.../PortableGit/lib/ld-linux-x86-64.so.2

A substring test for "/lib/ld-linux-x86-64.so.2" passes on that string, because
it is there - at the end. The check never fired and the unit reported
"carlife-link exited (rc 127)". So the interpreter is now read out of the
program header and compared exactly, instead of searched for in the whole file.

usage: elf_check.py FILE
"""
import sys
from pathlib import Path

LOADER = '/lib/ld-linux-x86-64.so.2'
BAD_LOADER = '/lib64/ld-linux-x86-64.so.2'
PT_INTERP = 3


def read_interp(blob):
    """The PT_INTERP string, or None when the file has no interpreter.

    Parsed rather than searched: a byte string that merely contains the right
    tail is what got through last time.
    """
    e_phoff = int.from_bytes(blob[32:40], 'little')
    e_phentsize = int.from_bytes(blob[54:56], 'little')
    e_phnum = int.from_bytes(blob[56:58], 'little')
    for i in range(e_phnum):
        base = e_phoff + i * e_phentsize
        if base + 56 > len(blob):
            return None
        if int.from_bytes(blob[base:base + 4], 'little') != PT_INTERP:
            continue
        offset = int.from_bytes(blob[base + 8:base + 16], 'little')
        size = int.from_bytes(blob[base + 32:base + 40], 'little')
        if offset + size > len(blob):
            return None
        return blob[offset:offset + size].rstrip(b'\x00').decode('utf-8', 'replace')
    return None


def main(path):
    blob = Path(path).read_bytes()
    problems = []
    if blob[:4] != b'\x7fELF':
        problems.append('not an ELF file')
    else:
        if blob[4] != 2:
            problems.append('not 64-bit (EI_CLASS=%d)' % blob[4])
        if blob[5] != 1:
            problems.append('not little-endian (EI_DATA=%d)' % blob[5])
        machine = int.from_bytes(blob[18:20], 'little')
        if machine != 62:
            problems.append('not x86-64 (e_machine=%d)' % machine)
        etype = int.from_bytes(blob[16:18], 'little')
        if etype not in (2, 3):
            problems.append('not an executable (e_type=%d)' % etype)

        interp = read_interp(blob)
        if interp is None:
            problems.append('has no PT_INTERP: it would need a static build, '
                            'and this one is linked')
        elif interp == BAD_LOADER:
            problems.append('names %s, which this unit does not have' % BAD_LOADER)
        elif interp != LOADER:
            problems.append('interpreter is %r, the unit only has %r' % (interp, LOADER))
            if ':' in interp or '\\' in interp:
                problems.append('the build host rewrote the path: build.sh must '
                                'export MSYS_NO_PATHCONV=1 before calling zig')

    if problems:
        for p in problems:
            print('elf_check: ' + p, file=sys.stderr)
        return 1
    print('elf: 64-bit LE x86-64, loader %s, %d bytes' % (LOADER, len(blob)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'carlife-link'))

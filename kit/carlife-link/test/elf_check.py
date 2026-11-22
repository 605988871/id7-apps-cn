#!/usr/bin/env python3
"""Refuse a binary the unit cannot start, before it is packed.

The unit is x86-64, little-endian, glibc 2.27, and has no /lib64. A toolchain
that grew up on a desktop distribution asks for /lib64/ld-linux-x86-64.so.2 by
default; such a program is present, has its execute bit, passes `test -x`, and
still fails with ENOENT - the *interpreter* is missing - which systemd reports
as "Failed at step EXEC spawning". carlife-tap 0.4.4 shipped that and cost a
build and a drive to find.

usage: elf_check.py FILE
"""
import sys
from pathlib import Path

LOADER = b'/lib/ld-linux-x86-64.so.2\x00'
BAD_LOADER = b'/lib64/ld-linux-x86-64.so.2\x00'


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
    if BAD_LOADER in blob:
        problems.append('names /lib64/ld-linux-x86-64.so.2, which this unit does not have')
    elif LOADER not in blob:
        problems.append('does not name /lib/ld-linux-x86-64.so.2')

    if problems:
        for p in problems:
            print('elf_check: ' + p, file=sys.stderr)
        return 1
    print('elf: 64-bit LE x86-64, loader /lib/ld-linux-x86-64.so.2, %d bytes' % len(blob))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'carlife-link'))

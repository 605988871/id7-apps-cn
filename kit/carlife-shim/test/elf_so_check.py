#!/usr/bin/env python3
"""Refuse a shared library the unit cannot load, before it is packed.

A library fails differently from a program. There is no interpreter to be
missing - if one is named, the loader was told to build an executable and the
file will not load as a preload at all. What does bite is the glibc version:
built against 2.34 symbols, a .so loads into a 2.27 process as
"version `GLIBC_2.34' not found", and the visible symptom is carlife not
starting.

So this checks the header, the absence of PT_INTERP, and that the symbols the
shim exists for are really in the file - a build that defined none of them
links fine and does nothing.

usage: elf_so_check.py FILE
"""
import struct
import sys
from pathlib import Path

WANT = [b'libusb_bulk_transfer', b'libusb_control_transfer', b'libusb_get_device_list',
        b'libusb_open', b'libusb_submit_transfer', b'libusb_get_string_descriptor_ascii']
BAD = [b'GLIBC_2.33', b'GLIBC_2.34', b'GLIBC_2.35', b'GLIBC_2.36']


def main(path):
    blob = Path(path).read_bytes()
    problems = []

    if blob[:4] != b'\x7fELF':
        problems.append('not an ELF file')
    else:
        if blob[4] != 2 or blob[5] != 1:
            problems.append('not 64-bit little-endian')
        if int.from_bytes(blob[18:20], 'little') != 62:
            problems.append('not x86-64')
        if int.from_bytes(blob[16:18], 'little') != 3:
            problems.append('not a shared object (e_type=%d)'
                            % int.from_bytes(blob[16:18], 'little'))

        # PT_INTERP (3, not 2 - that is PT_DYNAMIC) in a .so means it was
        # linked as an executable; the loader then wants to run it, not preload.
        e_phoff = int.from_bytes(blob[32:40], 'little')
        e_phentsize = int.from_bytes(blob[54:56], 'little')
        e_phnum = int.from_bytes(blob[56:58], 'little')
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            if off + 4 > len(blob):
                break
            if struct.unpack_from('<I', blob, off)[0] == 3:
                problems.append('has PT_INTERP: this is an executable, not a library')

    missing = [w.decode() for w in WANT if w not in blob]
    if missing:
        problems.append('does not export: ' + ' '.join(missing))
    named = [b.decode() for b in BAD if b in blob]
    if named:
        problems.append('needs a glibc newer than the unit\'s 2.27 (' + ' '.join(named) + ')')

    if problems:
        for p in problems:
            print('elf_so_check: ' + p, file=sys.stderr)
        return 1
    print('so: 64-bit LE x86-64, no interpreter, %d bytes' % len(blob))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'carlife-shim.so'))

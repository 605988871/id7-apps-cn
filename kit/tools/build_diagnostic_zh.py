#!/usr/bin/env python3
"""Package/audit the machine-assisted diagnostic catalog independently of UI text.

Normal builds use the committed catalog: no model, network or SDK is needed to
generate this data pack. --report writes coverage evidence for the bundled DB.
The translations are not individually human reviewed; see docs/diagnostic-chinese.md.
"""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib

ROOT = Path(__file__).resolve().parents[2]
LOCALIZATION = ROOT / 'kit/localization'
# The full term corpus, Chinese and Russian, is read by this app's build alone. It
# sits in the app's own folder so a store install of any other app does not
# download it: mgu-repo.json's build.shared lists kit/localization, and everything
# under it goes along with every app's install.
#
# It is stored gzipped (24 MB of JSON is 3 MB of gzip). The file is also in the
# tarball a repo-tree source downloads, and the Store counts a tool (a
# component.json, no build step) as "the repository", so every component update
# paid for it. A plain .json is still read, for older checkouts.
DIAGNOSTIC = ROOT / 'apps/cn_dtc_scanner/i18n'


def corpus(name):
    """The corpus file by name: the app's own folder, else kit/localization
    (where it lived before the move, for older checkouts). Gzipped, else plain."""
    for base in (DIAGNOSTIC, LOCALIZATION):
        for suffix in ('.gz', ''):
            path = base / (name + suffix)
            if path.is_file():
                return path
    return DIAGNOSTIC / (name + '.gz')


def read_corpus(name):
    """The corpus by name as a dict, gzipped or plain."""
    path = corpus(name)
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt', encoding='utf-8') as file:
        return json.load(file)


def database_strings():
    data = (ROOT/'apps/cn_dtc_scanner/dtc_db.pack').read_bytes()
    if data[:8] != b'MGUPACK1':
        raise ValueError('Not an MGUPACK1 database')
    length = struct.unpack('<I', data[8:12])[0]
    index = json.loads(zlib.decompress(data[12:12+length], -15))
    texts = set()
    def walk(value):
        if isinstance(value, str):
            texts.add(value)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    for name, (offset, size) in index['files'].items():
        if name.startswith('tables/'):
            walk(json.loads(zlib.decompress(data[12+length+offset:12+length+offset+size], -15)))
    return texts


def normalize(source):
    german = str.maketrans({'ä':'ae', 'ö':'oe', 'ü':'ue', 'Ä':'Ae', 'Ö':'Oe', 'Ü':'Ue', 'ß':'ss'})
    return re.sub(r'[\x00-\x1f\x7f]', '', source.translate(german))


def catalog():
    values = read_corpus('diagnostic-full.zh-CN.json')
    ui = json.loads((ROOT/'kit/runtime/locales/zh-CN.json').read_text(encoding='utf-8'))
    # Preserve the previously shipped complete diagnostic sentences. UI fragments
    # such as ACC/power/software are never substituted into an unknown sentence.
    for source, value in ui.items():
        if source in values or len(source) > 20:
            values[source] = value
    overrides = json.loads((LOCALIZATION/'diagnostic-overrides.zh-CN.json').read_text(encoding='utf-8'))
    values.update(overrides)
    for source in values:
        value = re.sub(r'[\x00-\x1f\x7f]', ' ', values[source])
        values[source] = re.sub(r' +', ' ', value).strip()
    for source, value in list(values.items()):
        values.setdefault(normalize(source), value)
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    args.report.mkdir(parents=True, exist_ok=True)
    values = catalog()
    texts = database_strings()
    untranslated = sorted(texts - values.keys())
    if untranslated:
        raise ValueError('Database changed: %d missing translation keys' % len(untranslated))
    identifiers = sorted(s for s in texts if values[s] == s)
    number = re.compile(r'(?<![A-Za-z0-9_])\d+(?:\.\d+)*(?![A-Za-z0-9_])')
    from collections import Counter
    for source in texts:
        if re.search(r'<unk>|\u2047|\ufffd', values[source]):
            raise ValueError('Invalid translation placeholder: ' + source)
        if Counter(number.findall(source)) - Counter(number.findall(values[source])):
            raise ValueError('Numeric literal lost: ' + source)
        if normalize(source) not in values:
            raise ValueError('Normalized display key missing: ' + source)
        for token in re.findall(r'0x[0-9A-Fa-f]+', source):
            if token not in values[source]:
                raise ValueError('Hex ID lost: ' + source)
    stats = {
        'database_sha256': hashlib.sha256((ROOT/'apps/cn_dtc_scanner/dtc_db.pack').read_bytes()).hexdigest(),
        'database_unique': len(texts),
        'chinese_descriptions': sum(bool(re.search(r'[\u4e00-\u9fff]', values[s])) for s in texts),
        'identifier_only': len(identifiers),
        'missing': len(untranslated),
        'catalog_keys': len(values),
        'review_status': 'machine-assisted; not individually human reviewed',
    }
    with (args.report/'translations.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['source', 'translation'])
        writer.writerows((s, values[s]) for s in sorted(texts))
    (args.report/'coverage.json').write_text(json.dumps(stats, indent=2)+'\n', encoding='utf-8')
    (args.report/'identifier-only.json').write_text(json.dumps(identifiers, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(stats))


if __name__ == '__main__':
    main()

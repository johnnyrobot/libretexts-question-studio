#!/usr/bin/env python3
"""Stages one of the site's own model builds outside git, as the server serves it.

    python3 -I scripts/stage-model.py <build> <stage root> <source folder>...

Copies every file models/<build>/SHA256SUMS names, from the first source
folder that has it, into <stage root>/<build>/, and checks its sha256. Then
adds MODEL.md and SHA256SUMS from the repo. Refuses a stage root inside the
repo (the weights never go into git) and stops on the first wrong hash, leaving
no partial file. Files already staged with the right hash are kept, so a
stopped run can be started again.

For qwen35-9b-ftds-q4f16_1-v1 (LT-237) the sources are the MLC build folder,
the folder holding WebLLM's Qwen3.5-9B-q4f16_1_cs1k-webgpu.wasm, and the merged
model's folder (for LICENSE). scripts/serve-models.py serves the result, and
scripts/deploy-models.sh uploads it.
"""
import hashlib
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def pinned(build):
    sums = {}
    with open(os.path.join(REPO, 'models', build, 'SHA256SUMS')) as f:
        for line in f:
            digest, name = line.split()
            if '/' in name or name.startswith('.'):
                sys.exit(f'SHA256SUMS names a path, not a file: {name}')
            sums[name] = digest
    return sums


def main(build, root, sources):
    root = os.path.abspath(os.path.expanduser(root))
    if os.path.commonpath([root, REPO]) == REPO:
        sys.exit(f'Refusing to stage inside the repo ({root}); the weights stay out of git.')
    target = os.path.join(root, build)
    os.makedirs(target, exist_ok=True)
    sums = pinned(build)
    total = 0
    for i, (name, digest) in enumerate(sorted(sums.items()), 1):
        dest = os.path.join(target, name)
        if os.path.exists(dest) and sha256(dest) == digest:
            total += os.path.getsize(dest)
            continue
        source = next((os.path.join(s, name) for s in sources if os.path.isfile(os.path.join(s, name))), None)
        if not source:
            sys.exit(f'{name}: in no source folder')
        partial = dest + '.partial'
        shutil.copyfile(source, partial)
        if sha256(partial) != digest:
            os.remove(partial)
            sys.exit(f'{name}: sha256 does not match SHA256SUMS ({source})')
        os.replace(partial, dest)
        total += os.path.getsize(dest)
        print(f'[{i}/{len(sums)}] {name}')
    extra = sorted(set(os.listdir(target)) - set(sums) - {'MODEL.md', 'SHA256SUMS'})
    if extra:
        sys.exit(f'{target} holds files SHA256SUMS does not name: {", ".join(extra)}')
    for name in ('MODEL.md', 'SHA256SUMS'):
        shutil.copyfile(os.path.join(REPO, 'models', build, name), os.path.join(target, name))
    print(f'Staged {len(sums)} files, {total:,} bytes, in {target}')


if __name__ == '__main__':
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], [os.path.expanduser(s) for s in sys.argv[3:]])

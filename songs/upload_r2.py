"""Copy InnerVerse Music mp3s into the innerverse-audio R2 bucket (public at audio.innerversepodcast.com/songs/).

Run by .github/workflows/songs-to-r2.yml, never by hand (the keys live only in the repository secrets).

  python3 songs/upload_r2.py incoming   # songs/incoming/*.mp3 (new songs); the workflow then removes them from the repo
  python3 songs/upload_r2.py existing   # songs/*.mp3 (the one-time move of 2026-11-10)

Safe to rerun: a file already in the bucket at the same size is skipped. A file in the bucket at a DIFFERENT size
is only replaced when REPLACE=yes, so a slip never overwrites a published song. Every file is checked through its
public address afterwards (type audio/mpeg, right size, answers a Range request so the player can seek).
Writes songs-r2-report.json. Exit code 1 if anything failed.
"""
import glob
import json
import os
import re
import sys
import time
import urllib.request

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = 'innerverse-audio'
PREFIX = 'songs/'
PUBLIC = 'https://audio.innerversepodcast.com/songs/'
NAME_OK = re.compile(r'^[a-z0-9][a-z0-9-]*\.mp3$')
MAX_BYTES = 15 * 1024 * 1024  # a song mp3 is about 4 to 5 MB; anything far bigger is a mistake (a WAV renamed, say)


def client():
    acct = os.environ.get('R2_ACCOUNT_ID', '').strip()
    key = os.environ.get('R2_AUDIO_ACCESS_KEY_ID', '').strip()
    sec = os.environ.get('R2_AUDIO_SECRET_ACCESS_KEY', '').strip()
    # lengths only, never values, so a missing or mistyped secret is easy to spot in the run log
    print(f'preflight: R2_ACCOUNT_ID {len(acct)} chars, R2_AUDIO_ACCESS_KEY_ID {len(key)} chars, '
          f'R2_AUDIO_SECRET_ACCESS_KEY {len(sec)} chars')
    if not (acct and key and sec):
        sys.exit('missing a repository secret (see the lengths above)')
    return boto3.client('s3', endpoint_url=f'https://{acct}.r2.cloudflarestorage.com',
                        aws_access_key_id=key, aws_secret_access_key=sec, region_name='auto',
                        config=Config(retries={'max_attempts': 5}))


def remote_size(s3, key):
    try:
        return s3.head_object(Bucket=BUCKET, Key=key)['ContentLength']
    except ClientError as e:
        if e.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise


def check_public(name, size):
    """The public copy answers a Range request with 206, audio/mpeg and the full size in Content-Range."""
    last = ''
    for attempt in range(6):
        try:
            req = urllib.request.Request(PUBLIC + name + f'?check={int(time.time())}',
                                         headers={'Range': 'bytes=0-1023', 'User-Agent': 'innerverse-songs-check'})
            with urllib.request.urlopen(req, timeout=30) as r:
                ctype = r.headers.get('Content-Type', '')
                crange = r.headers.get('Content-Range', '')
                body = r.read()
                total = int(crange.rsplit('/', 1)[-1]) if '/' in crange else -1
                if r.status == 206 and ctype.startswith('audio/mpeg') and total == size and len(body) == 1024:
                    return ''
                last = f'status {r.status}, type {ctype!r}, range {crange!r}, expected size {size}'
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(5)
    return last


def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else 'incoming').strip()
    pattern = {'incoming': 'songs/incoming/*.mp3', 'existing': 'songs/*.mp3'}.get(mode)
    if not pattern:
        sys.exit(f'unknown mode {mode!r}: use incoming or existing')
    files = sorted(glob.glob(pattern))
    print(f'{mode}: {len(files)} mp3 file(s)')
    if not files:
        json.dump({'mode': mode, 'results': []}, open('songs-r2-report.json', 'w'), indent=1)
        return
    with open('songs/songs.json') as f:
        listed = {s.get('file') for s in json.load(f)['songs']}
    replace = os.environ.get('REPLACE', '').strip().lower() == 'yes'
    s3 = client()
    results, failed = [], 0
    for path in files:
        name = os.path.basename(path)
        size = os.path.getsize(path)
        row = {'file': name, 'bytes': size, 'url': PUBLIC + name}
        try:
            if not NAME_OK.match(name):
                raise ValueError('file name must be lower case letters, digits and hyphens, ending .mp3')
            if size > MAX_BYTES:
                raise ValueError(f'{size} bytes is far bigger than a song mp3; convert it to a 192k mp3 first')
            with open(path, 'rb') as fh:
                head = fh.read(3)
            if not (head == b'ID3' or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)):
                raise ValueError('not an mp3 (no ID3 tag or mp3 frame at the start)')
            key = PREFIX + name
            have = remote_size(s3, key)
            if have == size:
                row['action'] = 'already there'
            elif have is not None and not replace:
                raise ValueError(f'the bucket already has a different {name} ({have} bytes); rerun with replace=yes '
                                 f'only if this new file should take its place')
            else:
                s3.upload_file(path, BUCKET, key, ExtraArgs={'ContentType': 'audio/mpeg',
                                                              'CacheControl': 'public, max-age=86400'})
                row['action'] = 'replaced' if have is not None else 'uploaded'
            problem = check_public(name, size)
            if problem:
                raise ValueError('public copy check failed: ' + problem)
            row['ok'] = True
            if name not in listed:
                row['note'] = 'not listed in songs.json yet'
            print(f"OK   {name}  {size} bytes  {row['action']}" + (f"  ({row['note']})" if row.get('note') else ''))
        except Exception as e:  # noqa: BLE001
            failed += 1
            row['ok'] = False
            row['error'] = str(e)
            print(f'FAIL {name}  {e}')
        results.append(row)
    with open('songs-r2-report.json', 'w') as f:
        json.dump({'mode': mode, 'results': results}, f, indent=1)
    print(f'done: {len(results) - failed} ok, {failed} failed')
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    main()

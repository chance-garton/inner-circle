"""Builds the static page for GitHub Pages from src/app.html.
Usage: python3 build-page.py <out.html> [api_url] [auth_url]"""
import sys
src = open(__file__.rsplit('/', 1)[0] + '/src/app.html').read()
api = sys.argv[2] if len(sys.argv) > 2 else 'https://innerverse-circle.chance-5da.workers.dev'
auth = sys.argv[3] if len(sys.argv) > 3 else 'https://innerverse-plus.chance-5da.workers.dev'
dev = sys.argv[4] if len(sys.argv) > 4 else '0'
out = src.replace('__AUTH_URL__', auth, 1).replace("'__DEV__'", "'" + dev + "'", 1).replace("'__API__'", "'" + api + "'", 1)
assert '__API__' not in out and '__AUTH_URL__' not in out
open(sys.argv[1], 'w').write(out)
print('wrote', sys.argv[1], len(out))

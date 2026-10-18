#!/usr/bin/env python3
"""Build the public share page for every episode song: songs/<id>/index.html.

Run from the repo root after any change to songs/songs.json:  python3 songs/build.py
Each page carries the song's art, a player, the episode it came from, and the tags that
make a shared link show the art and title in messages and social posts. It also removes
share pages whose song is no longer listed.
"""
import html, json, os, shutil, sys, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://circle.innerversepodcast.com/songs/'
SITE = 'https://www.innerversepodcast.com'
INDEX = 'https://raw.githubusercontent.com/chance-garton/innerverse-data/refs/heads/main/episodes-index.json'


def thumbs():
    try:
        with urllib.request.urlopen(INDEX, timeout=30) as r:
            return {e['slug']: e for e in json.load(r).get('episodes', [])}
    except Exception as e:  # the pages still build, with the logo standing in for missing art
        print('episodes-index not reachable:', e, file=sys.stderr)
        return {}


def clock(sec):
    sec = int(sec or 0)
    return f'{sec // 60}:{sec % 60:02d}'


PAGE = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} | InnerVerse song</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#0A0F1C">
<link rel="icon" type="image/png" href="/app/icons/favicon-64.png">
<link rel="apple-touch-icon" href="/app/icons/apple-touch-icon.png">
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="InnerVerse">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{art}">
<meta property="og:audio" content="{audio}">
<meta property="og:audio:type" content="audio/mpeg">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{art}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Manrope:wght@500;700;800&display=swap">
<style>
:root{{--ground:#0A0F1C;--card:#151E33;--line:rgba(233,238,246,0.12);--ink:#E9EEF6;--muted:#9AA6BA;--lapis:#3B74CC;--lapis-lit:#8FB5F0;--gold:#D8AA3C}}
*{{box-sizing:border-box}}
html{{-webkit-text-size-adjust:100%;text-size-adjust:100%}}
body{{margin:0;min-height:100vh;background:radial-gradient(90% 60% at 50% 0%,#14203A,var(--ground) 70%) var(--ground);color:var(--ink);font-family:Manrope,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}}
main{{max-width:460px;margin:0 auto;padding:max(28px,env(safe-area-inset-top)) 16px 40px}}
.brand{{display:flex;align-items:center;justify-content:center;gap:9px;color:var(--ink);text-decoration:none;font-weight:800;letter-spacing:.14em;text-transform:uppercase;font-size:13px;margin-bottom:22px}}
.brand img{{width:28px;height:28px}}
.art{{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:20px;background:var(--card);box-shadow:0 22px 60px rgba(0,0,0,0.55)}}
.eyebrow{{margin:22px 0 4px;font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--lapis-lit)}}
h1{{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:32px;line-height:1.15;margin:0 0 6px}}
.from{{color:var(--muted);margin:0 0 18px}}
.from b{{color:var(--ink);font-weight:700}}
audio{{width:100%;margin:0 0 18px}}
.btn{{display:flex;align-items:center;justify-content:center;min-height:48px;border-radius:999px;font-weight:800;font-size:15px;text-decoration:none;margin-top:10px}}
.btn.main{{background:var(--lapis);color:#fff}}
.btn.line{{border:2px solid var(--lapis-lit);color:var(--ink)}}
.more{{margin-top:28px;padding-top:18px;border-top:1px solid var(--line)}}
.more h2{{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:20px;margin:0 0 10px}}
.more a{{display:flex;gap:12px;align-items:center;padding:8px 0;color:var(--ink);text-decoration:none}}
.more img{{width:56px;height:56px;border-radius:10px;object-fit:cover;flex:none;background:var(--card)}}
.more span{{font-weight:700}}
.more small{{display:block;color:var(--muted);font-weight:500}}
footer{{margin-top:30px;text-align:center;font-size:13px;color:var(--muted)}}
footer a{{color:var(--lapis-lit);font-weight:700;text-decoration:none}}
</style>
</head>
<body>
<main>
  <a class="brand" href="{site}/"><img src="https://images.squarespace-cdn.com/content/5987d897cf81e0278ec5322e/9a710a85-f780-4b67-a4c7-2b45690b6006/2025-Electric-Logo-2026.png?format=100w" alt="">InnerVerse</a>
  <img class="art" src="{art}" alt="Art for {title}">
  <div class="eyebrow">An original InnerVerse song</div>
  <h1>{title}</h1>
  <p class="from">From the episode <b>{ep_title}</b>{length}</p>
  <audio controls preload="metadata" src="{audio}"></audio>
  <a class="btn main" href="{ep_url}">Hear the full conversation</a>
  <a class="btn line" href="/app/#/songs/{id}">Open in the InnerVerse app</a>
  {more}
  <footer>Independently produced since 2015. <a href="{site}/episodes">Explore the episodes</a></footer>
</main>
</body>
</html>
'''


def main():
    with open(os.path.join(ROOT, 'songs.json')) as f:
        songs = json.load(f)['songs']
    eps = thumbs()
    built = set()
    for s in songs:
        sid = s['id']
        ep = eps.get(s['episode'], {})
        ep_title = s.get('episodeTitle') or ep.get('title') or 'an InnerVerse episode'
        thumb = (ep.get('thumb') or '').split('?')[0]
        art = BASE + s['art'] if s.get('art') else (thumb + '?format=750w' if thumb else 'https://circle.innerversepodcast.com/app/icons/icon-512.png')
        siblings = [x for x in songs if x['episode'] == s['episode'] and x['id'] != sid]

        def sib(x):
            a = BASE + x['art'] if x.get('art') else (thumb + '?format=300w' if thumb else '')
            return (f'<a href="{BASE}{html.escape(x["id"])}/"><img src="{html.escape(a)}" alt="">'
                    f'<span>{html.escape(x["title"])}<small>{clock(x.get("seconds"))}</small></span></a>')
        more = (f'<div class="more"><h2>More songs from this episode</h2>{"".join(sib(x) for x in siblings)}</div>'
                if siblings else '')
        page = PAGE.format(
            title=html.escape(s['title']), id=html.escape(sid),
            desc=html.escape(f'An original InnerVerse song from the episode {ep_title}.'),
            url=f'{BASE}{sid}/', art=html.escape(art), audio=f'{BASE}{html.escape(s["file"])}',
            ep_title=html.escape(ep_title), ep_url=f'{SITE}/episodes/{html.escape(s["episode"])}',
            length=f' · {clock(s["seconds"])}' if s.get('seconds') else '', more=more, site=SITE)
        os.makedirs(os.path.join(ROOT, sid), exist_ok=True)
        with open(os.path.join(ROOT, sid, 'index.html'), 'w') as f:
            f.write(page)
        built.add(sid)
    for name in os.listdir(ROOT):
        p = os.path.join(ROOT, name)
        if os.path.isdir(p) and name not in built and os.path.exists(os.path.join(p, 'index.html')):
            shutil.rmtree(p)
    print('built', len(built), 'song pages')


if __name__ == '__main__':
    main()

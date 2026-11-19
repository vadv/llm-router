#!/usr/bin/env python3
"""Render model Wiki JSON Lines as a standalone HTML file. No network or key needed."""

import argparse
from html import escape
import json
import sys
from urllib.parse import urlsplit

from research_prices import validate_wiki


STYLE = '''
*{box-sizing:border-box}html{color-scheme:light;scroll-behavior:auto}body{margin:0;background:#f4f3ed;color:#182c27;font:16px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 24px 60px}header{border-top:4px solid #285c4e;padding:18px 0 22px}header b,.eyebrow,dt{font:700 .72rem/1.5 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#46675b}h1,h2{font:600 clamp(2.1rem,5vw,3.4rem)/1.1 Georgia,serif;margin:.32em 0}h2{font-size:clamp(1.8rem,4vw,2.6rem)}p,ul{margin:.35rem 0 .75rem}h3{font-size:1.07rem;margin:.2rem 0 .35rem}a{color:#155c4f;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #c7761a;outline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}nav a{background:white;border:1px solid #bacac1;border-radius:6px;padding:5px 12px;text-decoration:none}article{background:#fffefa;border:1px solid #cdd6cd;border-radius:16px;padding:clamp(16px,3vw,32px);margin:0 0 20px;overflow-wrap:anywhere}article>p{max-width:76ch}article>section{margin-top:18px}small{color:#51635b}section.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:20px;align-items:start}.judgment,.price{border-radius:10px;padding:18px}.judgment{background:#e9f2eb}.price{background:#f2eee2}.price dl{display:flex;flex-wrap:wrap;gap:12px 24px;margin:10px 0}.price dd{margin:0;font-size:1.35rem;font-weight:650;font-variant-numeric:tabular-nums}.check{border-left:3px solid #6f8a78;padding-left:14px;margin:16px 0}.facts{border-top:1px solid #d4dbd4;padding-top:10px}.facts summary{cursor:pointer;font-weight:600}.facts ul{padding-left:1.4rem}.facts blockquote{margin:.45rem 0;color:#495750}footer{padding-top:1rem;color:#51635b;font-size:.85rem}@media(max-width:650px){main{padding:14px 12px 36px}section.grid{grid-template-columns:1fr;gap:10px}.judgment,.price{padding:14px}}
'''


def amount(bounds):
    if bounds is None:
        return 'нет оценки'
    low, high = bounds['min'], bounds['max']
    if low is None:
        return 'до ' + str(high)
    if high is None:
        return 'от ' + str(low)
    return '≈ ' + (str(low) if low == high else f'{low}–{high}')


def link(url):
    return f'<a href="{escape(url)}" rel="noreferrer">{escape(urlsplit(url).hostname)}</a>'


def card_html(card, index):
    if not isinstance(card, dict) or card.get('scope') != 'model_wiki':
        raise ValueError('expected a --wiki record, not a provider listing')
    for field in ('model', 'researcher', 'researched_at'):
        if not isinstance(card.get(field), str) or not card[field].strip():
            raise ValueError('missing Wiki metadata: ' + field)
    c = validate_wiki(card)
    name, author, date = (escape(card[k]) for k in ('model', 'researcher', 'researched_at'))
    p = c['price']
    if p['kind'] == 'estimate':
        rates = ''.join(f'<div><dt>{label}</dt><dd>{amount(p[key])}</dd></div>' for label, key in
                        [('Вход', 'input_per_1m'), ('Выход', 'output_per_1m')])
        cost = f'<dl>{rates}</dl><small>{escape(p["currency"])} за 1 млн токенов</small>'
    else:
        cost = '<p><strong>' + ('Тарификация по плану' if p['kind'] == 'plan' else 'Нет обоснованной оценки') + '</strong></p>'
    def bullets(values):
        return '<ul>' + ''.join('<li>' + escape(v) + '</li>' for v in values) + '</ul>' if values else '<p>Недостаточно данных.</p>'
    metrics = ''.join(f'<li>{escape(r["metric"])}: {escape(r["result"])} · {link(r["source_url"])}</li>' for r in c['ratings'])
    evidence = ('<ul>' + metrics + '</ul>') if metrics else '<p>В этой карточке нет подтверждённых оценок.</p>'
    price_source = ('<p>Источник цены: ' + link(p['source_url']) + '</p>') if p['source_url'] else ''
    quote = f'<blockquote>{escape(p["quote"])}</blockquote>' if p['quote'] else ''
    return f'''<article id="model-{index}"><div class="eyebrow">Карточка {index:02d} · Модель</div><h2>{name}</h2><p>{escape(c['summary'])}</p>
<section class="grid"><div class="judgment"><div class="eyebrow">Практическое суждение</div><h3>Когда выбирать</h3><p>{escape(c['use_when'])}</p><h3>Когда выбрать другую</h3><p>{escape(c['avoid_when'])}</p></div>
<aside class="price"><div class="eyebrow">Бюджетный ориентир</div>{cost}<p>{escape(p['basis'])}</p>{price_source}</aside></section>
<section class="check"><h3>Как проверить на своей задаче</h3><p>{escape(c['try_this'])}</p></section>
<details class="facts"><summary>Сильные стороны, ограничения и источники</summary><h3>Сильные стороны</h3>{bullets(c['strengths'])}<h3>Ограничения</h3>{bullets(c['weaknesses'])}<h3>Бенчмарки</h3>{evidence}<p>О модели: {' · '.join(link(u) for u in c['sources'])}</p>{quote}</details>
<footer>{author} · {date}</footer></article>'''


def render(stream):
    cards, navigation = [], []
    while line := stream.readline(65537):
        if len(line) > 65536:
            raise ValueError('Wiki record exceeds 64 KiB')
        if not line.strip():
            continue
        if len(cards) >= 100:
            raise ValueError('preview is limited to 100 models')
        item = json.loads(line)
        i = len(cards) + 1
        cards.append(card_html(item, i))
        navigation.append(f'<a href="#model-{i}">{escape(item["model"])}</a>')
    if not cards:
        raise ValueError('no Wiki cards')
    return f'''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Wiki моделей · llm-router</title><style>{STYLE}</style></head>
<body><main><header><b>llm-router / Wiki · прототип</b><h1>Где пригодится модель?</h1><p>Задача, ограничения и порядок цен — без выбора подключения.</p><nav aria-label="Модели">{''.join(navigation)}</nav></header>{''.join(cards)}</main></body></html>'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('jsonl', help='JSON Lines produced by research_prices.py --wiki')
    args = parser.parse_args()
    try:
        with open(args.jsonl, 'rb') as file:
            print(render(file))
    except (OSError, ValueError, RecursionError) as error:
        sys.exit(str(error))

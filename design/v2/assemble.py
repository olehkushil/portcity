"""Assemble the Port City App v2 prototype from shell.html and screen fragments, then validate.

Usage: python -X utf8 -I assemble.py [--out PATH]
"""
import re
import sys
import os
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
SHELL = os.path.join(HERE, 'shell.html')
FRAG_DIR = os.path.join(HERE, 'fragments')
ORDER = [
    'screens-rewards-mall.html',      # splash, welcome, onb-car, notif-permission first in demo list; order in DOM is irrelevant for routing
    'screens-parking-full.html',
    'screens-parking-info.html',
    'screens-card.html',
    'screens-promos-events.html',
]
EXPECTED_IDS = [
    'splash', 'welcome', 'onb-car', 'notif-permission',
    'parking-nocar', 'parking-idle', 'parking-free', 'parking', 'parking-pay', 'parking-pay-fail', 'parking-paid', 'parking-receipt', 'parking-overstay', 'parking-closed', 'parking-still',
    'parking-info0', 'parking-info1', 'parking-info2', 'parking-info3', 'parking-info4',
    'parking-service', 'add-car', 'parking-talon', 'where', 'parking-alert',
    'card', 'card-qr', 'card-guest', 'login', 'login-code', 'login-name', 'scan', 'scan-manual', 'scan-result', 'scan-pending', 'scan-rejected', 'history', 'history-parking',
    'promos', 'promo', 'promo-confirm', 'events', 'event', 'ticket',
    'rewards', 'reward', 'reward-confirm', 'vouchers', 'voucher', 'activation', 'activation-done',
    'mall', 'store', 'notifications', 'profile', 'support',
]
VOID = {'meta', 'link', 'br', 'img', 'input', 'hr', 'use', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'source', 'wbr'}


class Balance(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        self.stack.append((tag, self.getpos()))

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.errors.append(('extra close </%s>' % tag, self.getpos()))
            return
        if self.stack[-1][0] == tag:
            self.stack.pop()
            return
        names = [t for t, _ in self.stack]
        if tag in names:
            while self.stack and self.stack[-1][0] != tag:
                t, pos = self.stack.pop()
                self.errors.append(('unclosed <%s>' % t, pos))
            self.stack.pop()
        else:
            self.errors.append(('stray close </%s>' % tag, self.getpos()))


def main():
    out = os.path.join(os.path.dirname(HERE), 'PortCity_App_prototype.html')
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]
    shell = open(SHELL, encoding='utf-8').read()
    frags = []
    problems = []
    for fn in ORDER:
        p = os.path.join(FRAG_DIR, fn)
        if not os.path.exists(p):
            problems.append('MISSING fragment %s' % fn)
            continue
        txt = open(p, encoding='utf-8').read()
        if re.search(r'<(script|style|html|head|body)\b', txt, re.I):
            problems.append('%s contains forbidden tag (script/style/html/head/body)' % fn)
        b = Balance(); b.feed(txt)
        for e, pos in b.errors[:10]:
            problems.append('%s: %s at %s' % (fn, e, pos))
        for t, pos in b.stack[:10]:
            problems.append('%s: unclosed <%s> at %s' % (fn, t, pos))
        frags.append('<!-- ===== %s ===== -->\n%s\n' % (fn, txt.strip()))
    body = '\n'.join(frags)
    if '<!-- SCREENS -->' not in shell:
        problems.append('shell has no <!-- SCREENS --> marker')
    html = shell.replace('<!-- SCREENS -->', body)

    # ids
    ids = re.findall(r'<section[^>]*\bid="([^"]+)"', html)
    for i in EXPECTED_IDS:
        c = ids.count(i)
        if c != 1:
            problems.append('screen id %s appears %d times' % (i, c))
    for i in ids:
        if i not in EXPECTED_IDS:
            problems.append('unexpected screen id %s' % i)
    # data-go targets
    all_ids = set(re.findall(r'\bid="([^"]+)"', html))
    for tgt in sorted(set(re.findall(r'data-go="([^"]+)"', html))):
        if tgt not in all_ids:
            problems.append('data-go target missing: %s' % tgt)
    for tgt in sorted(set(re.findall(r'data-tab-go="([^"]+)"', html))):
        if tgt not in all_ids:
            problems.append('data-tab-go target missing: %s' % tgt)
    for tgt in sorted(set(re.findall(r'data-start-timer="#([^"]+)"', html))):
        if tgt not in all_ids:
            problems.append('data-start-timer target missing: %s' % tgt)
    # symbols
    symbols = set(re.findall(r'<symbol id="([^"]+)"', html))
    for ref in sorted(set(re.findall(r'<use href="#([^"]+)"', html))):
        if ref not in symbols:
            problems.append('unknown symbol #%s' % ref)
    # data-tab values
    for tab in sorted(set(re.findall(r'<section[^>]*data-tab="([^"]*)"', html))):
        if tab not in ('', 'parking', 'card', 'promos', 'rewards', 'mall'):
            problems.append('unknown data-tab value %r' % tab)
    # classes
    css = shell.split('</style>')[0]
    defined = set(re.findall(r'\.([a-zA-Z][\w-]*)', css))
    used = set()
    for cls in re.findall(r'class="([^"]+)"', body):
        used.update(cls.split())
    unknown = sorted(c for c in used if c not in defined and c not in ('on', 'o'))
    if unknown:
        problems.append('classes not defined in shell: %s' % ', '.join(unknown))
    # external images / emoji
    if re.search(r'<img[^>]+src="https?://', body):
        problems.append('external <img> found')
    emo = re.findall(r'[\U0001F300-\U0001FAFF☀-➿]', body)
    if emo:
        problems.append('emoji found: %s' % ''.join(sorted(set(emo))[:10]))
    # sizes
    open(out, 'w', encoding='utf-8').write(html)
    print('assembled ->', out, '(%d KB, %d screens)' % (len(html.encode('utf-8')) // 1024, len(ids)))
    if problems:
        print('PROBLEMS (%d):' % len(problems))
        for p in problems:
            print(' -', p)
        sys.exit(1)
    print('OK: no problems found')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
List the people in a Telegram group from a Telegram Desktop chat export.

How to get the export:
  Telegram Desktop → open the group → ⋮ → Export chat history →
  untick photos/videos/files, Format: "Machine-readable JSON" → Export.
  You get a folder with result.json inside.

Run (Python 3, nothing to install):
  python telegram_members.py path/to/result.json

It writes two files next to result.json:
  telegram_members.csv   one row per person (open in Excel / Google Sheets)
  telegram_members.txt   the same, compact, to paste into a chat

For each person: the permanent Telegram ID (never changes, even if they change
their name or @username), the name shown in the chat (and older names), how many
messages they wrote, first/last time seen, and whether they left the group.
@usernames are not part of Telegram's export.
"""
import csv
import json
import sys
from pathlib import Path


def text_of(value):
    """Names can be plain strings or None in the export."""
    return (value or '').strip()


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else 'result.json')
    if not src.exists():
        sys.exit(f'File not found: {src}\nUsage: python telegram_members.py path/to/result.json')
    with src.open(encoding='utf-8') as f:
        data = json.load(f)

    messages = data.get('messages', [])
    people = {}            # telegram id -> info
    names_without_id = {}  # invited by someone else: the export gives only their name

    def person(uid, name, date):
        p = people.setdefault(uid, {'id': uid, 'names': [], 'messages': 0, 'first': date, 'last': date, 'status': ''})
        if name and name not in p['names']:
            p['names'].append(name)
        if date:
            p['first'] = min(p['first'] or date, date)
            p['last'] = max(p['last'] or date, date)
        return p

    for m in messages:
        date = (m.get('date') or '')[:10]
        if m.get('type') == 'message':
            fid = str(m.get('from_id') or '')
            if fid.startswith('user'):
                person(fid[4:], text_of(m.get('from')), date)['messages'] += 1
        elif m.get('type') == 'service':
            aid = str(m.get('actor_id') or '')
            actor = text_of(m.get('actor'))
            action = m.get('action')
            members = [text_of(x) for x in (m.get('members') or []) if text_of(x)]
            if aid.startswith('user'):
                p = person(aid[4:], actor, date)
                if action in ('join_group_by_link', 'join_group_by_request', 'create_group'):
                    p['status'] = 'joined'
                elif action == 'remove_members' and actor in members:
                    p['status'] = 'left'          # left by themselves
            if action == 'invite_members':
                for n in members:
                    names_without_id.setdefault(n, date)
            if action == 'remove_members':
                for n in members:
                    if n != actor:
                        names_without_id.setdefault(n + ' (removed)', date)

    rows = sorted(people.values(), key=lambda p: (-p['messages'], p['names'][0] if p['names'] else ''))
    # names we already know with an id don't need the "without id" list
    known_names = {n for p in people.values() for n in p['names']}
    leftovers = {n: d for n, d in names_without_id.items() if n.replace(' (removed)', '') not in known_names}

    out_csv = src.with_name('telegram_members.csv')
    with out_csv.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(['telegram_id', 'name', 'other_names', 'messages', 'first_seen', 'last_seen', 'status'])
        for p in rows:
            w.writerow([p['id'], p['names'][-1] if p['names'] else '', ' | '.join(p['names'][:-1]),
                        p['messages'], p['first'], p['last'], p['status']])

    out_txt = src.with_name('telegram_members.txt')
    lines = [f"# {data.get('name', 'group')}: {len(rows)} people with a Telegram ID",
             '# id;name;other names;messages;last seen;status']
    for p in rows:
        lines.append(';'.join([p['id'], p['names'][-1] if p['names'] else '', ' | '.join(p['names'][:-1]),
                               str(p['messages']), p['last'], p['status']]))
    if leftovers:
        lines.append(f'# {len(leftovers)} names without an ID (added by someone else, never wrote):')
        lines += [f'-;{n};;0;{d};' for n, d in sorted(leftovers.items())]
    out_txt.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    left = sum(1 for p in rows if p['status'] == 'left')
    print(f'{len(rows)} people with a Telegram ID ({left} left the group), {len(leftovers)} names without an ID.')
    print(f'Saved: {out_csv}\n       {out_txt}  ← paste this one to Claude')


if __name__ == '__main__':
    main()

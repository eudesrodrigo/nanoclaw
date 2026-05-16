#!/usr/bin/env python3
"""
Pre-check script for Costco receipt monitoring.
Calls the host http-clients service instead of importing the package directly.
Returns wakeAgent: true only when new receipts are found.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

HOST_URL = os.environ.get('HTTP_CLIENTS_URL', '')
STATE_FILE = Path(__file__).parent / 'state.json'
PROFILES = ['eudes', 'magda']


def call_host(service, command, **args):
    if not HOST_URL:
        raise RuntimeError('HTTP_CLIENTS_URL not set')
    payload = json.dumps({'service': service, 'command': command, 'args': args}).encode()
    req = urllib.request.Request(
        f'{HOST_URL}/call',
        data=payload,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {p: [] for p in PROFILES}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def get_recent_receipts(profile, days=3):
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days)
    result = call_host(
        'costco', 'receipts',
        profile=profile,
        type='warehouse',
        sub_type='all',
        start=start_date.strftime('%Y-%m-%d'),
        end=end_date.strftime('%Y-%m-%d'),
    )
    if result.get('status') != 'ok':
        raise RuntimeError(f"Host service error: {result.get('message', result)}")
    data = result.get('data', {})
    if isinstance(data, dict):
        return data.get('receiptsWithCounts', {}).get('receipts', [])
    return []


def main():
    state = load_state()
    new_receipts = {}

    for profile in PROFILES:
        try:
            receipts = get_recent_receipts(profile)
            known = set(state.get(profile, []))
            found = []
            for r in receipts:
                barcode = r.get('transactionBarcode')
                if barcode and barcode not in known:
                    found.append({
                        'barcode': barcode,
                        'date': r.get('transactionDateTime', ''),
                        'total': r.get('total', 0),
                        'profile': profile,
                    })
            if found:
                new_receipts[profile] = found
                updated = list(known) + [r['barcode'] for r in found]
                state[profile] = updated[-100:]
        except Exception as e:
            sys.stderr.write(f'[{profile}] {e}\n')

    if new_receipts:
        save_state(state)
        print(json.dumps({'wakeAgent': True, 'data': {'new_receipts': new_receipts}}))
    else:
        print(json.dumps({'wakeAgent': False}))


if __name__ == '__main__':
    main()

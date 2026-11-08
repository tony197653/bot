/**
 * Patched open-table rows must join via delegated #mpOpenList listener.
 * Every close path must delete pokerLobby/{roomId}.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openRowHtml,
  patchOpenTables,
  wireOpenTablesDelegate,
} from '../js/ui/lobby.js';
import {
  noteLobbyRoomClosed,
  isLobbyRoomSuppressed,
  _resetLobbyClosedSuppress,
  sortLobbyListings,
} from '../js/net/room.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Minimal DOM enough for patchOpenTables + delegated clicks. */
function miniDom() {
  globalThis.CSS = globalThis.CSS || {
    escape: (s) => String(s).replace(/"/g, '\\"'),
  };
  const listeners = new WeakMap();
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: Object.create(null),
      dataset: Object.create(null),
      parentNode: null,
      disabled: false,
      textContent: '',
      classList: {
        _s: new Set(),
        toggle(c, on) {
          if (on) this._s.add(c);
          else this._s.delete(c);
        },
        contains(c) {
          return this._s.has(c);
        },
        add(c) {
          this._s.add(c);
        },
        remove(c) {
          this._s.delete(c);
        },
      },
      get hidden() {
        return !!this._hidden;
      },
      set hidden(v) {
        this._hidden = !!v;
      },
      get firstChild() {
        return this.children[0] || null;
      },
      get firstElementChild() {
        return this.children[0] || null;
      },
      get nextSibling() {
        if (!this.parentNode) return null;
        const sibs = this.parentNode.children;
        const i = sibs.indexOf(this);
        return i >= 0 ? sibs[i + 1] || null : null;
      },
      getAttribute(n) {
        return this.attributes[n] ?? null;
      },
      setAttribute(n, v) {
        this.attributes[n] = String(v);
        if (n === 'data-rid') this.dataset.rid = String(v);
        if (n === 'data-act') this.dataset.act = String(v);
        if (n.startsWith('data-')) {
          const key = n
            .slice(5)
            .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[key] = String(v);
        }
      },
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel === '[data-act="open-table"]' && cur.attributes['data-act'] === 'open-table') {
            return cur;
          }
          if (sel === 'li' && cur.tagName === 'LI') return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentNode;
        }
        return false;
      },
      querySelector(sel) {
        const all = this.querySelectorAll(sel);
        return all[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          if (!n || !n.tagName) return;
          if (match(n, sel)) out.push(n);
          for (const c of n.children) walk(c);
        };
        walk(this);
        return out;
      },
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
      },
      insertBefore(c, ref) {
        c.parentNode?.children &&
          (c.parentNode.children = c.parentNode.children.filter((x) => x !== c));
        c.parentNode = this;
        if (!ref) this.children.push(c);
        else {
          const i = this.children.indexOf(ref);
          if (i < 0) this.children.push(c);
          else this.children.splice(i, 0, c);
        }
        return c;
      },
      remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
        this.parentNode = null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(this)) listeners.set(this, []);
        listeners.get(this).push({ type, fn });
      },
      dispatchEvent(ev) {
        const list = listeners.get(this) || [];
        for (const { type, fn } of list) {
          if (type === ev.type) fn(ev);
        }
        // bubble
        if (this.parentNode) this.parentNode.dispatchEvent?.({ ...ev, target: ev.target });
      },
      set innerHTML(html) {
        this.children = [];
        this._html = html;
        // Parse openRowHtml: <li><button ... data-act="open-table" data-rid="...">
        const rid = /data-rid="([^"]+)"/.exec(html)?.[1];
        const act = /data-act="([^"]+)"/.exec(html)?.[1];
        if (rid && act === 'open-table') {
          const li = el('li');
          const btn = el('button');
          btn.setAttribute('data-act', 'open-table');
          btn.setAttribute('data-rid', rid);
          btn.classList.add('mp-row');
          // nest chrome used by patchOneOpenRow
          const l1 = el('span');
          l1.classList.add('mp-l1');
          const b = el('b');
          b.textContent = 't';
          l1.appendChild(b);
          const txt = el('span');
          txt.classList.add('mp-txt');
          txt.appendChild(l1);
          txt.appendChild(el('em'));
          btn.appendChild(txt);
          const side = el('span');
          side.classList.add('mp-row-side');
          const blinds = el('span');
          blinds.classList.add('mp-blinds');
          const seats = el('span');
          seats.classList.add('mp-seats');
          const pips = el('span');
          pips.classList.add('mp-pips');
          for (let i = 0; i < 6; i++) pips.appendChild(el('i'));
          const n = el('span');
          n.classList.add('mp-n');
          n.textContent = '0/6';
          seats.appendChild(pips);
          seats.appendChild(n);
          const go = el('span');
          go.classList.add('mp-go');
          go.textContent = '加入';
          side.appendChild(blinds);
          side.appendChild(seats);
          side.appendChild(go);
          btn.appendChild(side);
          li.appendChild(btn);
          this.appendChild(li);
        }
      },
      get innerHTML() {
        return this._html || '';
      },
    };
    return node;
  }
  function match(n, sel) {
    if (sel === '.mp-row') return n.classList.contains('mp-row');
    if (sel.startsWith('.mp-row[data-rid=')) {
      const id = sel.match(/data-rid="([^"]+)"/)?.[1];
      return n.classList.contains('mp-row') && n.getAttribute('data-rid') === id;
    }
    if (sel === '.mp-l1 b') return n.tagName === 'B';
    if (sel === '.mp-txt em') return n.tagName === 'EM';
    if (sel === '.mp-blinds') return n.classList.contains('mp-blinds');
    if (sel === '.mp-go') return n.classList.contains('mp-go');
    if (sel === '.mp-pips i') return n.tagName === 'I';
    if (sel === '.mp-n') return n.classList.contains('mp-n');
    if (sel === '.mp-lobby') return n.classList.contains('mp-lobby');
    if (sel === '#mpOpenList') return n.id === 'mpOpenList';
    if (sel === '#mpOpenEmpty') return n.id === 'mpOpenEmpty';
    if (sel === '#mpOpenN') return n.id === 'mpOpenN';
    if (sel === 'li') return n.tagName === 'LI';
    return false;
  }
  // Patch lobby.js $ to use our root — we pass root with querySelector
  const root = el('div');
  root.classList.add('mp-lobby');
  const list = el('ul');
  list.id = 'mpOpenList';
  list.dataset = Object.create(null);
  const empty = el('div');
  empty.id = 'mpOpenEmpty';
  const count = el('span');
  count.id = 'mpOpenN';
  root.appendChild(list);
  root.appendChild(empty);
  root.appendChild(count);
  root.querySelector = (sel) => {
    if (sel === '#mpOpenList') return list;
    if (sel === '#mpOpenEmpty') return empty;
    if (sel === '#mpOpenN') return count;
    if (sel === '.mp-lobby') return root;
    return list.querySelector(sel) || empty.querySelector(sel);
  };
  // document.createElement used by patchOpenTables
  globalThis.document = {
    createElement: (tag) => el(tag),
  };
  return { root, list, empty, count, el };
}

describe('open-table delegated click (patched rows)', () => {
  it('insert via patchOpenTables still fires onOpenTable (no per-row bind)', () => {
    const { root, list } = miniDom();
    const hits = [];
    wireOpenTablesDelegate(list, (rid) => hits.push(rid));
    assert.equal(list.dataset.mpOpenWired, '1');

    // Second wire must not stack handlers
    wireOpenTablesDelegate(list, (rid) => hits.push(`b:${rid}`));

    const ok = patchOpenTables(root, [
      {
        id: 'rNew',
        name: '新桌',
        code: '123',
        blinds: '10/20',
        seated: 1,
        status: 'lobby',
        hostName: 'H',
        hostPhoto: '',
        createdAtMs: 1,
      },
    ]);
    assert.equal(ok, true);
    const btn = list.querySelector('.mp-row[data-rid="rNew"]');
    assert.ok(btn, 'row inserted');

    // Simulate click on nested child bubbling to list
    const go = btn.querySelector('.mp-go');
    list.dispatchEvent({
      type: 'click',
      target: go || btn,
      key: undefined,
      preventDefault() {},
    });
    assert.deepEqual(hits, ['b:rNew'], 'single delegated handler (latest callback)');
  });

  it('source: no per-row open-table forEach; uses wireOpenTablesDelegate', () => {
    const lobby = read('js/ui/lobby.js');
    assert.match(lobby, /export function wireOpenTablesDelegate/);
    assert.match(lobby, /wireOpenTablesDelegate\(\$\('#mpOpenList'/);
    assert.doesNotMatch(
      lobby,
      /querySelectorAll\('\[data-act="open-table"\]'\)\.forEach/,
    );
  });
});

describe('close paths delete pokerLobby listing', () => {
  it('closeRoom / settle / auto-close / host-closed all call deleteLobbyListing', () => {
    const room = read('js/net/room.js');
    // closeRoom: delete even when already closed or missing
    const closeFn = room.slice(
      room.indexOf('export async function closeRoom'),
      room.indexOf('export async function maybeAutoCloseIdleRoom'),
    );
    assert.equal(
      (closeFn.match(/deleteLobbyListing/g) || []).length >= 3,
      true,
      'closeRoom must delete on missing, already-closed, and fresh close',
    );
    assert.match(closeFn, /status === 'closed'[\s\S]*deleteLobbyListing/);

    const auto = room.slice(
      room.indexOf('export async function maybeAutoCloseIdleRoom'),
      room.indexOf('export function listenOpenTables'),
    );
    assert.match(auto, /closeRoom\(/);

    const host = read('js/net/host.js');
    assert.match(host, /listStatus === 'closed'[\s\S]*deleteLobbyListing|deleteLobbyListing[\s\S]*listStatus === 'closed'/);
    assert.match(host, /syncLobbyListingDoc/);

    const ledger = read('js/net/ledger.js');
    const settle = ledger.slice(
      ledger.indexOf('export async function settleClosedRoomBinding'),
      ledger.indexOf('export async function selfRescueCashout'),
    );
    assert.match(settle, /deleteLobbyListing/);
  });

  it('listenOpenTables suppresses closed / noted-closed ids', () => {
    _resetLobbyClosedSuppress();
    assert.equal(isLobbyRoomSuppressed('rX'), false);
    noteLobbyRoomClosed('rX');
    assert.equal(isLobbyRoomSuppressed('rX'), true);

    const room = read('js/net/room.js');
    const listen = room.slice(
      room.indexOf('export function listenOpenTables'),
      room.indexOf('export function listenRoom'),
    );
    assert.match(listen, /closedLobbySuppress/);
    assert.match(listen, /status === 'closed'/);
    _resetLobbyClosedSuppress();
  });

  it('cashout/leave/takeover-void do not close room (listing stays until closeRoom)', () => {
    const host = read('js/net/host.js');
    const cashout = host.slice(
      host.indexOf('async function cashoutSeat'),
      host.indexOf('async function approveTopUp'),
    );
    assert.doesNotMatch(cashout, /closeRoom\(/);
    assert.doesNotMatch(cashout, /status:\s*'closed'/);

    const voidFn = host.slice(
      host.indexOf('function voidHand'),
      host.indexOf('function onTick'),
    );
    assert.doesNotMatch(voidFn, /closeRoom\(/);
    assert.doesNotMatch(voidFn, /deleteLobbyListing/);

    const presence = read('js/net/presence.js');
    const take = presence.slice(
      presence.indexOf('export async function maybeTakeover'),
      presence.indexOf('export const PRESENCE_MS'),
    );
    assert.doesNotMatch(take, /status:\s*'closed'/);
    assert.doesNotMatch(take, /deleteLobbyListing/);
  });
});

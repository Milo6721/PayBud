(function (root) {
  'use strict';

  // "24,50" / "24.5" / "1 234,5" -> grosze (int) albo null gdy niepoprawne lub <= 0
  function parseMoney(str) {
    var s = String(str == null ? '' : str).trim().replace(/\s/g, '').replace(',', '.');
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
    var c = Math.round(parseFloat(s) * 100);
    return c > 0 ? c : null;
  }

  function fmt(cents) {
    var neg = cents < 0, a = Math.abs(cents);
    var zl = Math.floor(a / 100), gr = a % 100;
    var s = String(zl).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + ',' + String(gr).padStart(2, '0') + '\u00a0zł';
    return (neg ? '\u2212' : '') + s;
  }

  // Dzieli kwotę po równo; reszta groszy trafia do pierwszych osób. Suma zawsze = total.
  function splitEqual(total, ids) {
    var n = ids.length, base = Math.floor(total / n), rest = total - base * n;
    return ids.map(function (id) {
      var extra = rest > 0 ? 1 : 0; if (rest > 0) rest--;
      return { user_id: id, share_cents: base + extra };
    });
  }

  // Pozycje z paragonu -> udziały. items: [{cents, who:[userId]}], puste who = wszyscy.
  function sharesFromItems(items, allIds) {
    var map = {};
    allIds.forEach(function (i) { map[i] = 0; });
    items.forEach(function (it) {
      var who = it.who && it.who.length ? it.who : allIds;
      splitEqual(it.cents, who).forEach(function (s) { map[s.user_id] += s.share_cents; });
    });
    return Object.keys(map).filter(function (k) { return map[k] > 0; })
      .map(function (k) { return { user_id: k, share_cents: map[k] }; });
  }

  // Zachłannie paruje największego dłużnika z największym wierzycielem.
  // Daje co najwyżej (liczba osób - 1) przelewów. bals: [{user_id, cents}] (+ = należy się).
  function computeTransfers(bals) {
    var cred = bals.filter(function (b) { return b.cents > 0; })
      .map(function (b) { return { user_id: b.user_id, cents: b.cents }; })
      .sort(function (a, b) { return b.cents - a.cents; });
    var debt = bals.filter(function (b) { return b.cents < 0; })
      .map(function (b) { return { user_id: b.user_id, cents: -b.cents }; })
      .sort(function (a, b) { return b.cents - a.cents; });
    var out = [], i = 0, j = 0;
    while (i < cred.length && j < debt.length) {
      var x = Math.min(cred[i].cents, debt[j].cents);
      out.push({ from: debt[j].user_id, to: cred[i].user_id, cents: x });
      cred[i].cents -= x; debt[j].cents -= x;
      if (cred[i].cents === 0) i++;
      if (debt[j].cents === 0) j++;
    }
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function hue(str) {
    var h = 0; str = String(str || '');
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  var api = { parseMoney: parseMoney, fmt: fmt, splitEqual: splitEqual, sharesFromItems: sharesFromItems,
              computeTransfers: computeTransfers, esc: esc, hue: hue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PB = api;
})(typeof window !== 'undefined' ? window : globalThis);

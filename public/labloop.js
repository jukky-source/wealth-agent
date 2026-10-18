// /lab の下に出す「試行錯誤の台帳」。lab loop が毎ラウンド残した
// 壁 → 打ち手 → 判定 を、認証なしの要約から描く（実データのみ）。
const host = document.getElementById('loop-ledger');
if (host) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cls = (v) => (v === 'improved' ? 'ok' : v === 'regressed' ? 'bad' : '');
  host.innerHTML = '<div class="card" style="margin-top:16px"><p class="sec-t">試行錯誤の台帳（lab loop）</p><p class="hint" id="ll-msg">読み込み中…</p><div id="ll-body"></div></div>';
  const body = document.getElementById('ll-body');
  fetch('/api/lab/loop/public', { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      const rows = (d.recent || []).slice(0, 10);
      const walls = Object.entries(d.byWall || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
      document.getElementById('ll-msg').innerHTML = '累計 ' + n(d.rounds) + ' ラウンド / 無変化 ' + n(d.stall) + ' 連続' +
        (walls.length ? ' ／ よく当たる壁: ' + walls.map(([k, v]) => esc(k) + '×' + n(v)).join('・') : '');
      if (!rows.length) { body.innerHTML = '<p class="hint">まだ記録がありません（cron が15分ごとに1ラウンド回します）。</p>'; return; }
      body.innerHTML = '<table><thead><tr><th>時刻</th><th>モード</th><th>壁</th><th>打ち手</th><th>判定</th><th>メモ</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td class="mono">' + esc(String(r.at || '').slice(5, 16).replace('T', ' ')) + '</td><td>' + esc(r.mode) + '</td><td>' + esc(r.wall) + '</td><td class="mono">' + esc(r.action) + '</td><td class="' + cls(r.verdict) + '">' + esc(r.verdict) + '</td><td>' + esc(r.note) + '</td></tr>').join('') +
        '</tbody></table>';
    })
    .catch((e) => { document.getElementById('ll-msg').innerHTML = '<span class="bad">読めません: ' + esc(e.message) + '</span>'; });
}

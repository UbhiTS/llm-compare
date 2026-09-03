// ---------------------------------------------------------------------------
// public/modules/visualizers.js — Interactive in-browser task visualizers
// ---------------------------------------------------------------------------

// Parse "Move disk K from X to Y" lines out of a program's stdout.
function parseHanoiMoves(stdout) {
  const moves = [];
  (stdout || '').split(/\r?\n/).forEach((line) => {
    const m = /move\s+disk\s+(\d+)\s+from\s+([A-Za-z0-9]+)\s+to\s+([A-Za-z0-9]+)/i.exec(line);
    if (m) moves.push({ disk: +m[1], from: m[2], to: m[3] });
  });
  return moves;
}

// Animate the parsed moves on 3 pegs; validate each move and the final state.
function renderHanoiViz(host, moves, rawStdout, foot) {
  const gen = (host._gen || 0) + 1; host._gen = gen;
  const alive = () => host._gen === gen && document.body.contains(host);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const pegs = [...new Set(moves.flatMap((m) => [m.from, m.to]))].sort();
  const pegIndex = {}; pegs.forEach((p, i) => { pegIndex[p] = i; });
  const N = Math.max(...moves.map((m) => m.disk));
  const source = moves[0].from;
  const target = moves[moves.length - 1].to;

  const H = 150, diskH = 15, gap = 2, baseY = 20;
  const liftedY = H - diskH - 4;
  const cx = (i) => ((i + 0.5) / pegs.length) * 100;
  const wpct = (d) => 7 + (d / N) * 19;
  const leftPct = (i, d) => cx(i) - wpct(d) / 2;
  const stackY = (idx) => baseY + idx * (diskH + gap);
  const palette = ['#5b9bff', '#10a37f', '#d97757', '#c084fc', '#fbbf24', '#22d3ee', '#f472b6', '#a3e635'];
  const diskColor = (d) => palette[(d - 1) % palette.length];

  host.innerHTML =
    `<div class="hanoi-board" style="height:${H}px">` +
      pegs.map((p, i) =>
        `<div class="hanoi-rod" style="left:${cx(i)}%"></div>` +
        `<div class="hanoi-peglabel" style="left:${cx(i)}%">${esc(p)}</div>`).join('') +
      `<div class="hanoi-base"></div>` +
      Array.from({ length: N }, (_, k) => {
        const d = k + 1;
        return `<div class="hanoi-disk" data-disk="${d}" style="width:${wpct(d)}%;height:${diskH}px;background:${diskColor(d)}">${d}</div>`;
      }).join('') +
    `</div>` +
    `<div class="hanoi-caption">Ready — ${moves.length} moves, ${N} disks (start on ${esc(source)}, finish on ${esc(target)}).</div>` +
    `<div class="hanoi-controls"><button type="button" class="hanoi-replay">↻ Replay</button>` +
      `<details class="hanoi-raw"><summary>raw output</summary><pre><code>${esc(rawStdout.replace(/\s+$/, ''))}\n\n${esc(foot)}</code></pre></details></div>`;

  const diskEls = {};
  host.querySelectorAll('.hanoi-disk').forEach((el) => { diskEls[+el.dataset.disk] = el; });
  const cap = host.querySelector('.hanoi-caption');
  const state = {};

  const placeInitial = () => {
    pegs.forEach((p) => { state[p] = []; });
    for (let d = N; d >= 1; d--) state[source].push(d);
    pegs.forEach((p) => state[p].forEach((d, idx) => {
      const el = diskEls[d];
      el.style.transition = 'none';
      el.style.left = leftPct(pegIndex[p], d) + '%';
      el.style.bottom = stackY(idx) + 'px';
      el.classList.remove('bad');
    }));
    void host.offsetWidth; // reflow so the snap isn't animated
    host.querySelectorAll('.hanoi-disk').forEach((el) => { el.style.transition = ''; });
  };

  let i = 0, invalid = 0;
  // Adaptive pace: leisurely for a few moves, brisk for many (8 disks = 255 moves).
  const STEP = Math.max(60, Math.min(650, Math.round(9000 / moves.length)));
  const slideAt = Math.round(STEP * 0.30);
  const dropAt = Math.round(STEP * 0.60);
  host.style.setProperty('--disk-trans', Math.max(40, Math.min(180, Math.round(STEP * 0.5))) + 'ms');

  const play = () => {
    if (!alive()) return;
    if (i >= moves.length) {
      const ok = invalid === 0 && state[target].length === N;
      cap.textContent = ok
        ? `✓ Solved — ${moves.length} moves, every move valid, all ${N} disks on ${target}.`
        : `✗ ${invalid ? invalid + ' invalid move(s)' : 'finished but not all disks on ' + target}.`;
      cap.className = 'hanoi-caption ' + (ok ? 'good' : 'bad');
      return;
    }
    const mv = moves[i];
    const fromStack = state[mv.from] || [], toStack = state[mv.to] || [];
    const valid = fromStack[fromStack.length - 1] === mv.disk && (!toStack.length || toStack[toStack.length - 1] > mv.disk);
    if (!valid) invalid++;
    if (fromStack.length) fromStack.pop();
    const toIndex = toStack.length;
    toStack.push(mv.disk);
    const el = diskEls[mv.disk];
    if (!valid && el) el.classList.add('bad');
    if (el) {
      el.style.bottom = liftedY + 'px';                                              // lift
      setTimeout(() => { if (alive()) el.style.left = leftPct(pegIndex[mv.to], mv.disk) + '%'; }, slideAt); // slide
      setTimeout(() => { if (alive()) el.style.bottom = stackY(toIndex) + 'px'; }, dropAt);                 // drop
    }
    cap.textContent = `Move ${i + 1}/${moves.length}: disk ${mv.disk}  ${mv.from} → ${mv.to}` + (valid ? '' : '  ✗ INVALID');
    cap.className = 'hanoi-caption' + (valid ? '' : ' bad');
    i++;
    setTimeout(() => { if (alive()) play(); }, STEP);
  };

  host.querySelector('.hanoi-replay').addEventListener('click', () => renderHanoiViz(host, moves, rawStdout, foot));
  placeInitial();
  setTimeout(() => { if (alive()) play(); }, 450);
}

if (typeof window !== 'undefined') {
  window.parseHanoiMoves = parseHanoiMoves;
  window.renderHanoiViz = renderHanoiViz;
}

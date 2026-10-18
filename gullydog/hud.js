/*
 * hud.js — everything drawn over the 3D view, as plain DOM.
 *
 * Needs, the clock, today's tasks, the action prompt, toasts, the minimap,
 * speech bubbles that follow people's heads, and the screens (start, pause,
 * help, day summary). It reads the sim and never writes to it; anything the
 * player decides here comes back to main.js through callbacks.
 */

import { m4Project, clamp, dist2, hex } from './util.js';
import { GRID, SURF, LAYOUT } from './world.js';
import { DOG_NAME } from './data.js';
import { taskTarget } from './tasks.js';

const $ = (id) => document.getElementById(id);

const NEEDS = [
  ['hunger', 'Food'], ['thirst', 'Water'], ['energy', 'Energy'], ['mood', 'Mood'], ['health', 'Health'],
];

const WEATHER_LABEL = { clear: 'Sunny', hazy: 'Hazy', rain: 'Monsoon rain', holi: 'Holi!', diwali: 'Diwali' };

export class Hud {
  constructor(W) {
    this.W = W;
    this.el = {
      time: $('time'), day: $('day'), weather: $('weather'), zone: $('zone'), rank: $('rank'), cred: $('credn'),
      tasks: $('tasks'), taskList: $('taskList'), prompt: $('prompt'), promptKey: $('promptKey'), promptText: $('promptText'),
      toasts: $('toasts'), bubbles: $('bubbles'), arrow: $('arrow'), vignette: $('vignette'), sleep: $('sleep'),
      actLabel: $('actLabel'), minimap: $('minimap'), needs: {}, credBox: $('credBox'),
    };
    for (const [k] of NEEDS) {
      const row = document.querySelector(`.need[data-k="${k}"]`);
      this.el.needs[k] = { row, bar: row.querySelector('i'), last: -1 };
    }
    this.mm = this.el.minimap.getContext('2d');
    this.mapImg = this.renderMap();
    this.bubblePool = [];
    this.toastQ = [];
    this.taskKey = '';
    this.zoneShown = '';
    this.zoneT = 0;
    this.vig = 0;
    this.touch = false;
  }

  /* ------------------------------------------------------------ minimap */

  renderMap() {
    const W = this.W, N = GRID.n;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N);
    const col = {
      [SURF.ROAD]: [70, 70, 80], [SURF.CROSS]: [210, 210, 210], [SURF.WALK]: [176, 164, 142], [SURF.GALI]: [160, 148, 128],
      [SURF.PLAZA]: [196, 182, 152], [SURF.DIRT]: [176, 140, 96], [SURF.ISLAND]: [110, 160, 80], [SURF.MARKET]: [170, 150, 118],
      [SURF.BUILDING]: [96, 86, 82], [SURF.MASS]: [96, 86, 82],
    };
    for (let i = 0; i < N * N; i++) {
      const c3 = col[W.surf[i]] || [0, 0, 0];
      img.data[i * 4] = c3[0]; img.data[i * 4 + 1] = c3[1]; img.data[i * 4 + 2] = c3[2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // tint the buildings with their paint, faintly
    for (const b of W.buildings) {
      const [r, gg, bb] = b.wall;
      g.fillStyle = `rgba(${(r * 255) | 0},${(gg * 255) | 0},${(bb * 255) | 0},0.35)`;
      g.fillRect((b.x0 + 100) * 2, (b.z0 + 100) * 2, (b.x1 - b.x0) * 2, (b.z1 - b.z0) * 2);
    }
    // landmarks
    g.fillStyle = '#f28c28';
    g.fillRect((-41 + 100) * 2, (-49.5 + 100) * 2, 20, 16);
    g.fillStyle = '#efe2c4';
    g.beginPath(); g.arc(200, 200, 4, 0, Math.PI * 2); g.fill();
    return c;
  }

  drawMinimap(S, cam) {
    const g = this.mm;
    const cw = this.el.minimap.width, ch = this.el.minimap.height;
    const d = S.dog;
    const k = cw / 150;            // the canvas is drawn at 2x for sharp edges
    const scale = 1.25 * k;        // map pixels (2 per metre) to minimap pixels: ~60 m radius
    g.save();
    g.clearRect(0, 0, cw, ch);
    g.beginPath(); g.arc(cw / 2, ch / 2, cw / 2 - 1, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#2b2622'; g.fillRect(0, 0, cw, ch);
    g.translate(cw / 2, ch / 2);
    // heading-up: the camera looks along (-sin yaw, -cos yaw) in (x, z); a rotation
    // of exactly yaw carries that direction to screen-up
    g.rotate(cam.yaw);
    g.scale(scale, scale);
    g.drawImage(this.mapImg, -(d.x + 100) * 2, -(d.z + 100) * 2);
    // blips (in map pixels relative to the dog)
    const blip = (x, z, color, r) => {
      g.fillStyle = color;
      g.beginPath(); g.arc((x - d.x) * 2, (z - d.z) * 2, (r * k) / scale, 0, Math.PI * 2); g.fill();
    };
    for (const q of S.dogs) {
      if (q.puppy) continue;
      const fr = S.friendship[q.key] || 0;
      blip(q.x, q.z, fr >= S.C.animals.friendAt ? '#7fd1ff' : fr < 30 ? '#ff6b5a' : '#e0b070', 3.2);
    }
    for (const c of S.cows) blip(c.x, c.z, '#f4f1e8', 2.6);
    for (const it of S.items) if (it.state === 'ground' && it.kind !== 'ball' && it.kind !== 'chappal') blip(it.x, it.z, '#ffd23f', 2.2);
    const t = taskTarget(S);
    if (t) {
      const pulse = 4 + Math.sin(performance.now() / 180) * 1.2;
      blip(t.x, t.z, '#ffd700', pulse);
    }
    g.restore();
    // the dog, always at the centre, pointing where it faces relative to the camera
    g.save();
    g.translate(cw / 2, ch / 2);
    g.rotate(-(d.yaw - cam.yaw) + Math.PI);
    g.scale(k, k);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2.5); g.lineTo(-5, 5); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // north marker on the rim: world -Z rotated by yaw lands at (sin yaw, -cos yaw)
    g.fillStyle = '#ffd23f';
    g.font = `bold ${11 * k}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', cw / 2 + Math.sin(cam.yaw) * (cw / 2 - 9 * k), ch / 2 - Math.cos(cam.yaw) * (ch / 2 - 9 * k));
  }

  /* -------------------------------------------------------------- toasts */

  toast(text, kind = '', time = 3.2) {
    const div = document.createElement('div');
    div.className = 'toast ' + kind;
    div.textContent = text;
    this.el.toasts.appendChild(div);
    requestAnimationFrame(() => div.classList.add('in'));
    setTimeout(() => { div.classList.remove('in'); div.classList.add('out'); }, time * 1000);
    setTimeout(() => div.remove(), time * 1000 + 600);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild.remove();
  }

  handle(events, S) {
    for (const e of events) {
      switch (e.type) {
        case 'taskDone': this.toast(`✓ ${e.title}  +${e.reward} cred`, 'good'); break;
        case 'allTasksDone': this.toast('All of today\'s tasks done! What a dog.', 'gold', 4); break;
        case 'rank': this.toast(`New title: ${e.title}!`, 'gold', 4.5); break;
        case 'collar': this.toast('Aunty tied a red collar on you. Everyone knows you now.', 'gold', 5); break;
        case 'friend': this.toast(`${e.name} is your friend now! Friends follow you around.`, 'good', 4.5); break;
        case 'greeted': if (e.friendship < S.C.animals.friendAt) this.toast(`${e.name} sniffs you. (${Math.round(e.friendship)}% friends)`, '', 2.2); break;
        case 'sharedFood': this.toast(`You shared food with ${e.puppy ? 'a puppy' : e.name}.`, 'good'); break;
        case 'hit': this.vig = 1; this.toast(`Ouch! Hit by a${/^[aeiou]/.test(e.vtype) ? 'n' : ''} ${e.vtype}.`, 'bad', 2.4); break;
        case 'nipped': this.vig = 0.6; this.toast(`${e.name} bit you! Get out of their patch.`, 'bad', 2.6); break;
        case 'caught': this.toast('Caught! The halwai took his samosa back.', 'bad'); break;
        case 'escaped': this.toast('Got away with it! Now eat it before someone else does.', 'good'); break;
        case 'stole': this.toast('Run!', 'bad', 1.2); break;
        case 'faint': this.toast('You fainted... Aunty found you and nursed you back.', 'bad', 5); break;
        case 'auntyCall': if (!e.again) this.toast('Aunty is calling — food at Pump Wala Chowk!', 'gold', 4); break;
        case 'aarti': this.toast('Evening aarti at the temple. The pujari has prasad.', '', 4); break;
        case 'fetch': this.toast('The kids cheer! Fetch!', 'good'); break;
        case 'queasy': this.toast('Ugh. That did not agree with you.', 'bad', 2.2); break;
        case 'shooed': if (S.rng && Math.random() < 0.5) this.toast('Shooed away.', '', 1.6); break;
        case 'nothingLeft': this.toast('The tray is empty.', '', 1.8); break;
        case 'newDay': this.toast(`Day ${e.day} — ${WEATHER_LABEL[e.weather] || e.weather}`, 'gold', 3.5); break;
        case 'cowMoved': if (e.fromRoad && e.byDog) this.toast('The cow ambles off the road. Traffic thanks you.', 'good'); break;
        case 'bikeChase': this.toast('Chased that scooter right off!', 'good', 2.4); break;
        case 'crossed': break;
        default:
      }
    }
  }

  /* ------------------------------------------------------------- per frame */

  update(S, cam, vp, canvas, dt, ctxAction) {
    const d = S.dog;
    // needs
    for (const [k] of NEEDS) {
      const v = Math.round(d.needs[k]);
      const n = this.el.needs[k];
      if (v !== n.last) {
        n.last = v;
        n.bar.style.width = v + '%';
        n.row.classList.toggle('low', v < 25);
        n.row.classList.toggle('mid', v >= 25 && v < 50);
      }
    }
    // clock
    const h = S.clock.hours;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60 / 5) * 5;
    const ap = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    const tStr = `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
    if (this.el.time.textContent !== tStr) this.el.time.textContent = tStr;
    const dStr = 'Day ' + S.clock.day;
    if (this.el.day.textContent !== dStr) this.el.day.textContent = dStr;
    const wStr = WEATHER_LABEL[S.weather] || '';
    if (this.el.weather.textContent !== wStr) this.el.weather.textContent = wStr;
    // zone name: fades in when it changes
    if (d.zone !== this.zoneShown) { this.zoneShown = d.zone; this.el.zone.textContent = d.zone; this.el.zone.classList.remove('show'); void this.el.zone.offsetWidth; this.el.zone.classList.add('show'); }
    // cred
    const rankTitle = S.C.cred.ranks[S.rank][1];
    if (this.el.rank.textContent !== rankTitle) this.el.rank.textContent = rankTitle;
    const cStr = String(Math.round(S.cred));
    if (this.el.cred.textContent !== cStr) this.el.cred.textContent = cStr;
    // tasks
    const key = S.tasks.map((t) => t.id + t.progress + (t.done ? 'd' : '')).join('|');
    if (key !== this.taskKey) {
      this.taskKey = key;
      this.el.taskList.innerHTML = '';
      for (const t of S.tasks) {
        const li = document.createElement('li');
        li.className = t.done ? 'done' : '';
        const cnt = t.def.count > 1 && !t.done ? ` <b>${t.def.unit === 'min' ? Math.round(t.progress) + '/' + t.def.count + ' min' : t.progress + '/' + t.def.count}</b>` : '';
        li.innerHTML = `<span class="tick">${t.done ? '✓' : '○'}</span><span class="tt">${esc(t.def.title)}</span><span class="td">${esc(t.def.desc)}${cnt}</span>`;
        li.title = t.def.hint;
        li.dataset.hint = t.def.hint;
        this.el.taskList.appendChild(li);
      }
    }
    // the action prompt
    const label = ctxAction ? ctxAction.label : '';
    if (this.el.promptText.textContent !== label) {
      this.el.promptText.textContent = label;
      if (this.el.actLabel) this.el.actLabel.textContent = shortLabel(ctxAction);
    }
    this.el.prompt.classList.toggle('hidden', !label || this.touch);
    // sleep / vignette
    this.el.sleep.classList.toggle('on', d.sleeping);
    this.vig = Math.max(0, this.vig - dt * 1.6);
    const hurt = d.needs.health < 30 ? 0.35 + 0.15 * Math.sin(performance.now() / 300) : 0;
    this.el.vignette.style.opacity = Math.max(this.vig, hurt).toFixed(3);
    this.updateBubbles(S, vp, canvas);
    this.updateArrow(S, vp, canvas);
    this.drawMinimap(S, cam);
  }

  updateBubbles(S, vp, canvas) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    let used = 0;
    for (const b of S.bubbles) {
      const who = b.who;
      if (who.hidden) continue;
      const y = (who.y || 0) + (b.h || 1.9);
      const dd = dist2(who.x, who.z, S.dog.x, S.dog.z);
      if (dd > 32 * 32) continue;
      const p = m4Project(vp, who.x, y, who.z);
      if (p[3] <= 0.1) continue;
      const sx = (p[0] / p[3] * 0.5 + 0.5) * w, sy = (1 - (p[1] / p[3] * 0.5 + 0.5)) * h;
      if (sx < -100 || sx > w + 100 || sy < -60 || sy > h + 60) continue;
      let el = this.bubblePool[used];
      if (!el) {
        el = document.createElement('div');
        el.className = 'bubble';
        el.innerHTML = '<span class="said"></span><span class="meant"></span>';
        this.el.bubbles.appendChild(el);
        this.bubblePool.push(el);
      }
      used++;
      if (el._text !== b.text) {
        el._text = b.text;
        el.children[0].textContent = b.text;
        el.children[1].textContent = b.sub ? b.sub : '';
        el.children[1].style.display = b.sub ? '' : 'none';
      }
      const fade = Math.min(1, b.t * 3, (b.max - b.t) * 6 + 0.2);
      const scale = clamp(9 / Math.sqrt(dd + 16), 0.6, 1.05);
      el.style.opacity = fade.toFixed(2);
      el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      el.style.display = '';
    }
    for (let i = used; i < this.bubblePool.length; i++) this.bubblePool[i].style.display = 'none';
  }

  /** When today's goal (or Aunty's call) is off-screen, point at it from the edge. */
  updateArrow(S, vp, canvas) {
    const t = taskTarget(S);
    const el = this.el.arrow;
    if (!t || dist2(t.x, t.z, S.dog.x, S.dog.z) < 8 * 8) { el.style.display = 'none'; return; }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const p = m4Project(vp, t.x, 1, t.z);
    let sx = p[0] / p[3], sy = p[1] / p[3];
    const onScreen = p[3] > 0 && Math.abs(sx) < 0.92 && Math.abs(sy) < 0.85;
    if (onScreen) { el.style.display = 'none'; return; }
    if (p[3] < 0) { sx = -sx; sy = -sy; }
    const a = Math.atan2(sy, sx);
    const r = 0.86;
    const ex = (Math.cos(a) * r * 0.5 + 0.5) * w, ey = (1 - (Math.sin(a) * r * 0.5 + 0.5)) * h;
    el.style.display = '';
    el.style.transform = `translate(${ex}px, ${ey}px) rotate(${-a}rad)`;
    el.title = t.task.def.title;
  }

  /* ------------------------------------------------------------- screens */

  showSummary(sum, onNext) {
    const el = $('summary');
    const tasks = sum.tasks.map((t) => `<li class="${t.done ? 'done' : ''}">${t.done ? '✓' : '○'} ${esc(t.title)}</li>`).join('');
    $('sumTitle').textContent = sum.why === 'collapsed' ? `Day ${sum.day}: you dozed off where you stood` : `Day ${sum.day} is over. Good night, ${DOG_NAME}.`;
    $('sumBody').innerHTML = `
      <ul class="sumtasks">${tasks}</ul>
      <div class="sumgrid">
        <div><b>${sum.tasksDone}/${sum.tasks.length}</b><span>tasks</span></div>
        <div><b>+${Math.round(sum.cred)}</b><span>cred today</span></div>
        <div><b>${sum.petted}</b><span>pats</span></div>
        <div><b>${sum.ate}</b><span>snacks</span></div>
        <div><b>${(sum.distance / 1000).toFixed(1)} km</b><span>wandered</span></div>
        <div><b>${sum.hits}</b><span>near misses</span></div>
      </div>
      <p class="sumrank">${esc(sum.rankTitle)} · ${Math.round(sum.totalCred)} cred · ${sum.friends} dog friend${sum.friends === 1 ? '' : 's'}</p>`;
    el.classList.add('open');
    const btn = $('sumNext');
    const go = () => { btn.removeEventListener('click', go); el.classList.remove('open'); onNext(); };
    btn.addEventListener('click', go);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function shortLabel(a) {
  if (!a) return '';
  switch (a.kind) {
    case 'eat': case 'eatCarry': return 'Eat';
    case 'drink': return 'Drink';
    case 'grab': return 'Grab';
    case 'pickup': return 'Pick up';
    case 'greet': return 'Greet';
    case 'rummage': return 'Dig';
    case 'mark': return 'Mark';
    case 'drop': return a.label.startsWith('Share') ? 'Share' : 'Drop';
    case 'wake': return 'Wake';
    case 'stand': return 'Stand';
    default: return a.label === 'Sit and beg' ? 'Beg' : 'Sit';
  }
}

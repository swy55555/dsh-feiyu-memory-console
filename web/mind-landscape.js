// Presentation only: colours and motion describe the stored state, never update it.
export function referenceText(r) {
  try { const v = JSON.parse(r.text); if (typeof v.text === 'string') return v.text; if (typeof v.currentEvidence === 'string') return v.currentEvidence; } catch {}
  return String(r.text || '');
}

export function mindLandscape(el, ui, types) {
  const s = ui.emotion?.state;
  const known = s && Number.isFinite(s.valence) && Number.isFinite(s.arousal);
  const label = known ? s.nuance || s.label || '当前状态' : '等待心绪';
  const intensity = known && Number.isFinite(s.intensity) ? Math.max(0, Math.min(1, s.intensity)) : null;
  const palette = !known ? 'unknown' : s.valence < -.12 ? (s.arousal > .55 ? 'restless' : 'quiet') : s.valence > .3 ? 'warm' : 'calm';
  const root = el('div', {class: `hub-landscape palette-${palette}`});
  const board = el('div', {class:'hub-scene', 'aria-label':'柔和心境图'});
  const detail = el('aside', {class:'hub-inspect', 'aria-label':'心境与参考详情'});
  const selected = (ui.data.workspace.selected || []).slice(0, 5);
  const buttons = [];
  const original = r => el('details', {}, el('summary', {text:'来源与原始参考'}),
    el('p', {class:'hub-raw', text:r.text}), el('p', {class:'small muted', text:`参考编号：${r.id}${r.evidenceIds?.length ? ' · 依据：'+r.evidenceIds.join('、') : ''}`}));
  function inspect(r, index) {
    ui.selectedReference = r ? `${r.type}:${r.id}` : '';
    ui.select?.(ui.selectedReference);
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
    orb.setAttribute('aria-pressed', String(!r));
    detail.replaceChildren(...(r ? [
      el('span', {class:'eyebrow', text:types[r.type] || r.type}),
      el('h3', {text:'此刻照亮的线索'}), el('p', {class:'hub-reference-text', text:referenceText(r)}),
      el('p', {class:'note', text:r.reason || '按本轮相关性筛选'}), original(r),
      el('p', {class:'small muted', text:'入选表示交给模型参考，不代表已经采用，也不代表事实已确认。'})
    ] : [
      el('span', {class:'eyebrow', text:'此刻的心境'}), el('h3', {text:label}),
      el('p', {class:'hub-nuance', text:known ? s.nuance ? `整体${s.label}，此刻有一点${s.nuance}。` : '没有额外记录到的细微感受。' : '情绪数据尚未就绪，暂不推断心情。'}),
      ...(s?.feelings||[]).filter(f=>f.evidence).slice(0,2).map(f=>el('details',{},el('summary',{text:`为什么${f.label}`}),el('p',{text:f.reason||'来自当时的明确表达'}),el('p',{text:`原话：${f.evidence}`}))),
      el('div', {class:'hub-feelings'}, ...(s?.feelings || []).slice(0,3).map(f => el('span', {class:'mind-badge', text:f.label}))),
      el('p', {text:intensity === null ? '暂无情绪波动数据' : intensity < .01 ? '接近平常状态' : `情绪波动 ${Math.round(intensity * 100)}%`}),
      el('p', {class:'small muted', text:'波动衡量相对平常状态的变化。接近零不代表没有感受；光晕的颜色与呼吸速度只是状态的视觉表达。'}),
      el('details', {}, el('summary', {text:'查看状态数值'}), el('p', {class:'small', text:known ? `情绪波动 ${intensity === null ? '未知' : intensity.toFixed(2)} · 舒适度 ${s.valence.toFixed(2)} · 唤醒度 ${s.arousal.toFixed(2)}` : '暂无数值'})),
      el('p', {class:'small muted', text:selected.length ? '点选光晕旁的线索，查看内容与来源。' : ui.data.workspace.stale ? '上轮参考已过期，等待新的主人私聊。' : '暂无本轮参考，等待新的主人私聊。'})
    ]));
  }
  const orb = el('button', {class:'hub-orb', type:'button', 'aria-label':'查看当前心境', 'aria-pressed':'true', on:{click:()=>inspect(null)}},
    el('span', {class:'hub-orb-light', 'aria-hidden':'true'}),
    el('span', {class:'hub-orb-label'}, el('small', {text:'此 刻'}), el('strong', {text:label}), el('span', {text:known ? intensity === null ? '状态已记录' : intensity < .01 ? '轻轻停在平常' : '有一些波澜' : '尚无状态数据'})));
  board.style.setProperty('--breathe', `${known ? 14 - Math.max(0, Math.min(1, s.arousal)) * 6 : 14}s`);
  board.append(el('div', {class:'hub-haze', 'aria-hidden':'true'}), orb);
  const nodes = el('div', {class:'hub-orbit'});
  selected.forEach((r, i) => {
    const full = referenceText(r);
    const preview = r.type === 'emotion' ? label : full.replace(/\s+/g, ' ').slice(0, 24) + (full.length > 24 ? '…' : '');
    const button = el('button', {class:`hub-thought node-${i}`, type:'button', 'aria-label':`查看${types[r.type] || r.type}：${preview}`, 'aria-pressed':'false', on:{click:()=>inspect(r,i)}},
      el('span', {text:types[r.type] || r.type}), el('b', {text:preview}));
    buttons.push(button); nodes.append(button);
  });
  board.append(nodes, el('span', {class:'hub-scene-caption', text:'光晕呈现心境 · 线索来自本轮关注'}));
  let paused = localStorage.getItem('feiyu-mind-motion') === 'paused';
  const motion = el('button', {class:'btn sm hub-motion', type:'button', 'aria-pressed':String(paused), text:paused ? '开启动效' : '暂停动效', on:{click:()=>{
    paused = !paused; localStorage.setItem('feiyu-mind-motion', paused ? 'paused' : 'playing');
    root.classList.toggle('motion-paused', paused); motion.textContent = paused ? '开启动效' : '暂停动效'; motion.setAttribute('aria-pressed', String(paused));
  }}});
  root.classList.toggle('motion-paused', paused);
  board.append(motion); root.append(board, detail);
  const current = selected.findIndex(r => `${r.type}:${r.id}` === ui.selectedReference);
  inspect(current >= 0 ? selected[current] : null, current);
  return root;
}

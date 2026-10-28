  const pendingMemeCandidates = new Map();
  const memeImageDescriptions = new Map();

  async function withMemePlayContext(key, promptText) {
    if (cfg.slang?.memeInject === false) return promptText;
    try {
      const play = loadMemePlayConfig(STATE_DIR);
      const isGroup = String(key).startsWith('group:');
      if (!play.enabled || (isGroup ? !play.group : !play.private)) return promptText;
      const st = getSocialV2State(key);
      const ms = st.recentMessages || [];
      const texts = [];
      let checked = 0;
      for (let i = ms.length - 1; i >= 0 && checked < 4; i--) {
        const mm = ms[i];
        if (!mm || mm.isSelf) continue;
        checked += 1;
        texts.push(String(mm.plain || mm.text || ''));
      }
      if (!play.proactive) return promptText;
      // 图片消息先做一次视觉描述/OCR，再拿描述去匹配梗库；没图就跳过。
      let imageDesc = '';
      try {
        const imageMsg = [...ms].reverse().find((m) => m && !m.isSelf
          && Array.isArray(m.media) && m.media.some((x) => x && (x.kind === 'image' || x.kind === 'face')));
        if (imageMsg && play.vision !== false) {
          const cacheKey = String(imageMsg.messageId || imageMsg.seq || '') + ':' + key;
          imageDesc = memeImageDescriptions.get(cacheKey) || '';
          if (!imageDesc) {
            const parts = await resolveMediaList((imageMsg.media || []).slice(0, 1));
            const images = parts.filter((p) => p && p.type === 'image');
            if (images.length) {
              imageDesc = await runHeadlessPrompt(
                '看这张聊天图片，用一两句话描述：画面里是谁/什么、图上的文字、有没有角色名或梗名。只描述看到的，不分析、不猜。',
                20000,
                images,
              );
              imageDesc = String(imageDesc || '').trim().slice(0, 300);
              if (imageDesc) {
                if (memeImageDescriptions.size > 80) memeImageDescriptions.clear();
                memeImageDescriptions.set(cacheKey, imageDesc);
                log(`[meme] 图片识别 ${key}: ${imageDesc.slice(0, 60)}`);
              }
            }
          }
          if (imageDesc) texts.push('【图片内容】' + imageDesc);
        }
      } catch (error) {
        log('[meme] 图片识别失败:', error?.message ?? error);
      }
      let usedTitles = [];
      try {
        const port = cfg.socialV2?.memoryRecall?.port ?? 9881;
        const q = ('梗 ' + texts.slice(-2).join(' ')).slice(0, 160);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1200);
        const res = await fetch(`http://127.0.0.1:${port}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: q, scope: key, k: 5, min_score: 0.1 }),
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer));
        const data = await res.json();
        usedTitles = usedTitlesFromMemories(Array.isArray(data?.results) ? data.results : []);
      } catch {}
      const candidates = pickMemeCandidates({
        dbPath: MEME_DB_PATH,
        texts,
        moodValence: Number(emotionState?.mood?.valence ?? 0),
        config: play,
        usedTitles,
        limit: play.limit,
      });
      if (!candidates.length) return promptText;
      const hasImage = texts.some((t) => /\[图片\]|\[表情\]/.test(String(t)));
      pendingMemeCandidates.set(key, candidates);
      log(`[meme] 候选 ${candidates.map((m) => m.title).join('/')} ${key}`);
      const imageHint = imageDesc ? `\n\n【图里看到】${imageDesc}` : (hasImage ? '\n\n【图里有梗】最近这条消息带图片/表情。如果图里像梗图，先调用 qq_get_message_images 看一眼再决定接不接；别假装看见了。' : '');
      return renderMemeBlock(candidates, usedTitles) + imageHint + '\n\n' + promptText;
    } catch {
      return promptText;
    }
  }

  function noteMemeUse(key, text) {
    const list = pendingMemeCandidates.get(key);
    if (!list || !list.length) return;
    pendingMemeCandidates.delete(key);
    const kind = String(key).startsWith('group:') ? 'group' : 'private';
    for (const m of list) {
      if (String(text || '').includes(m.title)) {
        void recordMemeUse({
          memvecUrl: `http://127.0.0.1:${cfg.socialV2?.memoryRecall?.port ?? 9881}`,
          scope: key,
          title: m.title,
          slug: m.slug,
          usage: m.usage,
          tags: m.tags,
          kind,
        });
      }
    }
  }

/**
 * Browser half of QuadNest: one left-sidebar entry and the world page it opens.
 *
 * The page is a private micro-metaverse: chat on the left, a hand-drawn low-poly
 * Canvas viewport on the right, plus a small backpack overlay. Conversation runs
 * on the Host half, where each companion is its own Agent; this half only
 * persists the world in localStorage, applies the picture instructions the
 * companions return, and animates the result.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quadnest',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'quadnest'
    const PANEL_ID = 'quadnest'
    const STORE_KEY = 'dsh.quadnest.world.v1'
    // Absolute paths: the Host injects `<base href="./">` into the page, so a
    // bare relative route would resolve against whichever path the app was
    // opened on and miss every route on any non-root URL.
    const STATUS_ROUTE = '/api/quadnest/status'
    const SAY_ROUTE = '/api/quadnest/say'
    const IDLE_ROUTE = '/api/quadnest/idle'
    const RESET_ROUTE = '/api/quadnest/reset'
    const MEMORY_ROUTE = '/api/quadnest/memory'
    const RECALL_ROUTE = '/api/quadnest/memory/recall'
    const MESSAGE_LIMIT = 200
    const ITEM_LIMIT = 80
    const SEND_MAX_CHARS = 2000
    const IDLE_FALLBACK_MS = 60_000
    const IDLE_TICK_MS = 5_000

    const BOTS = [
      { id: 'star', body: '#f2c56b', dark: '#c98f3c', light: '#ffe9c2', glow: '#ffe9a8', likes: ['starcliff', 'beach'] },
      { id: 'suyou', body: '#8fc8b0', dark: '#5d9d86', light: '#dff4ea', glow: '#c8ffe4', likes: ['cabin', 'meadow'] },
      { id: 'spirit', body: '#ee9068', dark: '#c25f42', light: '#ffd9c6', glow: '#ffd2b0', likes: ['cave', 'cabin'] },
      { id: 'nook', body: '#a89fdd', dark: '#7469b7', light: '#e5e0ff', glow: '#d9d2ff', likes: ['cabin', 'cave'] },
    ]
    const BOT_IDS = BOTS.map(bot => bot.id)
    const SCENE_IDS = ['beach', 'cabin', 'starcliff', 'cave', 'meadow']
    const ITEM_IDS = ['shell', 'flower', 'torch', 'book', 'gem', 'lantern']
    const ANIM_IDS = ['wave', 'tilt', 'sit', 'look', 'jump', 'quiet']
    // Faces a companion can wear after speaking. The host reads them from the
    // reply itself; the browser only paints them, and never derives them from
    // what the visitor said.
    const MOOD_IDS = ['happy', 'sad', 'angry', 'surprised', 'neutral']
    const MOOD_TTL_MS = 30_000
    // Face offsets per mood. `eyeStyle` picks the eye shape in the renderer:
    // dots for neutral/surprised, an upturned arc for happy, a slant for angry.
    const MOOD_FACES = {
      happy: { headDip: -1, eyeStyle: 'smile', eyeScale: 1 },
      sad: { headDip: 4, eyeStyle: 'dot', eyeScale: 0.8, eyeAlpha: 0.85 },
      angry: { headDip: 1, eyeStyle: 'slant', eyeScale: 1 },
      surprised: { headDip: -2, eyeStyle: 'dot', eyeScale: 1.6 },
      neutral: { headDip: 0, eyeStyle: 'dot', eyeScale: 1 },
    }

    const zh = {
      panel: '四机小境',
      title: '四机小境',
      subtitle: '只有你一位访客的小世界，四位伙伴常驻在这里。',
      back: '返回对话',
      model: '模型',
      modelMissing: '尚未配置默认模型',
      targetLabel: '对话对象',
      targetGroup: '群聊',
      botStar: '星伴',
      botSuyou: '溯游',
      botSpirit: '灵旅',
      botNook: '隅友',
      botStarFull: '星伴 StarPaeon',
      botSuyouFull: '溯游 Suyou',
      botSpiritFull: '灵旅 SpiritTrek',
      botNookFull: '隅友 NookFriend',
      groupSpeaker: '群聊',
      sceneBeach: '沙滩',
      sceneCabin: '林间小屋',
      sceneStarcliff: '星空崖',
      sceneCave: '山洞',
      sceneMeadow: '春日草地',
      itemShell: '贝壳',
      itemFlower: '小花',
      itemTorch: '火把',
      itemBook: '书本',
      itemGem: '宝石',
      itemLantern: '灯笼',
      animWave: '挥手',
      animTilt: '歪头好奇',
      animSit: '坐下',
      animLook: '张望',
      animJump: '开心跳跃',
      animQuiet: '低头安静',
      hintBeach: '海风把灯光吹得很轻，浪一遍遍靠岸。',
      hintCabin: '小屋的窗还亮着，柴火声慢慢响。',
      hintStarcliff: '崖顶的星星很近，风从很远的地方来。',
      hintCave: '山洞里只有水滴和会发光的石头。',
      hintMeadow: '春日草地一直很软，花还没有睡。',
      placeholder: '和伙伴说点什么…（Enter 发送，Shift+Enter 换行）',
      send: '发送',
      sending: '回复中…',
      thinking: '{name}正在想…',
      emptyChat: '说句话吧，四位伙伴都在这儿。',
      bag: '背包',
      bagClose: '收起背包',
      bagEmpty: '背包还是空的。地上的东西点一下就能捡起来。',
      bagGive: '送给{name}',
      bagNoTarget: '先点选一位伙伴，再把东西送给ta。',
      bagCount: '×{count}',
      travel: '去往',
      hint: '点击伙伴切换对话对象，点击地上的物品收进背包。',
      reset: '重置世界',
      resetConfirm: '再点一次确认重置',
      resetHint: '重置会清空所有对话、背包和伙伴的记忆。',
      resetDone: '世界重新开始了。四位伙伴已经忘了之前的事。',
      picked: '拾取了{name}，放进了背包。',
      giftNeedTarget: '先选一位伙伴，再把背包里的东西送出去。',
      giftNote: '你把{name}送给了{bot}，{bot}把它放在身边。',
      travelNote: '你们来到了{name}。',
      error: '出了点问题：{message}',
      noModel: '还没有配置默认模型，伙伴暂时无法回应。',
      sceneUnknown: '陌生的地方',
      retry: '再试一次',
      close: '关闭',
      memory: '记忆',
      memoryClose: '收起记忆',
      memoryHint: '这里只放伙伴真正记住的东西：印象、想法、事实，还有最近聊过的几句。原始对话不会整段塞回模型。',
      memoryEmpty: '还没记住什么。多聊几句，伙伴会自己决定哪些值得记下来。',
      memoryGroupHint: '群聊不单独存印象，只留最近说过的话。',
      memoryLoading: '读取中…',
      memoryPersona: '印象',
      memoryReflections: '想法',
      memoryFacts: '事实',
      memoryRecent: '最近',
      memorySearch: '搜一下 ta 会想起什么',
      memoryAsk: '召回',
      memorySearchEmpty: '这句话没让 ta 想起什么。',
    }

    const en = {
      panel: 'QuadNest',
      title: 'QuadNest',
      subtitle: 'A private little world with four resident companions.',
      back: 'Back to chat',
      model: 'Model',
      modelMissing: 'No default model configured',
      targetLabel: 'Talk to',
      targetGroup: 'Group chat',
      botStar: 'StarPaeon',
      botSuyou: 'Suyou',
      botSpirit: 'SpiritTrek',
      botNook: 'NookFriend',
      botStarFull: 'StarPaeon',
      botSuyouFull: 'Suyou',
      botSpiritFull: 'SpiritTrek',
      botNookFull: 'NookFriend',
      groupSpeaker: 'Group chat',
      sceneBeach: 'Beach',
      sceneCabin: 'Forest cabin',
      sceneStarcliff: 'Star cliff',
      sceneCave: 'Cave',
      sceneMeadow: 'Spring meadow',
      itemShell: 'Shell',
      itemFlower: 'Flower',
      itemTorch: 'Torch',
      itemBook: 'Book',
      itemGem: 'Gem',
      itemLantern: 'Lantern',
      animWave: 'Wave',
      animTilt: 'Curious tilt',
      animSit: 'Sit down',
      animLook: 'Look around',
      animJump: 'Happy hop',
      animQuiet: 'Quiet',
      hintBeach: 'Sea wind softens the lantern light.',
      hintCabin: 'The cabin window stays warm; firewood keeps ticking.',
      hintStarcliff: 'The stars feel close; the wind comes from far away.',
      hintCave: 'Only dripping water and glowing stones in the cave.',
      hintMeadow: 'The spring meadow is soft; the flowers are still awake.',
      placeholder: 'Say something to a companion… (Enter sends, Shift+Enter breaks)',
      send: 'Send',
      sending: 'Replying…',
      thinking: '{name} is thinking…',
      emptyChat: 'Say something; all four companions are here.',
      bag: 'Backpack',
      bagClose: 'Hide backpack',
      bagEmpty: 'The backpack is empty. Tap something on the ground to pick it up.',
      bagGive: 'Give to {name}',
      bagNoTarget: 'Pick a companion first, then give the item away.',
      bagCount: '×{count}',
      travel: 'Travel to',
      hint: 'Tap a companion to talk; tap an item on the ground to pick it up.',
      reset: 'Reset world',
      resetConfirm: 'Tap again to reset',
      resetHint: 'Resetting clears every conversation, the backpack, and all companion memories.',
      resetDone: 'The world starts over; the four companions have forgotten.',
      picked: 'Picked up the {name} and added it to the backpack.',
      giftNeedTarget: 'Pick a companion first, then give the item away.',
      giftNote: 'You gave the {name} to {bot}, who keeps it close.',
      travelNote: 'Everyone arrives at {name}.',
      error: 'Something went wrong: {message}',
      noModel: 'No default model is configured, so companions cannot reply yet.',
      sceneUnknown: 'Somewhere new',
      retry: 'Try again',
      close: 'Close',
      memory: 'Memory',
      memoryClose: 'Hide memory',
      memoryHint: 'Only what a companion really keeps: impressions, thoughts, facts, and the last few exchanges. The raw transcript is never fed back whole.',
      memoryEmpty: 'Nothing remembered yet. Talk for a while; each companion decides what is worth keeping.',
      memoryGroupHint: 'The group chat keeps no impressions, only what was said recently.',
      memoryLoading: 'Reading…',
      memoryPersona: 'Impressions',
      memoryReflections: 'Thoughts',
      memoryFacts: 'Facts',
      memoryRecent: 'Recent',
      memorySearch: 'Search what they would recall',
      memoryAsk: 'Recall',
      memorySearchEmpty: 'That sentence brought nothing back.',
    }

    const CSS = `
.qn-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
.qn-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.qn-head-text { min-width: 0; }
.qn-title { margin: 0; font-size: 15px; font-weight: 600; }
.qn-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.qn-head-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.qn-model { padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }
.qn-ghost { font: inherit; padding: 4px 10px; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); cursor: pointer; }
.qn-ghost:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.qn-body { display: flex; flex: 1 1 auto; min-height: 0; }
.qn-chat { display: flex; flex-direction: column; flex: 0 0 340px; min-width: 0; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.qn-targets { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.qn-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; cursor: pointer; }
.qn-chip:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.qn-chip[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, var(--dsw-alias-bg-base)); }
.qn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--qn-bot); }
.qn-messages { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-height: 0; padding: 12px; overflow-y: auto; }
.qn-msg { max-width: 88%; padding: 7px 10px; border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); overflow-wrap: anywhere; white-space: pre-wrap; }
.qn-msg-user { align-self: flex-end; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, var(--dsw-alias-bg-base)); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, var(--dsw-alias-border-l1)); }
.qn-msg-bot { align-self: flex-start; }
.qn-msg-note { align-self: center; max-width: 100%; color: var(--dsw-alias-label-secondary); font-size: 11px; background: transparent; border-style: dashed; }
.qn-msg-error { align-self: center; max-width: 100%; color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, var(--dsw-alias-border-l1)); font-size: 12px; }
.qn-msg-name { display: block; margin-bottom: 2px; font-size: 11px; color: var(--qn-bot, var(--dsw-alias-label-secondary)); }
.qn-typing { color: var(--dsw-alias-label-tertiary); font-style: italic; }
.qn-empty { margin: auto; padding: 20px; color: var(--dsw-alias-label-tertiary); text-align: center; line-height: 1.7; }
.qn-composer { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.qn-input { width: 100%; min-height: 64px; max-height: 170px; resize: vertical; box-sizing: border-box; padding: 8px 10px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.qn-send { align-self: flex-end; padding: 5px 16px; font: inherit; color: var(--dsw-alias-brand-primary-invert); background: var(--dsw-alias-brand-primary); border: 1px solid transparent; border-radius: 999px; cursor: pointer; }
.qn-send:disabled { opacity: 0.55; cursor: default; }
.qn-hints { display: flex; flex-direction: column; gap: 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.qn-stage { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; background: var(--dsw-alias-bg-base); }
.qn-canvas { display: block; width: 100%; height: 100%; }
.qn-scenebar { position: absolute; top: 10px; left: 10px; display: flex; flex-wrap: wrap; gap: 6px; max-width: calc(100% - 150px); }
.qn-scene { padding: 3px 10px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-bg-base) 82%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; cursor: pointer; }
.qn-scene[aria-pressed="true"] { color: var(--dsw-alias-brand-primary-invert); background: var(--dsw-alias-brand-primary); border-color: transparent; }
.qn-stage-actions { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; }
.qn-bag { position: absolute; right: 10px; bottom: 10px; width: 224px; max-height: calc(100% - 70px); display: flex; flex-direction: column; gap: 6px; padding: 10px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); box-shadow: 0 8px 24px var(--dsw-alias-bg-mask-2); }
.qn-bag-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.qn-bag-title { font-weight: 600; font-size: 12px; }
.qn-bag-close { all: unset; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.qn-bag-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.qn-bag-item { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.qn-bag-count { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.qn-bag-give { font: inherit; font-size: 11px; padding: 1px 8px; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; cursor: pointer; }
.qn-bag-give:disabled { opacity: 0.45; cursor: default; }
.qn-bag-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; }
.qn-memory { position: absolute; left: 10px; bottom: 10px; width: 300px; max-height: calc(100% - 70px); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 10px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); box-shadow: 0 8px 24px var(--dsw-alias-bg-mask-2); }
.qn-memory-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.qn-memory-title { font-weight: 600; font-size: 12px; }
.qn-memory-close { all: unset; cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.qn-memory-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.55; }
.qn-memory-search { display: flex; gap: 6px; }
.qn-memory-input { flex: 1 1 auto; min-width: 0; padding: 4px 8px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.qn-memory-ask { flex: none; font: inherit; font-size: 11px; padding: 3px 10px; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; cursor: pointer; }
.qn-memory-ask:disabled { opacity: 0.45; cursor: default; }
.qn-memory-group { display: flex; flex-direction: column; gap: 3px; }
.qn-memory-label { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.qn-memory-item { position: relative; padding-left: 10px; font-size: 12px; line-height: 1.5; }
.qn-memory-item::before { content: '·'; position: absolute; left: 2px; color: var(--dsw-alias-label-tertiary); }
.qn-memory-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; }
@media (max-width: 900px) {
  .qn-body { flex-direction: column; }
  .qn-stage { flex: 0 0 52%; min-height: 300px; order: -1; }
  .qn-chat { flex: 1 1 auto; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
  .qn-bag { width: 200px; }
  .qn-memory { width: 240px; }
}
`
    /**
     * Build the locale key for one catalogue id, e.g. `sceneBeach`.
     * @param prefix - Dictionary prefix such as `scene`, `bot`, `item`, or `anim`.
     * @param id - Catalogue id from the host half.
     * @returns The dictionary key.
     */
    function labelKey(prefix, id) {
      const text = String(id)
      return prefix + text.charAt(0).toUpperCase() + text.slice(1)
    }

    /** Walkable spots and scenery for each of the five scenes. */
    const SCENE_LAYOUTS = {
      beach: {
        player: { x: 0, z: 3.4 },
        bots: {
          star: { x: -1.7, z: 0.6 },
          suyou: { x: 1.9, z: 0.2 },
          spirit: { x: 0.3, z: -1.8 },
          nook: { x: -2.7, z: 2.5 },
        },
        props: [
          { kind: 'palm', x: -4.4, z: -2.6, scale: 1.1 },
          { kind: 'palm', x: 4.6, z: -3.2, scale: 0.95 },
          { kind: 'driftwood', x: 1.1, z: 4.8, scale: 1 },
          { kind: 'rock', x: -3.8, z: 3.9, scale: 0.8 },
          { kind: 'starfish', x: 2.9, z: 3.1, scale: 0.8 },
        ],
      },
      cabin: {
        player: { x: 0, z: 3.1 },
        bots: {
          star: { x: -1.8, z: 0.4 },
          suyou: { x: 1.6, z: 0.8 },
          spirit: { x: 2.4, z: -1.4 },
          nook: { x: -2.8, z: 2.2 },
        },
        props: [
          { kind: 'cabin', x: -0.4, z: -4.4, scale: 1.35 },
          { kind: 'tree', x: -4.6, z: -2.4, scale: 1.1 },
          { kind: 'tree', x: 4.3, z: -1.9, scale: 0.95 },
          { kind: 'firepit', x: 0, z: -0.9, scale: 0.9 },
          { kind: 'flower', x: -2.2, z: 2.9, scale: 0.7 },
          { kind: 'flower', x: 2.5, z: 3.1, scale: 0.7 },
        ],
      },
      starcliff: {
        player: { x: 0, z: 3.2 },
        bots: {
          star: { x: 1.2, z: -1.6 },
          suyou: { x: -1.6, z: 0.4 },
          spirit: { x: 2.2, z: 1.2 },
          nook: { x: -2.7, z: 2.3 },
        },
        props: [
          { kind: 'rock', x: -4.1, z: -1.4, scale: 1.2 },
          { kind: 'rock', x: 4.2, z: -2.1, scale: 1 },
          { kind: 'crystal', x: -2.5, z: 1.6, scale: 0.8 },
          { kind: 'crystal', x: 2.8, z: 0.6, scale: 0.7 },
          { kind: 'stone', x: 0.4, z: 4.5, scale: 0.9 },
        ],
      },
      cave: {
        player: { x: 0, z: 3.3 },
        bots: {
          star: { x: -1.4, z: 0.2 },
          suyou: { x: 1.4, z: 0.6 },
          spirit: { x: 2.1, z: -1.5 },
          nook: { x: -2.4, z: 2.1 },
        },
        props: [
          { kind: 'rock', x: -3.7, z: 0.5, scale: 1.3 },
          { kind: 'crystal', x: -2.1, z: -2.6, scale: 0.9 },
          { kind: 'crystal', x: 2.5, z: -2.1, scale: 0.8 },
          { kind: 'mushroom', x: 1.7, z: 2.4, scale: 0.6 },
          { kind: 'mushroom', x: -1.9, z: 2.9, scale: 0.55 },
        ],
      },
      meadow: {
        player: { x: 0, z: 3.2 },
        bots: {
          star: { x: -1.8, z: 0.5 },
          suyou: { x: 1.7, z: 0.1 },
          spirit: { x: 0.6, z: -1.9 },
          nook: { x: -2.6, z: 2.3 },
        },
        props: [
          { kind: 'tree', x: -4.5, z: -2.7, scale: 1.15 },
          { kind: 'tree', x: 4.3, z: -2.3, scale: 1 },
          { kind: 'bush', x: 0, z: -3.6, scale: 1 },
          { kind: 'flower', x: -3.2, z: 2.4, scale: 0.7 },
          { kind: 'flower', x: 3.1, z: 2.1, scale: 0.7 },
          { kind: 'flower', x: 1.4, z: 4.4, scale: 0.6 },
        ],
      },
    }

    /**
     * Read one scene's layout.
     * @param scene - scene id.
     * @returns the layout, defaulting to the beach for unknown ids.
     */
    function sceneLayout(scene) {
      return SCENE_LAYOUTS[scene] ?? SCENE_LAYOUTS.beach
    }

    /** Monotonic suffix for world ids, so two items never share a key. */
    let idCounter = 0

    /**
     * Mint a world id.
     * @param prefix - kind of value being identified.
     * @returns a unique string.
     */
    function nextId(prefix) {
      idCounter += 1
      return `${prefix}-${idCounter}-${Math.floor(Math.random() * 1e6).toString(36)}`
    }

    /**
     * Clamp one coordinate to the same walkable area the host accepts.
     * @param value - candidate coordinate.
     * @param fallback - value used when the candidate is not finite.
     * @returns a bounded finite number.
     */
    function clampCoord(value, fallback) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.max(-40, Math.min(40, value))
    }

    /**
     * Create the opening world state.
     * @param now - timestamp used for the initial revision.
     * @returns a fresh world.
     */
    function defaultWorld(now) {
      const layout = sceneLayout('beach')
      const chars = {}
      for (const id of BOT_IDS) {
        const spot = layout.bots[id]
        chars[id] = { scene: 'beach', x: spot.x, z: spot.z, tx: spot.x, tz: spot.z, anim: 'idle', animAt: 0, mood: 'neutral', moodAt: 0 }
      }
      return {
        version: 1,
        scene: 'beach',
        target: 'star',
        bag: Object.fromEntries(ITEM_IDS.map(id => [id, 0])),
        items: [],
        chars,
        messages: [],
        updatedAt: typeof now === 'number' ? now : 0,
      }
    }

    /**
     * Coerce one stored or externally supplied world into the page's exact state.
     * @param raw - parsed storage value.
     * @param now - timestamp used for the initial revision.
     * @returns a fully populated world; every unknown field is dropped.
     */
    function normalizeWorld(raw, now) {
      const base = defaultWorld(now)
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
      if (SCENE_IDS.includes(raw.scene)) base.scene = raw.scene
      if (raw.target === 'group') base.target = 'group'
      else if (BOT_IDS.includes(raw.target)) base.target = raw.target
      if (raw.bag !== null && typeof raw.bag === 'object' && !Array.isArray(raw.bag)) {
        for (const id of ITEM_IDS) {
          const count = raw.bag[id]
          if (typeof count === 'number' && Number.isFinite(count)) {
            base.bag[id] = Math.max(0, Math.min(999, Math.floor(count)))
          }
        }
      }
      if (Array.isArray(raw.items)) {
        for (const entry of raw.items.slice(0, ITEM_LIMIT)) {
          if (entry === null || typeof entry !== 'object' || !ITEM_IDS.includes(entry.item)) continue
          base.items.push({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : nextId('item'),
            item: entry.item,
            scene: SCENE_IDS.includes(entry.scene) ? entry.scene : base.scene,
            x: clampCoord(entry.x, 0),
            z: clampCoord(entry.z, 0),
            at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
          })
        }
      }
      if (raw.chars !== null && typeof raw.chars === 'object' && !Array.isArray(raw.chars)) {
        for (const id of BOT_IDS) {
          const entry = raw.chars[id]
          if (entry === null || typeof entry !== 'object') continue
          const scene = SCENE_IDS.includes(entry.scene) ? entry.scene : base.scene
          const spot = sceneLayout(scene).bots[id]
          const x = clampCoord(entry.x, spot.x)
          const z = clampCoord(entry.z, spot.z)
          base.chars[id] = {
            scene,
            x,
            z,
            tx: clampCoord(entry.tx, x),
            tz: clampCoord(entry.tz, z),
            anim: ANIM_IDS.includes(entry.anim) ? entry.anim : 'idle',
            animAt: typeof entry.animAt === 'number' && Number.isFinite(entry.animAt) ? entry.animAt : 0,
            mood: MOOD_IDS.includes(entry.mood) ? entry.mood : 'neutral',
            moodAt: typeof entry.moodAt === 'number' && Number.isFinite(entry.moodAt) ? entry.moodAt : 0,
          }
        }
      }
      if (Array.isArray(raw.messages)) {
        const kept = []
        for (const entry of raw.messages.slice(-MESSAGE_LIMIT)) {
          if (entry === null || typeof entry !== 'object') continue
          if (typeof entry.text !== 'string' || entry.text === '') continue
          kept.push({
            id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : nextId('msg'),
            kind: ['user', 'bot', 'note', 'error'].includes(entry.kind) ? entry.kind : 'note',
            bot: entry.bot === 'group' || BOT_IDS.includes(entry.bot) ? entry.bot : undefined,
            text: entry.text.slice(0, SEND_MAX_CHARS),
            at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
            mood: MOOD_IDS.includes(entry.mood) ? entry.mood : undefined,
          })
        }
        base.messages = kept
      }
      if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) base.updatedAt = raw.updatedAt
      return base
    }

    /**
     * Read the persisted world, falling back to a fresh one.
     * @returns the world to open the page with.
     */
    function loadWorld() {
      try {
        if (typeof localStorage === 'undefined') return defaultWorld()
        const stored = localStorage.getItem(STORE_KEY)
        if (stored === null) return defaultWorld()
        return normalizeWorld(JSON.parse(stored), Date.now())
      } catch {
        // Unreadable or disabled storage must not stop the world from opening.
        return defaultWorld()
      }
    }

    /**
     * Persist the world for the next visit.
     * @param world - world state to store.
     */
    function saveWorld(world) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(STORE_KEY, JSON.stringify(world))
      } catch {
        // Quota and privacy-mode failures leave this visit's in-memory world usable.
      }
    }

    /**
     * Clone the mutable parts of a world before applying one change.
     * @param world - source world.
     * @returns a world safe to mutate.
     */
    function cloneWorld(world) {
      const chars = {}
      for (const id of BOT_IDS) chars[id] = { ...world.chars[id] }
      return {
        ...world,
        bag: { ...world.bag },
        items: world.items.map(entry => ({ ...entry })),
        chars,
        messages: world.messages.slice(),
      }
    }

    /**
     * Build one transcript entry with its stable id and timestamp.
     * @param entry - message fields; `id` and `at` are optional.
     * @returns the message to store.
     */
    function makeMessage(entry) {
      return {
        id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : nextId('msg'),
        kind: entry.kind,
        bot: entry.bot,
        text: entry.text,
        at: typeof entry.at === 'number' ? entry.at : Date.now(),
        mood: MOOD_IDS.includes(entry.mood) ? entry.mood : undefined,
        // The turn a line belongs to. A visitor message and the bubbles answering
        // it share one id, which is what lets a late answer land under its own
        // question instead of under whatever was said most recently.
        turnId: typeof entry.turnId === 'string' && entry.turnId !== '' ? entry.turnId : undefined,
      }
    }

    /**
     * Append one transcript entry, dropping the oldest entries at the bound.
     * @param world - world state.
     * @param entry - message fields; `id` and `at` are optional.
     * @returns a world carrying the new entry.
     */
    function appendMessage(world, entry) {
      return { ...world, messages: world.messages.concat([makeMessage(entry)]).slice(-MESSAGE_LIMIT) }
    }

    /**
     * Insert one entry directly after the last line of the turn it answers.
     *
     * Four companions answer at once and an unsolicited turn can still be in
     * flight when the visitor asks something new, so replies do not always arrive
     * in the order the questions were asked. A reply belongs under its own
     * question, not at the bottom of the list.
     * @param world - world state.
     * @param turnId - turn the entry belongs to.
     * @param entry - message fields; the turn id is taken from the argument.
     * @returns a world carrying the entry in its turn's place.
     */
    function appendToTurn(world, turnId, entry) {
      const message = makeMessage({ ...entry, turnId })
      const messages = world.messages.slice()
      let at = -1
      if (typeof turnId === 'string' && turnId !== '') {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].turnId === turnId) { at = index; break }
        }
      }
      // No line for this turn (a turn that produced nothing yet, or a reply whose
      // question was trimmed out of the window): appending is the only honest option.
      if (at < 0) messages.push(message)
      else messages.splice(at + 1, 0, message)
      return { ...world, messages: messages.slice(-MESSAGE_LIMIT) }
    }

    /**
     * Apply the picture instructions one companion returned.
     * @param world - world state before the reply.
     * @param actions - normalized instructions from the host.
     * @param t - locale translator for the notes the actions produce.
     * @param now - timestamp shared by every change in this batch.
     * @returns the updated world and any localized notes to show in the transcript.
     */
    function applyActions(world, actions, t, now) {
      const next = cloneWorld(world)
      const notes = []
      const time = typeof now === 'number' ? now : Date.now()
      for (const action of Array.isArray(actions) ? actions : []) {
        if (action === null || typeof action !== 'object') continue
        const params = action.params !== null && typeof action.params === 'object' ? action.params : {}
        switch (action.cmd) {
          case 'change_scene': {
            if (!SCENE_IDS.includes(params.scene)) break
            const scene = params.scene
            const stay = Array.isArray(params.stay) ? params.stay : []
            const layout = sceneLayout(scene)
            next.scene = scene
            for (const id of BOT_IDS) {
              if (stay.includes(id)) continue
              const spot = layout.bots[id]
              next.chars[id] = { scene, x: spot.x, z: spot.z, tx: spot.x, tz: spot.z, anim: 'idle', animAt: time }
            }
            notes.push({ text: t('travelNote', { name: t(labelKey('scene', scene)) }), at: time })
            break
          }
          case 'spawn_item': {
            if (!ITEM_IDS.includes(params.item) || next.items.length >= ITEM_LIMIT) break
            const spot = sceneLayout(next.scene).player
            const angle = next.items.length * 1.9
            next.items.push({
              id: nextId('item'),
              item: params.item,
              scene: next.scene,
              x: clampCoord(params.x, spot.x + Math.cos(angle) * 2.1),
              z: clampCoord(params.z, spot.z + Math.sin(angle) * 2.1),
              at: time,
            })
            break
          }
          case 'remove_item': {
            const id = typeof params.id === 'string' ? params.id : undefined
            const item = ITEM_IDS.includes(params.item) ? params.item : undefined
            const index = next.items.findIndex(entry => (
              (id !== undefined && entry.id === id) || (item !== undefined && entry.item === item)
            ))
            if (index >= 0) next.items.splice(index, 1)
            break
          }
          case 'char_move': {
            if (!BOT_IDS.includes(action.target)) break
            const char = next.chars[action.target]
            char.tx = clampCoord(params.x, char.tx)
            char.tz = clampCoord(params.z, char.tz)
            char.anim = 'idle'
            char.animAt = time
            break
          }
          case 'char_animate': {
            if (!BOT_IDS.includes(action.target) || !ANIM_IDS.includes(params.animation)) break
            const char = next.chars[action.target]
            char.anim = params.animation
            char.animAt = time
            break
          }
          case 'gather_all': {
            const spot = sceneLayout(next.scene).player
            BOT_IDS.forEach((id, index) => {
              const angle = -0.9 + index * 0.6
              const char = next.chars[id]
              char.scene = next.scene
              char.tx = clampCoord(spot.x + Math.cos(angle) * 1.7, 0)
              char.tz = clampCoord(spot.z + Math.sin(angle) * 1.7, 0)
              char.anim = 'idle'
              char.animAt = time
            })
            break
          }
          case 'disperse': {
            const layout = sceneLayout(next.scene)
            for (const id of BOT_IDS) {
              const spot = layout.bots[id]
              const char = next.chars[id]
              char.scene = next.scene
              char.tx = spot.x
              char.tz = spot.z
              char.anim = 'idle'
              char.animAt = time
            }
            break
          }
          default:
            break
        }
      }
      return { world: next, notes }
    }

    /**
     * Move one loose item into the backpack.
     * @param world - world state.
     * @param itemId - identity of the item on the ground.
     * @param t - locale translator.
     * @param now - timestamp used for the note.
     * @returns the updated world and one note when the item existed.
     */
    function pickItem(world, itemId, t, now) {
      const next = cloneWorld(world)
      const index = next.items.findIndex(entry => entry.id === itemId)
      if (index < 0) return { world: next, notes: [] }
      const entry = next.items.splice(index, 1)[0]
      next.bag[entry.item] = Math.min(999, (next.bag[entry.item] ?? 0) + 1)
      const note = t('picked', { name: t(labelKey('item', entry.item)) })
      return { world: next, notes: [{ text: note, at: now }] }
    }

    /**
     * Give one carried item to a companion.
     * @param world - world state.
     * @param itemId - item catalogue id.
     * @param botId - companion id, or a group target.
     * @param t - locale translator.
     * @param now - timestamp used for the note.
     * @returns the updated world and one note when the gift happened.
     */
    function giftItem(world, itemId, botId, t, now) {
      const next = cloneWorld(world)
      if (!ITEM_IDS.includes(itemId) || !BOT_IDS.includes(botId)) return { world: next, notes: [] }
      if (next.bag[itemId] <= 0) return { world: next, notes: [] }
      next.bag[itemId] -= 1
      const note = t('giftNote', {
        name: t(labelKey('item', itemId)),
        bot: t(labelKey('bot', botId)),
      })
      return { world: next, notes: [{ text: note, at: now }] }
    }

    /** Group address prefix at the start of a visitor message. */
    const MENTION_GROUP = /^(大家|群聊|所有人|全员|all)(?:[，,：:\s]|$)/i
    /** Companion address prefix at the start of a visitor message. */
    const MENTION_BOT = /^(星伴|StarPaeon|溯游|Suyou|灵旅|SpiritTrek|隅友|NookFriend)(?:[，,：:\s]|$)/i
    /** Lower-case companion names used by {@link MENTION_BOT}. */
    const MENTION_BOT_IDS = {
      星伴: 'star',
      starpaeon: 'star',
      溯游: 'suyou',
      suyou: 'suyou',
      灵旅: 'spirit',
      spirittrek: 'spirit',
      隅友: 'nook',
      nookfriend: 'nook',
    }

    /**
     * Read an addressee named at the start of a visitor message.
     * @param text - raw visitor text.
     * @returns the addressed target, or null when the message names nobody.
     */
    function mentionedTarget(text) {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (MENTION_GROUP.test(trimmed)) return 'group'
      const match = MENTION_BOT.exec(trimmed)
      if (match === null) return null
      return MENTION_BOT_IDS[match[1]] ?? MENTION_BOT_IDS[match[1].toLowerCase()] ?? null
    }

    /**
     * Project the world onto the compact snapshot the host prompts consume.
     * @param world - client world state.
     * @returns the wire world accepted by `sanitizeWorld`.
     */
    function wireWorld(world) {
      const chars = {}
      for (const id of BOT_IDS) {
        const char = world.chars[id]
        chars[id] = { scene: char.scene, x: char.x, z: char.z }
      }
      return {
        scene: world.scene,
        bag: { ...world.bag },
        items: world.items.map(entry => ({ type: entry.item, x: entry.x, z: entry.z })),
        chars,
      }
    }
    /** Sky, ground, and accent colors for each scene's hand-drawn backdrop. */
    const SCENE_PALETTES = {
      beach: { skyTop: '#123a5c', skyBottom: '#f0c58c', ground: '#e4c78b', groundDark: '#cfae70', accent: '#8fd6e2', night: false },
      cabin: { skyTop: '#14251c', skyBottom: '#c99f6a', ground: '#4b7350', groundDark: '#3d6044', accent: '#f0b96b', night: false },
      starcliff: { skyTop: '#070a24', skyBottom: '#3b2f63', ground: '#333a63', groundDark: '#282e51', accent: '#a7b4ff', night: true },
      cave: { skyTop: '#0d0913', skyBottom: '#2a1c33', ground: '#3d3548', groundDark: '#302a3c', accent: '#c4a2ff', night: true },
      meadow: { skyTop: '#8cc4e2', skyBottom: '#f7e9b7', ground: '#83c26d', groundDark: '#71b05d', accent: '#f5dc8a', night: false },
    }

    /** Floating colors for each item catalogue id. */
    const ITEM_COLORS = {
      shell: '#f3d3bb',
      flower: '#f7a6c4',
      torch: '#ffb257',
      book: '#8f9fe0',
      gem: '#7fe0d0',
      lantern: '#ffd08a',
    }

    /**
     * Stable pseudo-random value used for scenery placement.
     * @param index - index within a generated set.
     * @param salt - decorrelation constant.
     * @returns a number in `[0, 1)`.
     */
    function pseudoRandom(index, salt) {
      const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453
      return value - Math.floor(value)
    }

    /**
     * Build the Canvas viewport: sky, ground, scenery, items, the visitor, the
     * four companions, and their names, all drawn with simple polygons.
     * @param canvas - the canvas element to paint.
     * @returns `update`, `setLabels`, `start`, `stop`, `pick`, and `destroy`.
     */
    function createRenderer(canvas) {
      const surface = canvas.getContext('2d')
      if (surface === null) throw new Error('QuadNest requires a 2D canvas context.')
      let width = 0
      let height = 0
      let dpr = 1
      let world = defaultWorld()
      let scene = 'beach'
      let target = 'star'
      let labels = {}
      let positions = {}
      let spots = []
      let stars = []
      let motes = []
      let view = { u: 1, ux: 46, uy: 22, cx: 0, cy: 0, unit: 40 }
      let running = false
      let rafId = 0
      let lastFrame = 0

      /** Read the projection for the current canvas size. */
      function metrics() {
        const u = Math.max(0.55, Math.min(1.8, Math.min(width / 660, height / 440)))
        return {
          u,
          ux: 46 * u,
          uy: 22 * u,
          cx: width * 0.5,
          cy: height * 0.58,
          unit: 40 * u,
        }
      }

      /**
       * Project one world coordinate onto the canvas.
       * @param v - projection metrics.
       * @param x - world x.
       * @param z - world z.
       * @param lift - height above the ground in world units.
       * @returns the canvas point.
       */
      function projectPoint(v, x, z, lift) {
        return {
          x: v.cx + (x - z) * v.ux,
          y: v.cy + (x + z) * v.uy - (lift ?? 0) * v.unit,
        }
      }

      /** Fill one polygon. */
      function poly(points, fill) {
        if (points.length < 3) return
        surface.beginPath()
        surface.moveTo(points[0].x, points[0].y)
        for (let index = 1; index < points.length; index += 1) {
          surface.lineTo(points[index].x, points[index].y)
        }
        surface.closePath()
        surface.fillStyle = fill
        surface.fill()
      }

      /** Fill one ellipse with optional transparency. */
      function dot(x, y, rx, ry, fill, alpha) {
        surface.save()
        surface.globalAlpha = typeof alpha === 'number' ? alpha : 1
        surface.beginPath()
        surface.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2)
        surface.fillStyle = fill
        surface.fill()
        surface.restore()
      }

      /** Rebuild stars and drifting motes for the current scene and size. */
      function buildSky() {
        stars = []
        motes = []
        const palette = SCENE_PALETTES[scene] ?? SCENE_PALETTES.beach
        if (palette.night) {
          for (let index = 0; index < 46; index += 1) {
            stars.push({
              x: pseudoRandom(index, 3) * width,
              y: pseudoRandom(index, 7) * height * 0.52,
              r: 0.7 + pseudoRandom(index, 11) * 1.7,
              p: pseudoRandom(index, 13) * 6.28,
            })
          }
        }
        for (let index = 0; index < 24; index += 1) {
          motes.push({
            x: pseudoRandom(index, 17) * width,
            y: height * (0.28 + pseudoRandom(index, 19) * 0.62),
            r: 0.9 + pseudoRandom(index, 23) * 2.4,
            p: pseudoRandom(index, 29) * 6.28,
            v: 0.4 + pseudoRandom(index, 31) * 0.8,
          })
        }
      }

      /** Resize the backing store to the CSS box and device pixel ratio. */
      function resize() {
        const box = canvas.getBoundingClientRect()
        width = Math.max(1, box.width)
        height = Math.max(1, box.height)
        const ratio = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
          ? window.devicePixelRatio
          : 1
        dpr = Math.max(1, Math.min(2.5, ratio))
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        surface.setTransform(dpr, 0, 0, dpr, 0, 0)
        view = metrics()
        buildSky()
      }

      /**
       * Adopt one world state and retarget the animated positions.
       * @param nextWorld - latest world from the page.
       */
      function update(nextWorld) {
        if (nextWorld === null || typeof nextWorld !== 'object') return
        const nextScene = SCENE_IDS.includes(nextWorld.scene) ? nextWorld.scene : scene
        if (nextScene !== scene) {
          scene = nextScene
          buildSky()
        }
        world = nextWorld
        target = nextWorld.target === 'group' ? 'group' : nextWorld.target
        for (const id of BOT_IDS) {
          const char = nextWorld.chars[id]
          if (char === undefined || char === null) continue
          const current = positions[id]
          if (current === undefined || current.scene !== char.scene) {
            positions[id] = {
              scene: char.scene,
              x: char.x,
              z: char.z,
              tx: char.tx,
              tz: char.tz,
              anim: char.anim,
              animAt: char.animAt,
              mood: MOOD_IDS.includes(char.mood) ? char.mood : 'neutral',
              moodAt: typeof char.moodAt === 'number' ? char.moodAt : 0,
            }
            continue
          }
          current.tx = char.tx
          current.tz = char.tz
          current.mood = MOOD_IDS.includes(char.mood) ? char.mood : 'neutral'
          current.moodAt = typeof char.moodAt === 'number' ? char.moodAt : 0
          if (char.anim !== current.anim || char.animAt !== current.animAt) {
            current.anim = char.anim
            current.animAt = char.animAt
          }
        }
      }

      /**
       * Replace the companion name labels.
       * @param next - companion id to display name.
       */
      function setLabels(next) {
        labels = next !== null && typeof next === 'object' ? next : {}
      }

      /** Move every character toward its target spot at walking speed. */
      function step(dt) {
        for (const id of BOT_IDS) {
          const pos = positions[id]
          if (pos === undefined) continue
          const dx = pos.tx - pos.x
          const dz = pos.tz - pos.z
          const distance = Math.sqrt(dx * dx + dz * dz)
          if (distance <= 0.02) {
            pos.x = pos.tx
            pos.z = pos.tz
            continue
          }
          const advance = Math.min(distance, 1.9 * dt)
          pos.x += (dx / distance) * advance
          pos.z += (dz / distance) * advance
        }
      }

      /**
       * Read one companion's pose for this frame.
       *
       * The animation decides the body and the mood decides the face: they are
       * independent, so a companion can wave while looking sad, and the face
       * fades back to neutral on its own after {@link MOOD_TTL_MS}.
       * @param id - companion id.
       * @param now - frame timestamp.
       * @returns offsets in canvas units before scaling, plus the face to wear.
       */
      function poseFor(id, now) {
        const pose = { lift: 0, armAngle: 0, headTurn: 0, headDip: 0, eyes: 1, hideLegs: false }
        const pos = positions[id]
        if (pos === undefined) return { ...pose, ...MOOD_FACES.neutral }
        const elapsed = now - pos.animAt
        const air = Math.sqrt((pos.tx - pos.x) ** 2 + (pos.tz - pos.z) ** 2)
        const mood = pos.moodAt > 0 && now - pos.moodAt < MOOD_TTL_MS ? pos.mood : 'neutral'
        const face = MOOD_FACES[mood] ?? MOOD_FACES.neutral
        if (air > 0.25) {
          Object.assign(pose, { lift: Math.abs(Math.sin(now / 150)) * 2, armAngle: -0.25 })
        } else {
          const pulse = Math.sin(elapsed / 220)
          switch (pos.anim) {
            case 'wave':
              if (elapsed <= 2400) pose.armAngle = -1.3 + pulse * 0.45
              break
            case 'tilt':
              if (elapsed <= 2400) Object.assign(pose, { headTurn: pulse * 0.5, headDip: 2 })
              break
            case 'sit':
              pose.hideLegs = true
              break
            case 'look':
              if (elapsed <= 2400) pose.headTurn = Math.sin(elapsed / 700) * 0.9
              break
            case 'jump':
              if (elapsed <= 2400) pose.lift = Math.max(0, Math.sin(elapsed / 480)) * 11
              break
            case 'quiet':
              Object.assign(pose, { headDip: 7, eyes: 0.4 })
              break
            default:
              break
          }
        }
        return {
          ...pose,
          headDip: pose.headDip + face.headDip,
          eyes: face.eyeAlpha !== undefined ? Math.min(pose.eyes, face.eyeAlpha) : pose.eyes,
          eyeStyle: face.eyeStyle,
          eyeScale: face.eyeScale,
        }
      }

      /** Paint the sky and any celestial body. */
      function drawSky(v, palette, now) {
        const gradient = surface.createLinearGradient(0, 0, 0, Math.max(1, height))
        gradient.addColorStop(0, palette.skyTop)
        gradient.addColorStop(0.62, palette.skyBottom)
        gradient.addColorStop(1, palette.skyBottom)
        surface.fillStyle = gradient
        surface.fillRect(0, 0, width, height)
        for (const star of stars) {
          const twinkle = 0.35 + Math.abs(Math.sin(now / 900 + star.p)) * 0.6
          dot(star.x, star.y, star.r, star.r, '#ffffff', twinkle)
        }
        const celestialX = width * (palette.night ? 0.24 : 0.8)
        const celestialY = height * 0.16
        dot(celestialX, celestialY, 24 * v.u, 24 * v.u, palette.night ? '#dfe6ff' : '#ffe9b0', 0.3)
        dot(celestialX, celestialY, 13 * v.u, 13 * v.u, palette.night ? '#f2f6ff' : '#fff4cf', 0.85)
      }

      /** Paint the faceted ground plane. */
      function drawGround(v, palette) {
        const extent = 14
        poly([
          projectPoint(v, -extent, -extent, 0),
          projectPoint(v, extent, -extent, 0),
          projectPoint(v, extent, extent, 0),
          projectPoint(v, -extent, extent, 0),
        ], palette.ground)
        for (let ix = -8; ix <= 6; ix += 2) {
          for (let iz = -8; iz <= 6; iz += 2) {
            poly([
              projectPoint(v, ix, iz, 0),
              projectPoint(v, ix + 1, iz, 0),
              projectPoint(v, ix, iz + 1, 0),
            ], palette.groundDark)
          }
        }
      }

      /** Paint drifting light specks in front of the ground. */
      function drawMotes(v, palette, now) {
        for (const mote of motes) {
          const x = mote.x + Math.sin(now / 2400 + mote.p) * 22 * mote.v * v.u
          const y = mote.y - ((now / 30 + mote.p * 30) % 60) * 0.5
          const alpha = 0.22 + Math.abs(Math.sin(now / 1100 + mote.p)) * 0.42
          dot(x, y, mote.r * v.u, mote.r * v.u, palette.accent, alpha)
        }
      }

      /** Paint one scenery prop. */
      function drawProp(v, prop, now) {
        const foot = projectPoint(v, prop.x, prop.z, 0)
        const s = v.u * (typeof prop.scale === 'number' ? prop.scale : 1)
        switch (prop.kind) {
          case 'tree': {
            surface.fillStyle = '#6b4a2f'
            surface.fillRect(foot.x - 3 * s, foot.y - 46 * s, 6 * s, 46 * s)
            poly([
              { x: foot.x, y: foot.y - 90 * s },
              { x: foot.x - 24 * s, y: foot.y - 50 * s },
              { x: foot.x + 24 * s, y: foot.y - 50 * s },
            ], '#3f7a4d')
            poly([
              { x: foot.x, y: foot.y - 74 * s },
              { x: foot.x - 19 * s, y: foot.y - 36 * s },
              { x: foot.x + 19 * s, y: foot.y - 36 * s },
            ], '#4c8c59')
            break
          }
          case 'palm': {
            surface.strokeStyle = '#7a5735'
            surface.lineWidth = 5 * s
            surface.beginPath()
            surface.moveTo(foot.x, foot.y)
            surface.quadraticCurveTo(foot.x - 4 * s, foot.y - 32 * s, foot.x + 6 * s, foot.y - 60 * s)
            surface.stroke()
            const top = { x: foot.x + 6 * s, y: foot.y - 60 * s }
            surface.strokeStyle = '#3f8f63'
            for (const angle of [-2.5, -2.0, -1.5, -1.0, -0.5]) {
              surface.lineWidth = 5 * s
              surface.beginPath()
              surface.moveTo(top.x, top.y)
              surface.quadraticCurveTo(
                top.x + Math.cos(angle) * 24 * s,
                top.y + Math.sin(angle) * 20 * s,
                top.x + Math.cos(angle) * 40 * s,
                top.y + Math.sin(angle) * 28 * s,
              )
              surface.stroke()
            }
            break
          }
          case 'cabin': {
            surface.fillStyle = '#6f5139'
            surface.fillRect(foot.x - 34 * s, foot.y - 44 * s, 68 * s, 44 * s)
            poly([
              { x: foot.x - 44 * s, y: foot.y - 44 * s },
              { x: foot.x, y: foot.y - 72 * s },
              { x: foot.x + 44 * s, y: foot.y - 44 * s },
            ], '#8a4c3f')
            surface.fillStyle = '#f6ce7d'
            surface.fillRect(foot.x - 8 * s, foot.y - 30 * s, 16 * s, 16 * s)
            break
          }
          case 'rock':
          case 'stone': {
            const scale = prop.kind === 'stone' ? 0.55 : 1
            poly([
              { x: foot.x - 20 * s * scale, y: foot.y },
              { x: foot.x - 12 * s * scale, y: foot.y - 24 * s * scale },
              { x: foot.x + 5 * s * scale, y: foot.y - 28 * s * scale },
              { x: foot.x + 20 * s * scale, y: foot.y },
            ], '#5c5f72')
            poly([
              { x: foot.x - 12 * s * scale, y: foot.y - 24 * s * scale },
              { x: foot.x + 5 * s * scale, y: foot.y - 28 * s * scale },
              { x: foot.x + 1 * s * scale, y: foot.y - 12 * s * scale },
            ], '#73778d')
            break
          }
          case 'crystal': {
            poly([
              { x: foot.x, y: foot.y - 38 * s },
              { x: foot.x - 9 * s, y: foot.y },
              { x: foot.x + 9 * s, y: foot.y },
            ], '#8f7dff')
            dot(foot.x, foot.y - 18 * s, 15 * s, 9 * s, '#8f7dff', 0.22)
            break
          }
          case 'flower': {
            surface.strokeStyle = '#4f8a4a'
            surface.lineWidth = 2 * s
            surface.beginPath()
            surface.moveTo(foot.x, foot.y)
            surface.lineTo(foot.x, foot.y - 16 * s)
            surface.stroke()
            for (let index = 0; index < 5; index += 1) {
              const angle = (index / 5) * Math.PI * 2
              dot(foot.x + Math.cos(angle) * 5 * s, foot.y - 16 * s + Math.sin(angle) * 5 * s, 3.2 * s, 3.2 * s, '#f7a6c4')
            }
            dot(foot.x, foot.y - 16 * s, 2.6 * s, 2.6 * s, '#f7d86b')
            break
          }
          case 'bush': {
            dot(foot.x - 12 * s, foot.y - 8 * s, 14 * s, 10 * s, '#4b8657')
            dot(foot.x + 10 * s, foot.y - 6 * s, 16 * s, 11 * s, '#568f5f')
            break
          }
          case 'mushroom': {
            surface.fillStyle = '#f0e6d2'
            surface.fillRect(foot.x - 2 * s, foot.y - 14 * s, 4 * s, 14 * s)
            dot(foot.x, foot.y - 16 * s, 11 * s, 7 * s, '#b06cf0')
            break
          }
          case 'starfish': {
            for (let index = 0; index < 5; index += 1) {
              const angle = -Math.PI / 2 + (index / 5) * Math.PI * 2
              poly([
                { x: foot.x, y: foot.y - 4 * s },
                { x: foot.x + Math.cos(angle) * 10 * s - 2 * s, y: foot.y + Math.sin(angle) * 10 * s - 4 * s },
                { x: foot.x + Math.cos(angle) * 10 * s + 2 * s, y: foot.y + Math.sin(angle) * 10 * s - 4 * s },
              ], '#f0a08a')
            }
            break
          }
          case 'driftwood': {
            surface.strokeStyle = '#a78561'
            surface.lineWidth = 6 * s
            surface.beginPath()
            surface.moveTo(foot.x - 20 * s, foot.y)
            surface.quadraticCurveTo(foot.x, foot.y - 12 * s, foot.x + 22 * s, foot.y - 2 * s)
            surface.stroke()
            surface.lineWidth = 3 * s
            surface.beginPath()
            surface.moveTo(foot.x + 5 * s, foot.y - 8 * s)
            surface.lineTo(foot.x + 16 * s, foot.y - 24 * s)
            surface.stroke()
            break
          }
          case 'firepit': {
            dot(foot.x, foot.y, 18 * s, 7 * s, '#4a3b33')
            const flame = 1 + Math.sin(now / 200) * 0.18
            poly([
              { x: foot.x, y: foot.y - 30 * s * flame },
              { x: foot.x - 9 * s, y: foot.y - 4 * s },
              { x: foot.x + 9 * s, y: foot.y - 4 * s },
            ], '#ff9f43')
            poly([
              { x: foot.x, y: foot.y - 20 * s * flame },
              { x: foot.x - 5 * s, y: foot.y - 4 * s },
              { x: foot.x + 5 * s, y: foot.y - 4 * s },
            ], '#ffd479')
            break
          }
          default:
            break
        }
      }

      /** Paint one loose item and register it as clickable. */
      function drawItem(v, entry, now) {
        const foot = projectPoint(v, entry.x, entry.z, 0)
        const s = v.u
        const bob = Math.sin(now / 520 + entry.x * 3) * 2.2 * s
        const y = foot.y - 9 * s + bob
        const color = ITEM_COLORS[entry.item] ?? '#ffffff'
        dot(foot.x, foot.y, 9 * s, 4 * s, 'rgba(0,0,0,0.2)')
        dot(foot.x, y, 13 * s, 9 * s, color, 0.18)
        switch (entry.item) {
          case 'shell': {
            surface.fillStyle = color
            surface.beginPath()
            surface.arc(foot.x, y, 7 * s, Math.PI, Math.PI * 2)
            surface.fill()
            surface.strokeStyle = '#d9ab8a'
            surface.lineWidth = Math.max(0.8, 1 * s)
            for (let index = 0; index < 3; index += 1) {
              surface.beginPath()
              surface.moveTo(foot.x, y)
              surface.lineTo(foot.x + (index - 1) * 5 * s, y - 6 * s)
              surface.stroke()
            }
            break
          }
          case 'flower': {
            for (let index = 0; index < 5; index += 1) {
              const angle = (index / 5) * Math.PI * 2 + now / 2600
              dot(foot.x + Math.cos(angle) * 5 * s, y + Math.sin(angle) * 5 * s, 3.4 * s, 3.4 * s, color)
            }
            dot(foot.x, y, 2.6 * s, 2.6 * s, '#f7d86b')
            break
          }
          case 'torch': {
            surface.strokeStyle = '#a06a3a'
            surface.lineWidth = 2.6 * s
            surface.beginPath()
            surface.moveTo(foot.x, y + 6 * s)
            surface.lineTo(foot.x + 2 * s, y - 3 * s)
            surface.stroke()
            dot(foot.x + 2 * s, y - 7 * s, 3.4 * s, 5 * s, color)
            break
          }
          case 'book': {
            surface.fillStyle = '#f3efe6'
            surface.fillRect(foot.x - 7 * s, y - 3 * s, 14 * s, 9 * s)
            surface.fillStyle = color
            surface.fillRect(foot.x - 7 * s, y - 6 * s, 14 * s, 3 * s)
            break
          }
          case 'gem': {
            poly([
              { x: foot.x, y: y - 9 * s },
              { x: foot.x - 7 * s, y: y + 1 * s },
              { x: foot.x, y: y + 7 * s },
              { x: foot.x + 7 * s, y: y + 1 * s },
            ], color)
            poly([
              { x: foot.x, y: y - 9 * s },
              { x: foot.x, y: y + 7 * s },
              { x: foot.x + 7 * s, y: y + 1 * s },
            ], '#b7fff6')
            break
          }
          case 'lantern': {
            surface.fillStyle = color
            surface.fillRect(foot.x - 5 * s, y - 7 * s, 10 * s, 12 * s)
            surface.fillStyle = '#6b5130'
            surface.fillRect(foot.x - 6 * s, y - 9 * s, 12 * s, 2 * s)
            surface.fillRect(foot.x - 6 * s, y + 5 * s, 12 * s, 2 * s)
            break
          }
          default:
            break
        }
        spots.push({ kind: 'item', id: entry.id, x: foot.x, y, r: 18 * s })
      }

      /** Paint one companion robot and register it as clickable. */
      function drawBot(v, id, pos, pose, selected, now) {
        const spec = BOTS.find(bot => bot.id === id)
        if (spec === undefined) return
        const foot = projectPoint(v, pos.x, pos.z, 0)
        const s = v.u
        const legH = pose.hideLegs ? 0 : 8 * s
        const bodyBottom = foot.y - legH - pose.lift * s
        const bodyTop = bodyBottom - 20 * s
        const bodyW = 22 * s
        dot(foot.x, foot.y, 17 * s, 7 * s, 'rgba(0,0,0,0.24)')
        if (selected) {
          surface.save()
          surface.strokeStyle = spec.glow
          surface.globalAlpha = 0.6 + Math.sin(now / 380) * 0.3
          surface.lineWidth = 2 * s
          surface.beginPath()
          surface.ellipse(foot.x, foot.y, 20 * s, 8 * s, 0, 0, Math.PI * 2)
          surface.stroke()
          surface.restore()
        }
        if (!pose.hideLegs) {
          surface.fillStyle = spec.dark
          surface.fillRect(foot.x - 8 * s, bodyBottom, 6 * s, legH)
          surface.fillRect(foot.x + 2 * s, bodyBottom, 6 * s, legH)
        }
        surface.fillStyle = spec.dark
        surface.fillRect(foot.x - bodyW / 2, bodyTop, bodyW, 20 * s)
        surface.fillStyle = spec.body
        surface.fillRect(foot.x - bodyW / 2 + 3 * s, bodyTop + 2 * s, bodyW - 6 * s, 16 * s)
        dot(foot.x, bodyTop + 10 * s, 5 * s, 2 * s, spec.glow, 0.55)
        surface.save()
        surface.translate(foot.x - bodyW / 2 + 1 * s, bodyTop + 5 * s)
        surface.rotate(pose.armAngle)
        surface.fillStyle = spec.dark
        surface.fillRect(-3 * s, 0, 6 * s, 12 * s)
        surface.restore()
        surface.save()
        surface.translate(foot.x + bodyW / 2 - 1 * s, bodyTop + 5 * s)
        surface.rotate(-pose.armAngle * 0.7)
        surface.fillStyle = spec.dark
        surface.fillRect(-3 * s, 0, 6 * s, 12 * s)
        surface.restore()
        const headShift = pose.headTurn * 6 * s
        const headY = bodyTop - 13 * s + pose.headDip * s
        const headW = 17 * s
        surface.fillStyle = spec.body
        surface.fillRect(foot.x - headW / 2 + headShift, headY, headW, 13 * s)
        surface.fillStyle = spec.dark
        surface.fillRect(foot.x - headW / 2 + headShift, headY + 10 * s, headW, 3 * s)
        surface.fillStyle = '#1c2431'
        surface.fillRect(foot.x - 7 * s + headShift, headY + 3 * s, 14 * s, 6 * s)
        surface.save()
        surface.globalAlpha = pose.eyes
        const eyeScale = typeof pose.eyeScale === 'number' ? pose.eyeScale : 1
        if (pose.eyeStyle === 'smile') {
          surface.strokeStyle = spec.glow
          surface.lineWidth = Math.max(1, 1.6 * s)
          for (const dx of [-3, 3]) {
            surface.beginPath()
            surface.arc(foot.x + dx * s + headShift, headY + 6 * s, 2.1 * s, Math.PI * 0.15, Math.PI * 0.85)
            surface.stroke()
          }
        } else if (pose.eyeStyle === 'slant') {
          surface.strokeStyle = spec.glow
          surface.lineWidth = Math.max(1, 1.5 * s)
          surface.beginPath()
          surface.moveTo(foot.x - 4.4 * s + headShift, headY + 5 * s)
          surface.lineTo(foot.x - 1.4 * s + headShift, headY + 7.2 * s)
          surface.moveTo(foot.x + 4.4 * s + headShift, headY + 5 * s)
          surface.lineTo(foot.x + 1.4 * s + headShift, headY + 7.2 * s)
          surface.stroke()
        } else {
          dot(foot.x - 3 * s + headShift, headY + 6 * s, 1.7 * s * eyeScale, 1.7 * s * eyeScale, spec.glow)
          dot(foot.x + 3 * s + headShift, headY + 6 * s, 1.7 * s * eyeScale, 1.7 * s * eyeScale, spec.glow)
        }
        surface.restore()
        surface.strokeStyle = spec.dark
        surface.lineWidth = Math.max(1, 1.6 * s)
        surface.beginPath()
        surface.moveTo(foot.x + headShift, headY)
        surface.lineTo(foot.x + headShift, headY - 7 * s)
        surface.stroke()
        dot(foot.x + headShift, headY - 8 * s, 2.4 * s, 2.4 * s, spec.glow, 0.9)
        spots.push({ kind: 'bot', id, x: foot.x, y: bodyTop - 4 * s, r: 22 * s })
      }

      /** Paint the visitor at the scene's entrance spot. */
      function drawPlayer(v, now) {
        const spot = sceneLayout(scene).player
        const foot = projectPoint(v, spot.x, spot.z, 0)
        const s = v.u
        const bob = Math.sin(now / 720) * 1.2 * s
        const y = foot.y - bob
        dot(foot.x, foot.y, 13 * s, 6 * s, 'rgba(0,0,0,0.22)')
        surface.fillStyle = '#2f2a35'
        surface.fillRect(foot.x - 7 * s, y - 10 * s, 6 * s, 10 * s)
        surface.fillRect(foot.x + 1 * s, y - 10 * s, 6 * s, 10 * s)
        surface.fillStyle = '#5b8fd1'
        surface.fillRect(foot.x - 9 * s, y - 28 * s, 18 * s, 18 * s)
        const headY = y - 34 * s
        dot(foot.x, headY, 7 * s, 7 * s, '#f2c9a0')
        surface.fillStyle = '#2f2a35'
        surface.beginPath()
        surface.arc(foot.x, headY - 1 * s, 7 * s, Math.PI, Math.PI * 2)
        surface.fill()
      }

      /** Paint every companion's name above its head. */
      function drawLabels(v, now) {
        const s = v.u
        surface.font = `${Math.max(10, Math.round(12 * s))}px ui-sans-serif, system-ui, sans-serif`
        surface.textAlign = 'center'
        surface.textBaseline = 'middle'
        for (const id of BOT_IDS) {
          const pos = positions[id]
          if (pos === undefined || pos.scene !== scene) continue
          const foot = projectPoint(v, pos.x, pos.z, 0)
          const pose = poseFor(id, now)
          const legH = pose.hideLegs ? 0 : 8 * s
          const bodyBottom = foot.y - legH - pose.lift * s
          const headTop = bodyBottom - 20 * s - 13 * s + pose.headDip * s
          const label = labels[id] ?? id
          surface.fillStyle = 'rgba(0,0,0,0.55)'
          surface.fillText(label, foot.x + 1, headTop - 9 * s + 1)
          surface.fillStyle = '#ffffff'
          surface.fillText(label, foot.x, headTop - 9 * s)
        }
      }

      /** Paint one complete frame. */
      function draw(now) {
        view = metrics()
        spots = []
        const v = view
        const palette = SCENE_PALETTES[scene] ?? SCENE_PALETTES.beach
        surface.clearRect(0, 0, width, height)
        drawSky(v, palette, now)
        drawGround(v, palette)
        drawMotes(v, palette, now)
        const entities = []
        for (const prop of sceneLayout(scene).props) {
          entities.push({ depth: prop.x + prop.z, paint: () => drawProp(v, prop, now) })
        }
        for (const entry of world.items) {
          if (entry.scene !== scene) continue
          entities.push({ depth: entry.x + entry.z + 0.2, paint: () => drawItem(v, entry, now) })
        }
        for (const id of BOT_IDS) {
          const pos = positions[id]
          if (pos === undefined || pos.scene !== scene) continue
          entities.push({
            depth: pos.x + pos.z + 0.35,
            paint: () => drawBot(v, id, pos, poseFor(id, now), target === id, now),
          })
        }
        const spot = sceneLayout(scene).player
        entities.push({ depth: spot.x + spot.z + 0.4, paint: () => drawPlayer(v, now) })
        entities.sort((left, right) => left.depth - right.depth)
        for (const entity of entities) entity.paint()
        drawLabels(v, now)
      }

      /** Advance one animation frame. */
      function frame(now) {
        if (!running) return
        const dt = lastFrame === 0 ? 0.016 : Math.min(0.06, (now - lastFrame) / 1000)
        lastFrame = now
        step(dt)
        draw(now)
        rafId = requestAnimationFrame(frame)
      }

      /** Start the animation loop after a resize. */
      function start() {
        if (running) return
        running = true
        lastFrame = 0
        resize()
        if (typeof requestAnimationFrame !== 'function') {
          draw(Date.now())
          return
        }
        rafId = requestAnimationFrame(frame)
      }

      /** Stop the animation loop. */
      function stop() {
        running = false
        if (rafId !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
        rafId = 0
      }

      /**
       * Find the character or item under one canvas-relative click.
       * @param x - click x in CSS pixels relative to the canvas.
       * @param y - click y in CSS pixels relative to the canvas.
       * @returns the nearest hit, or null.
       */
      function pick(x, y) {
        let best = null
        let bestDistance = Infinity
        for (const spot of spots) {
          const dx = x - spot.x
          const dy = y - spot.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance > spot.r) continue
          if (distance < bestDistance) {
            best = spot
            bestDistance = distance
          }
        }
        return best === null ? null : { kind: best.kind, id: best.id }
      }

      /** Release the observer and the frame loop. */
      function destroy() {
        stop()
        if (observer !== null) observer.disconnect()
        if (typeof window !== 'undefined') window.removeEventListener('resize', resize)
      }

      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null
      if (observer !== null) observer.observe(canvas)
      if (typeof window !== 'undefined') window.addEventListener('resize', resize)
      surface.imageSmoothingEnabled = true
      resize()
      return {
        update,
        setLabels,
        start,
        stop,
        pick,
        destroy,
      }
    }
    const { useState, useEffect, useMemo, useRef } = React

    /**
     * Read the displayed name of one chat target.
     * @param target - companion id or `group`.
     * @param t - locale translator.
     * @returns the display name.
     */
    function targetName(target, t) {
      return target === 'group' ? t('groupSpeaker') : t(labelKey('bot', target))
    }

    /**
     * Append the transcript notes produced by one world change.
     * @param world - world to append to.
     * @param notes - `{ text, at }` notes from a world reducer.
     * @returns the world carrying every note.
     */
    function pushNotes(world, notes) {
      let next = world
      for (const note of Array.isArray(notes) ? notes : []) {
        if (note === null || typeof note !== 'object' || typeof note.text !== 'string') continue
        next = appendMessage(next, { kind: 'note', text: note.text, at: note.at })
      }
      return next
    }

    /**
     * Decide whether a companion should speak first.
     * @param input - the visitor's quiet interval and any pending input.
     * @param input.lastActivityAt - when the visitor last acted or a companion last spoke.
     * @param input.now - the clock reading used for this check.
     * @param input.idleMs - how long the world stays quiet before a companion speaks.
     * @param input.busy - whether a reply is already in flight.
     * @param input.draft - the unsent composer text.
     * @param input.visible - whether the page is the visible document.
     * @param input.holdUntil - clock reading before which the host asked not to be asked again.
     * @returns true when an unsolicited turn should start now.
     */
    function shouldOpenConversation(input) {
      if (input.busy) return false
      if (input.draft.trim() !== '') return false
      if (!input.visible) return false
      if (Number.isFinite(input.holdUntil) && input.now < input.holdUntil) return false
      return input.now - input.lastActivityAt >= input.idleMs
    }

    /**
     * The QuadNest page: transcript and composer on the left, the animated
     * world on the right, plus scene travel, the backpack, and world reset.
     * @param props - slot props with `ctx` and the bound locale translator `t`.
     * @returns the page element.
     */
    function QuadNestPage(props) {
      const ctx = props.ctx
      const t = props.t
      const [world, setWorld] = useState(loadWorld)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState(null)
      const [bagOpen, setBagOpen] = useState(false)
      const [memoryOpen, setMemoryOpen] = useState(false)
      const [memory, setMemory] = useState(null)
      const [recall, setRecall] = useState(null)
      const [memoryQuery, setMemoryQuery] = useState('')
      const [memoryBusy, setMemoryBusy] = useState(false)
      const [confirmReset, setConfirmReset] = useState(false)
      const worldRef = useRef(world)
      const canvasRef = useRef(null)
      const rendererRef = useRef(null)
      // Every in-flight turn, not just the latest one: an unsolicited opening and
      // a reply to the visitor can overlap, and the second must not steal the
      // first's abort handle (which would leave the first unable to cancel and
      // its reply unstoppable).
      const requestsRef = useRef(new Set())
      const listRef = useRef(null)
      const idleSeqRef = useRef(0)
      const lastActivityRef = useRef(Date.now())
      const idleHoldRef = useRef(0)

      const labels = useMemo(() => ({
        star: t('botStar'),
        suyou: t('botSuyou'),
        spirit: t('botSpirit'),
        nook: t('botNook'),
      }), [t])

      /** Store a world change and persist it for the next visit. */
      const commit = (updater) => {
        const next = typeof updater === 'function' ? updater(worldRef.current) : updater
        const stamped = { ...next, updatedAt: Date.now() }
        lastActivityRef.current = Date.now()
        worldRef.current = stamped
        saveWorld(stamped)
        setWorld(stamped)
      }

      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        fetch(STATUS_ROUTE, { signal: controller.signal, cache: 'no-store' })
          .then(response => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!alive) return
            setStatus(payload !== null && typeof payload === 'object' ? payload : null)
          })
          .catch(() => {
            if (alive) setStatus(null)
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [])

      useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return
        const renderer = createRenderer(canvas)
        rendererRef.current = renderer
        renderer.setLabels(labels)
        renderer.update(worldRef.current)
        renderer.start()
        return () => {
          renderer.destroy()
          rendererRef.current = null
        }
        // The renderer lives for the page's lifetime and receives world updates below.
      }, [])

      useEffect(() => {
        const renderer = rendererRef.current
        if (renderer === null) return
        renderer.setLabels(labels)
        renderer.update(world)
      }, [world, labels])

      useEffect(() => {
        if (!confirmReset) return undefined
        const timer = setTimeout(() => setConfirmReset(false), 4000)
        return () => clearTimeout(timer)
      }, [confirmReset])

      // Read what the selected companion keeps, whenever the panel is open and
      // the selected target changes. Recall is a separate, on-demand call.
      useEffect(() => {
        if (!memoryOpen) return undefined
        let alive = true
        const controller = new AbortController()
        setMemoryBusy(true)
        setRecall(null)
        fetch(`${MEMORY_ROUTE}?target=${encodeURIComponent(world.target)}`, { signal: controller.signal, cache: 'no-store' })
          .then(response => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!alive) return
            setMemory(payload !== null && typeof payload === 'object' ? payload : null)
            setMemoryBusy(false)
          })
          .catch(() => {
            if (!alive) return
            // A companion that cannot be read is shown as empty rather than as an
            // error: the page itself still works.
            setMemory(null)
            setMemoryBusy(false)
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [memoryOpen, world.target])

      /**
       * Ask the host what this companion would be reminded of by a sentence.
       * The host answers with the same recall the turn prompt uses, so the panel
       * cannot drift from what the model actually sees.
       */
      async function searchMemory() {
        const query = memoryQuery.trim()
        if (query === '' || memoryBusy) return
        const target = worldRef.current.target
        setMemoryBusy(true)
        try {
          const response = await fetch(RECALL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target, query }),
          })
          const payload = await response.json().catch(() => null)
          setRecall(response.ok && payload !== null && typeof payload === 'object' ? payload : null)
        } catch {
          setRecall(null)
        } finally {
          setMemoryBusy(false)
        }
      }

      useEffect(() => {
        const list = listRef.current
        if (list !== null) list.scrollTop = list.scrollHeight
      }, [world.messages.length, busy])

      useEffect(() => () => {
        for (const controller of requestsRef.current) controller.abort()
        requestsRef.current.clear()
      }, [])

      /** Select the companion or group chat the next message goes to. */
      function selectTarget(target) {
        commit(previous => ({ ...previous, target }))
      }

      /** Move the visitor and the companions to another scene. */
      function travelTo(scene) {
        if (scene === worldRef.current.scene) return
        const result = applyActions(worldRef.current, [{ cmd: 'change_scene', target: 'all', params: { scene } }], t, Date.now())
        commit(pushNotes(result.world, result.notes))
      }

      /** Pick up whichever item was clicked in the viewport. */
      function onCanvasClick(event) {
        const renderer = rendererRef.current
        if (renderer === null) return
        const box = event.currentTarget.getBoundingClientRect()
        const hit = renderer.pick(event.clientX - box.left, event.clientY - box.top)
        if (hit === null) return
        if (hit.kind === 'bot') {
          commit(previous => ({ ...previous, target: hintTarget(previous.target, hit.id) }))
          return
        }
        const result = pickItem(worldRef.current, hit.id, t, Date.now())
        commit(pushNotes(result.world, result.notes))
      }

      /**
       * Keep the group chat selected when a companion is tapped in the group.
       * @param current - current target.
       * @param clicked - companion that was tapped.
       * @returns the target to store.
       */
      function hintTarget(current, clicked) {
        return current === 'group' ? 'group' : clicked
      }

      /**
       * Fold one successful host reply into the transcript and the world.
       * @param payload - host reply, carrying the turn id it answers.
       * @param requested - target the visitor spoke to.
       * @param turnId - turn id this request was sent with.
       */
      function applyReply(payload, requested, turnId) {
        const replies = Array.isArray(payload?.replies) ? payload.replies : []
        // The host echoes the id; if a proxy or an older host dropped it, the
        // request's own id is still the truth on this side.
        const turn = typeof payload?.turnId === 'string' && payload.turnId !== '' ? payload.turnId : turnId
        const stamp = Date.now()
        const moods = []
        let next = worldRef.current
        for (const reply of replies) {
          if (reply === null || typeof reply !== 'object') continue
          if (typeof reply.text !== 'string' || reply.text === '') continue
          const bot = BOT_IDS.includes(reply.bot)
            ? reply.bot
            : requested === 'group' ? undefined : requested
          const mood = MOOD_IDS.includes(reply.mood) ? reply.mood : undefined
          if (bot !== undefined && mood !== undefined) moods.push({ bot, mood })
          next = appendToTurn(next, turn, { kind: 'bot', bot, text: reply.text, at: stamp, mood })
        }
        const result = applyActions(next, payload?.actions, t, stamp)
        let updated = result.world
        if (moods.length > 0) {
          // The face outlives the bubble for a few seconds, then falls back to
          // neutral: a companion should look like it is reacting, not stuck.
          updated = { ...updated, chars: { ...updated.chars } }
          for (const entry of moods) {
            updated.chars[entry.bot] = { ...updated.chars[entry.bot], mood: entry.mood, moodAt: stamp }
          }
        }
        commit(pushNotes(updated, result.notes))
        if (payload !== null && typeof payload === 'object' && payload.model !== null && typeof payload.model === 'object') {
          setStatus(previous => ({ ...(previous ?? { ready: true }), ready: true, model: payload.model }))
        }
      }

      /** Send the drafted message to the current target. */
      async function send() {
        const text = draft.trim()
        if (text === '' || busy) return
        const requested = mentionedTarget(text) ?? worldRef.current.target
        // One id per question. It travels with the request and comes back on the
        // reply, so an answer that arrives after a later question still lands
        // under the question that caused it.
        const turnId = nextId('turn')
        commit({
          ...appendMessage(worldRef.current, { kind: 'user', bot: requested, text, at: Date.now(), turnId }),
          target: requested,
        })
        setDraft('')
        setBusy(true)
        const controller = new AbortController()
        requestsRef.current.add(controller)
        try {
          const response = await fetch(SAY_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ target: requested, text, world: wireWorld(worldRef.current), turnId }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) {
            const message = payload?.error?.message ?? `HTTP ${response.status}`
            throw new Error(message)
          }
          applyReply(payload, requested, turnId)
        } catch (error) {
          if (error.name !== 'AbortError') {
            const message = error instanceof Error && error.message !== '' ? error.message : String(error)
            commit(previous => appendToTurn(previous, turnId, { kind: 'error', text: t('error', { message }), at: Date.now() }))
          }
        } finally {
          requestsRef.current.delete(controller)
          setBusy(false)
        }
      }

      /** Clear the world after a second confirmation tap. */
      async function resetWorld() {
        if (!confirmReset) {
          setConfirmReset(true)
          return
        }
        setConfirmReset(false)
        setBagOpen(false)
        // A reset forgets the layers on the host, so an open memory panel would
        // be showing something that no longer exists.
        setMemoryOpen(false)
        setRecall(null)
        setMemory(null)
        commit(appendMessage(defaultWorld(Date.now()), { kind: 'note', text: t('resetDone'), at: Date.now() }))
        try {
          const response = await fetch(RESET_ROUTE, { method: 'POST' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        } catch (error) {
          const message = error instanceof Error && error.message !== '' ? error.message : String(error)
          commit(previous => appendMessage(previous, { kind: 'error', text: t('error', { message }), at: Date.now() }))
        }
      }

      /**
       * Let one companion speak first after the visitor has been quiet, so the
       * world keeps living instead of waiting for a prompt.
       *
       * The host answers with a decision, not only with words: `action: 'pass'`
       * means nobody should speak and carries how long to wait before asking
       * again. A pass is rendered as nothing at all — the visitor must never see
       * the machinery deciding to leave them alone.
       * @param quietMs - how long the visitor had been quiet when the poll fired.
       * @returns fulfillment after the unsolicited turn settles.
       */
      async function openConversation(quietMs) {
        const sequence = idleSeqRef.current
        idleSeqRef.current = sequence + 1
        const bot = BOT_IDS[sequence % BOT_IDS.length]
        // An unsolicited opening is a turn too: it gets its own id, so if the
        // visitor asks something while this is in flight, its bubbles still land
        // as an opening rather than as an answer to the new question.
        const turnId = nextId('turn')
        const controller = new AbortController()
        requestsRef.current.add(controller)
        setBusy(true)
        try {
          const response = await fetch(IDLE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              target: bot,
              world: wireWorld(worldRef.current),
              quietMs: Math.max(0, Number.isFinite(quietMs) ? quietMs : 0),
              drafting: false,
              turnId,
            }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) {
            holdIdle(60_000)
            return
          }
          if (payload !== null && typeof payload === 'object' && payload.action === 'pass') {
            holdIdle(payload.retryAfterMs)
            return
          }
          if (Array.isArray(payload?.replies) && payload.replies.length > 0) applyReply(payload, bot, turnId)
        } catch {
          // An unsolicited turn nobody asked for stays silent when it fails;
          // the next idle interval simply tries again.
        } finally {
          requestsRef.current.delete(controller)
          setBusy(false)
        }
      }

      /**
       * Keep the idle poll from asking again for a while.
       * @param retryAfterMs - backoff the host asked for, clamped to a sane range.
       */
      function holdIdle(retryAfterMs) {
        const delay = Number.isFinite(retryAfterMs) ? Math.min(Math.max(retryAfterMs, 15_000), 15 * 60_000) : 60_000
        idleHoldRef.current = Date.now() + delay
      }

      /** Give one carried item to the selected companion. */
      function give(item) {
        const target = worldRef.current.target
        if (!BOT_IDS.includes(target)) {
          commit(previous => appendMessage(previous, { kind: 'note', text: t('bagNoTarget'), at: Date.now() }))
          return
        }
        const result = giftItem(worldRef.current, item, target, t, Date.now())
        commit(pushNotes(result.world, result.notes))
      }

      /** Send on Enter, but leave Shift+Enter and IME composition to the field. */
      function onKeyDown(event) {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing) return
        event.preventDefault()
        send()
      }

      /** Return to the conversation page. */
      function goBack() {
        ctx.layout.selectPanel(null)
      }

      /** Render one transcript entry. */
      function renderMessage(message) {
        if (message.kind === 'user') {
          return h('div', { key: message.id, className: 'qn-msg qn-msg-user' }, message.text)
        }
        if (message.kind === 'error') {
          return h('div', { key: message.id, className: 'qn-msg qn-msg-error' }, message.text)
        }
        if (message.kind === 'note') {
          return h('div', { key: message.id, className: 'qn-msg qn-msg-note' }, message.text)
        }
        const spec = BOTS.find(bot => bot.id === message.bot)
        const style = spec === undefined ? undefined : { '--qn-bot': spec.body }
        return h('div', {
          key: message.id,
          className: 'qn-msg qn-msg-bot',
          style,
          'data-mood': message.mood ?? 'neutral',
        },
        h('span', { className: 'qn-msg-name' }, targetName(message.bot ?? 'group', t)),
        message.text,
        )
      }

      const currentScene = world.scene
      const modelName = status !== null && status.model !== null && typeof status.model === 'object' && typeof status.model.model === 'string'
        ? status.model.model
        : t('modelMissing')
      const idleDelay = status !== null && typeof status.idleMs === 'number' && Number.isFinite(status.idleMs) && status.idleMs >= 20_000
        ? status.idleMs
        : IDLE_FALLBACK_MS
      const canOpenConversation = status !== null && status.ready === true && status.model !== null && typeof status.model === 'object'

      useEffect(() => {
        if (!canOpenConversation) return undefined
        let cancelled = false
        // A short poll rather than one long timer: background windows throttle
        // long timeouts, and the visitor returning should not restart the wait.
        const tick = () => {
          if (cancelled || requestsRef.current.size > 0) return
          const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
          if (!shouldOpenConversation({
            lastActivityAt: lastActivityRef.current,
            now: Date.now(),
            idleMs: idleDelay,
            busy,
            draft,
            visible,
            holdUntil: idleHoldRef.current,
          })) return
          // Capture the quiet interval before clearing it: resetting the clock
          // first would tell the host the visitor had just spoken.
          const quietMs = Date.now() - lastActivityRef.current
          lastActivityRef.current = Date.now()
          openConversation(quietMs)
        }
        const timer = setInterval(tick, IDLE_TICK_MS)
        const onVisibility = () => tick()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [canOpenConversation, busy, idleDelay, draft])
      const typing = t('thinking', { name: targetName(world.target, t) })
      const bagTotal = ITEM_IDS.reduce((total, id) => total + (world.bag[id] ?? 0), 0)
      const chips = [{ id: 'group', label: t('targetGroup'), color: null }].concat(
        BOTS.map(bot => ({ id: bot.id, label: t(labelKey('bot', bot.id)), color: bot.body }),
        ),
      )

      /**
       * Read the layers to show: a recall result when one was asked for,
       * otherwise what is stored right now.
       * @returns Labelled sections with the lines to list; empty sections dropped.
       */
      function memorySections() {
        const layers = recall !== null && recall.layers !== null && typeof recall.layers === 'object'
          ? recall.layers
          : memory !== null && memory.layers !== null && typeof memory.layers === 'object' ? memory.layers : null
        if (layers === null) return []
        const texts = (value) => (Array.isArray(value) ? value.map(item => (item !== null && typeof item === 'object' ? String(item.text ?? '') : '')).filter(text => text !== '') : [])
        const recent = Array.isArray(layers.recent)
          ? layers.recent
            .filter(entry => entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && entry.text !== '')
            .map(entry => (typeof entry.label === 'string' && entry.label !== '' ? `${entry.label}：${entry.text}` : entry.text))
          : []
        return [
          { key: 'persona', label: t('memoryPersona'), items: texts(layers.persona) },
          { key: 'reflections', label: t('memoryReflections'), items: texts(layers.reflections) },
          { key: 'facts', label: t('memoryFacts'), items: texts(layers.facts) },
          { key: 'recent', label: t('memoryRecent'), items: recent },
        ].filter(section => section.items.length > 0)
      }

      const bagPanel = h('div', { className: 'qn-bag' },
        h('div', { className: 'qn-bag-head' },
          h('span', { className: 'qn-bag-title' }, `${t('bag')} ${bagTotal > 0 ? t('bagCount', { count: bagTotal }) : ''}`.trim()),
          h('button', { type: 'button', className: 'qn-bag-close', onClick: () => setBagOpen(false) }, t('bagClose')),
        ),
        bagTotal === 0
          ? h('p', { className: 'qn-bag-empty' }, t('bagEmpty'))
          : h('div', { className: 'qn-bag-list' },
            ITEM_IDS.map(id => h('div', { key: id, className: 'qn-bag-item' },
              h('span', { className: 'qn-bag-name' }, t(labelKey('item', id))),
              h('span', { className: 'qn-bag-count' }, t('bagCount', { count: world.bag[id] ?? 0 }),
              ),
              h('button', {
                type: 'button',
                className: 'qn-bag-give',
                disabled: (world.bag[id] ?? 0) <= 0 || !BOT_IDS.includes(world.target),
                onClick: () => give(id),
              }, t('bagGive', { name: targetName(world.target, t) }),
              ),
            )),
          ),
        BOT_IDS.includes(world.target)
          ? null
          : h('p', { className: 'qn-bag-empty' }, t('bagNoTarget')),
      )

      const sections = memoryOpen ? memorySections() : []
      const memoryPanel = h('div', { className: 'qn-memory' },
        h('div', { className: 'qn-memory-head' },
          h('span', { className: 'qn-memory-title' }, `${t('memory')} · ${targetName(world.target, t)}`),
          h('button', { type: 'button', className: 'qn-memory-close', onClick: () => setMemoryOpen(false) }, t('memoryClose')),
        ),
        h('p', { className: 'qn-memory-hint' }, t('memoryHint')),
        h('div', { className: 'qn-memory-search' },
          h('input', {
            className: 'qn-memory-input',
            value: memoryQuery,
            placeholder: t('memorySearch'),
            'aria-label': t('memorySearch'),
            onChange: event => setMemoryQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || event.isComposing) return
              event.preventDefault()
              searchMemory()
            },
          }),
          h('button', {
            type: 'button',
            className: 'qn-memory-ask',
            disabled: memoryBusy || memoryQuery.trim() === '',
            onClick: searchMemory,
          }, t('memoryAsk')),
        ),
        recall !== null && Array.isArray(recall.lines) && recall.lines.length === 0
          ? h('p', { className: 'qn-memory-empty' }, t('memorySearchEmpty'))
          : null,
        memoryBusy ? h('p', { className: 'qn-memory-empty' }, t('memoryLoading')) : null,
        ...sections.map(section => h('div', { key: section.key, className: 'qn-memory-group' },
          h('span', { className: 'qn-memory-label' }, section.label),
          ...section.items.map((item, index) => h('span', { key: `${section.key}-${index}`, className: 'qn-memory-item' }, item)),
        )),
        sections.length === 0 && !memoryBusy && recall === null
          ? h('p', { className: 'qn-memory-empty' }, t(world.target === 'group' ? 'memoryGroupHint' : 'memoryEmpty'))
          : null,
      )

      return h('div', { className: 'qn-root' },
        h('div', { className: 'qn-head' },
          h('div', { className: 'qn-head-text' },
            h('h1', { className: 'qn-title' }, t('title')),
            h('p', { className: 'qn-subtitle' }, t('subtitle')),
          ),
          h('div', { className: 'qn-head-actions' },
            h('span', { className: 'qn-model' }, `${t('model')} · ${modelName}`),
            h('button', { type: 'button', className: 'qn-ghost', onClick: goBack }, t('back')),
          ),
        ),
        h('div', { className: 'qn-body' },
          h('div', { className: 'qn-chat' },
            h('div', { className: 'qn-targets' },
              chips.map(chip => h('button', {
                key: chip.id,
                type: 'button',
                className: 'qn-chip',
                'aria-pressed': world.target === chip.id,
                onClick: () => selectTarget(chip.id),
              },
                chip.color === null
                  ? null
                  : h('span', { className: 'qn-dot', style: { '--qn-bot': chip.color } }),
                chip.label,
              )),
            ),
            h('div', { className: 'qn-messages', ref: listRef },
              world.messages.length === 0 && !busy
                ? h('div', { className: 'qn-empty' }, t('emptyChat'))
                : null,
              world.messages.map(renderMessage),
              busy ? h('div', { className: 'qn-msg qn-msg-bot qn-typing' }, typing) : null,
            ),
            h('div', { className: 'qn-composer' },
              h('textarea', {
                className: 'qn-input',
                value: draft,
                placeholder: t('placeholder'),
                maxLength: SEND_MAX_CHARS,
                'aria-label': t('placeholder'),
                onChange: (event) => {
                  lastActivityRef.current = Date.now()
                  setDraft(event.target.value)
                },
                onKeyDown,
              }),
              h('button', {
                type: 'button',
                className: 'qn-send',
                disabled: busy || draft.trim() === '',
                onClick: send,
              }, busy ? t('sending') : t('send')),
              h('div', { className: 'qn-hints' },
                h('span', null, t(labelKey('hint', currentScene))),
                h('span', null, t('hint')),
              ),
            ),
          ),
          h('div', { className: 'qn-stage' },
            h('canvas', { className: 'qn-canvas', ref: canvasRef, onClick: onCanvasClick }),
            h('div', { className: 'qn-scenebar' },
              SCENE_IDS.map(scene => h('button', {
                key: scene,
                type: 'button',
                className: 'qn-scene',
                'aria-pressed': scene === currentScene,
                onClick: () => travelTo(scene),
              }, t(labelKey('scene', scene)))),
            ),
            h('div', { className: 'qn-stage-actions' },
              h('button', {
                type: 'button',
                className: 'qn-ghost',
                'aria-pressed': memoryOpen,
                onClick: () => setMemoryOpen(open => !open),
              }, memoryOpen ? t('memoryClose') : t('memory')),
              h('button', {
                type: 'button',
                className: 'qn-ghost',
                onClick: () => setBagOpen(open => !open),
              }, bagOpen ? t('bagClose') : t('bag')),
              h('button', {
                type: 'button',
                className: 'qn-ghost',
                title: t('resetHint'),
                'aria-pressed': confirmReset,
                onClick: resetWorld,
              }, confirmReset ? t('resetConfirm') : t('reset')),
            ),
            bagOpen ? bagPanel : null,
            memoryOpen ? memoryPanel : null,
          ),
        ),
      )
    }

    /**
     * Draw the sidebar glyph: four companion dots nested under two arcs.
     * @param props - icon props supplied by the host (`size`, `className`).
     * @returns an inline SVG element.
     */
    function QuadNestArtwork(props) {
      const size = props && props.size ? props.size : 16
      const dot = (cx, cy, r) => h('circle', { cx, cy, r })
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        className: props ? props.className : undefined,
      },
      h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M3.2 13.4c1.6-3.6 4.3-5.4 8.8-5.4s7.2 1.8 8.8 5.4' }),
        h('path', { d: 'M4.8 16.2c1.3-2 3.6-3.1 6.8-3.1 3.2 0 5.7 1.1 7.4 3.1' }),
        dot(7.4, 8.4, 1.9),
        dot(16.6, 8.4, 1.9),
        dot(12, 5.6, 1.7),
        dot(12, 16.4, 1.9),
      ))
    }

    /**
     * Install the world stylesheet once, and remove it when the plugin unloads.
     * @param ctx - client plugin context.
     */
    function injectStyles(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-quadnest'
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'dsh-quadnest: styles')
    }

    /**
     * Register the dictionaries, the world page, and the left-sidebar entry.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quadnest: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, props => h(QuadNestPage, { ...props, ctx }))), 'dsh-quadnest: world page')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        locale: NS,
        label: () => t('panel'),
      }, QuadNestArtwork)), 'dsh-quadnest: sidebar row')

      injectStyles(ctx)
    }

    const inject = ['slots', 'locale', 'layout']
    const plugin = { inject, apply }
    if (typeof window !== 'undefined' && window.__DSH_QUADNEST_TEST__ === true) {
      plugin.__test = {
        QuadNestPage,
        dictionaries: { zh, en },
        defaultWorld,
        normalizeWorld,
        applyActions,
        appendMessage,
        appendToTurn,
        makeMessage,
        pickItem,
        giftItem,
        mentionedTarget,
        shouldOpenConversation,
        wireWorld,
        sceneLayout,
        labelKey,
      }
    }
    return plugin
  },
})

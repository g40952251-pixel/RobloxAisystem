'use strict';

// Roblox OpenAI + Gemini + Grok AI Backend
// Node.js 18+
// .env:
// OPENAI_API_KEY=...
// OPENAI_MODEL=gpt-5.2
// GEMINI_API_KEY=...
// ZENMUX_API_KEY=...
// ZENMUX_GROK_MODEL=x-ai/grok-4.6
// PORT=3000

const http = require('http');
const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
  throw new Error('Node.js 18+ lazimdir.');
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq < 1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      if (value.length >= 2) {
        const a = value[0];
        const b = value[value.length - 1];
        if ((a === '"' && b === '"') || (a === "'" && b === "'")) {
          value = value.slice(1, -1);
        }
      }

      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[ENV] .env oxunmadi:', err.message);
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.2').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const ZENMUX_API_KEY = String(process.env.ZENMUX_API_KEY || '').trim();
const ZENMUX_GROK_MODEL = String(process.env.ZENMUX_GROK_MODEL || 'x-ai/grok-4.6').trim();
const ROBLOX_TOOLBOX_API_KEY = String(process.env.ROBLOX_TOOLBOX_API_KEY || '').trim();

const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 5000;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;
const MAX_BODY_BYTES = 1024 * 1024;

const brains = new Map();
const studioQueue = [];
const studioCompleted = new Set();
let studioRequestId = 1;
const providerQueues = {
  gpt: Promise.resolve(),
  gemini: Promise.resolve(),
  grok: Promise.resolve(),
};
const lastProviderRequestAt = {
  gpt: 0,
  gemini: 0,
  grok: 0,
};
const MIN_GAP_MS = {
  gpt: 250,
  gemini: 1200,
  grok: 300,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function clampText(value, max = MAX_MESSAGE_CHARS) {
  return safeString(value).slice(0, max);
}

function normalizeProvider(value) {
  const s = String(value || '').toLowerCase();
  const compact = s.split(' ').join('').split('_').join('').split('-').join('');

  if (
    compact.includes('gemini') ||
    compact.includes('gemni') ||
    compact.includes('gemnii') ||
    compact.includes('gmini')
  ) {
    return 'gemini';
  }

  if (
    compact === 'grok' ||
    compact.includes('grok') ||
    compact.includes('gork')
  ) {
    return 'grok';
  }

  return 'gpt';
}

function getOwnerId(body) {
  if (!body || typeof body !== 'object') return 'unknown';
  return String(
    body.ownerUserId ??
    body.userId ??
    body.playerUserId ??
    body.playerId ??
    'unknown'
  );
}

function getOwnerName(body) {
  if (!body || typeof body !== 'object') return 'Oyuncu';
  return safeString(
    body.ownerName ?? body.playerName ?? body.username ?? 'Oyuncu',
    'Oyuncu'
  ).slice(0, 80);
}

function isActionMessage(message) {
  const m = String(message || '').toLowerCase();
  const words = [
    'build', 'tik', 'tikil', 'tikinti', 'qur', 'yarat', 'hazirla', 'dizayn', 'dizayn et', 'tasarla', 'make', 'create', 'construct', 'house', 'ev', 'tower', 'qelle',
    'qüllə', 'goz', 'göz', 'gez', 'gəz', 'wander', 'dayan', 'davam',
    'izle', 'izlə', 'follow', 'tp', 'teleport', 'tullan', 'jump', 'dance',
    'reqs', 'rəqs', 'toolbox', 'model', 'masin', 'maşın', 'vehicle', 'car',
    'gey', 'geyin', 'wear', 'paltar', 'sil', 'remove', 'clear', 'edit',
    'duzelt', 'düzəlt', 'outfit', 'script', 'server script', 'starterplayer', 'starterplayerscripts', 'localscript', 'local script', 'luau', 'kod yaz', 'script yaz', 'script sil', 'scripti sil', 'sil script', 'saga don', 'sağa dön', 'sola don',
    'sola dön', 'duz get', 'düz get', 'suret', 'sürət', 'takip', 'teqib', 'qucaq', 'hug', 'carry', 'dasima', 'qaldir', 'dans etdir', 'dance etdir', 'birlikde', 'birlikdə', 'dansimizi', 'danimizi', 'dans dayandir', 'dansi durdur', 'dansimizi durdur'
  ];
  return words.some(word => m.includes(word));
}

function compactWorld(world) {
  if (!world || typeof world !== 'object') return null;

  const out = {};

  if (Array.isArray(world.otherAIs)) {
    out.otherAIs = world.otherAIs.slice(0, 12).map(ai => ({
      provider: safeString(ai?.provider),
      ownerName: safeString(ai?.ownerName),
      distance: Number.isFinite(Number(ai?.distance)) ? Number(ai.distance) : null,
      position: ai?.position
        ? {
            x: Number(ai.position.x) || 0,
            y: Number(ai.position.y) || 0,
            z: Number(ai.position.z) || 0,
          }
        : null,
      state: safeString(ai?.state),
    }));
  }

  if (world.selfPosition) {
    out.selfPosition = {
      x: Number(world.selfPosition.x) || 0,
      y: Number(world.selfPosition.y) || 0,
      z: Number(world.selfPosition.z) || 0,
    };
  }

  if (world.ownerPosition) {
    out.ownerPosition = {
      x: Number(world.ownerPosition.x) || 0,
      y: Number(world.ownerPosition.y) || 0,
      z: Number(world.ownerPosition.z) || 0,
    };
  }

  if (Array.isArray(world.nearbyPlayers)) {
    out.nearbyPlayers = world.nearbyPlayers.slice(0, 20).map(p => ({
      name: safeString(p?.name),
      distance: Number.isFinite(Number(p?.distance)) ? Number(p.distance) : null,
      position: p?.position
        ? {
            x: Number(p.position.x) || 0,
            y: Number(p.position.y) || 0,
            z: Number(p.position.z) || 0,
          }
        : null,
    }));
  }

  if (Array.isArray(world.nearbyObjects)) {
    out.nearbyObjects = world.nearbyObjects.slice(0, 40).map(o => ({
      name: safeString(o?.name),
      type: safeString(o?.type),
      distance: Number.isFinite(Number(o?.distance)) ? Number(o.distance) : null,
      position: o?.position
        ? {
            x: Number(o.position.x) || 0,
            y: Number(o.position.y) || 0,
            z: Number(o.position.z) || 0,
          }
        : null,
      size: o?.size
        ? {
            x: Number(o.size.x) || 0,
            y: Number(o.size.y) || 0,
            z: Number(o.size.z) || 0,
          }
        : null,
    }));
  }

  if (world.vehicle) {
    out.vehicle = {
      name: safeString(world.vehicle.name),
      available: world.vehicle.available === true,
      occupied: world.vehicle.occupied === true,
      position: world.vehicle.position
        ? {
            x: Number(world.vehicle.position.x) || 0,
            y: Number(world.vehicle.position.y) || 0,
            z: Number(world.vehicle.position.z) || 0,
          }
        : null,
    };
  }

  if (world.time !== undefined) out.time = world.time;
  return out;
}

function compactAssets(assets) {
  if (!Array.isArray(assets)) return [];
  return assets.slice(0, 60).map(a => {
    if (typeof a === 'string') return a.slice(0, 150);
    return {
      name: safeString(a?.name),
      assetId: a?.assetId ?? a?.id ?? null,
      category: safeString(a?.category),
      source: safeString(a?.source),
    };
  });
}

function getBrain(ownerId, provider, incomingHistory) {
  const key = ownerId + ':' + provider;
  let brain = brains.get(key);

  if (!brain) {
    brain = { history: [], updatedAt: Date.now() };
    brains.set(key, brain);
  }

  if (brain.history.length === 0 && Array.isArray(incomingHistory)) {
    brain.history = incomingHistory
      .filter(x => x && (x.role === 'user' || x.role === 'assistant'))
      .map(x => ({
        role: x.role,
        content: clampText(String(x.content || ''), 3500),
      }))
      .slice(-MAX_HISTORY);
  }

  return brain;
}

function pushHistory(brain, role, content) {
  brain.history.push({
    role,
    content: clampText(content, 3500),
  });

  while (brain.history.length > MAX_HISTORY) {
    brain.history.shift();
  }

  brain.updatedAt = Date.now();
}

async function withProviderQueue(provider, fn) {
  const previous = providerQueues[provider] || Promise.resolve();
  let release;
  providerQueues[provider] = new Promise(resolve => {
    release = resolve;
  });

  try {
    await previous;

    const elapsed = Date.now() - lastProviderRequestAt[provider];
    const wait = MIN_GAP_MS[provider] - elapsed;
    if (wait > 0) await sleep(wait);

    lastProviderRequestAt[provider] = Date.now();
    return await fn();
  } finally {
    release();
  }
}

async function fetchJson(url, options, label) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      const text = await res.text();
      let data;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (res.ok) return data;

      const detail = data?.error?.message || data?.message || data?.raw || ('HTTP ' + res.status);
      const err = new Error(label + ' HTTP ' + res.status + ': ' + detail);
      err.status = res.status;
      lastError = err;

      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10000)
        : 800 * (attempt + 1);

      await sleep(wait);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        lastError = new Error(label + ': sorğu vaxt aşımına uğradı.');
        lastError.status = 408;
      } else {
        lastError = err;
      }

      if (attempt >= MAX_RETRIES) throw lastError;
      await sleep(700 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error(label + ': naməlum xəta');
}

function buildSystemPrompt({ provider, ownerName, world, assets, actionMode }) {
  const aiName = provider === 'gemini' ? 'Gemini' : provider === 'grok' ? 'Grok' : 'GPT';

  const base = [
    'Sən Roblox oyununda yaşayan müstəqil AI NPC-sən.',
    'Sənin adın ' + aiName + '-dir.',
    'Sənin sahibin ' + ownerName + '-dir.',
    '',
    'Qaydalar:',
    '- Cavabı əsasən Azərbaycan dilində ver.',
    '- Təbii, qısa və konkret danış.',
    '- Cavaba User:, Sage:, GPT:, Gemini: və ya [GPT]/[Gemini] kimi ad etiketi əlavə etmə.',
    '- Roblox dünyasını nəzərə al.',
    '- GPT və Gemini ayrı AI-lardır; yaddaşlarını qarışdırma.',
    '- Başqa AI-ların mövcudluğunu dünya məlumatından görə bilərsən.',
    '- Bir hərəkəti yerinə yetirmək üçün uyğun action qaytar.',
    '- Normal hərəkət teleport deyil; Roblox tərəfi WALK_TO, JUMP, FOLLOW və VEHICLE_DRIVE kimi fiziki icra etməlidir.',
    '- Dünya məlumatında maneə, player, model, maşın və digər obyektlər varsa, qərarında onlardan istifadə et.',
  ].join('\n');

  let context = '';
  if (world) {
    context += '\nDÜNYA MƏLUMATI:\n' + JSON.stringify(world) + '\n';
  }
  if (assets.length) {
    context += '\nƏLÇATAN ASSETLƏR:\n' + JSON.stringify(assets) + '\n';
  }

  if (actionMode) {
    context += `
\nCAVAB QAYDASI:
Yalnız bu JSON formasında cavab ver:
{
  "reply":"oyunçuya deyiləcək qısa cümlə",
  "actions":[
    {
      "type":"ACTION"
    }
  ]
}

İcazəli action tipləri:
STOP
STOP_DANCE
RESUME
FOLLOW
UNFOLLOW
COME
TELEPORT
JUMP
DANCE
DANCE_WITH_OWNER
HUG
CARRY
DROP
MOVE
WALK_TO
TURN
BUILD
TOOLBOX
WEAR
EDIT
REMOVE
CLEAR
CLEAR_OUTFIT
VEHICLE_ENTER
VEHICLE_EXIT
VEHICLE_DRIVE
STUDIO_SCRIPT_CREATE
STUDIO_SCRIPT_DELETE

STUDIO_SCRIPT_CREATE:
{"type":"STUDIO_SCRIPT_CREATE","scriptName":"OwnerPowerScript","scriptType":"Script|LocalScript|ModuleScript","targetService":"ServerScriptService|StarterPlayerScripts","targetName":"optional Part/Model name","targetPath":"optional Workspace path","prompt":"scriptin nə etməli olduğunu tam yaz"}

STUDIO_SCRIPT_DELETE:
{"type":"STUDIO_SCRIPT_DELETE","scriptName":"OwnerPowerScript","scriptType":"Script|LocalScript|ModuleScript","targetName":"optional Part/Model name","targetPath":"optional Workspace path","targetService":"ServerScriptService|StarterPlayerScripts"}

Vacib script qaydası:
- Yalnız ownerUserId üçün işləyən script yaz.
- Yeni script yarat; mövcud scripti özbaşına düzəltmə və ya overwrite etmə.
- Mövcud scripti yalnız istifadəçi açıq şəkildə silməyi istəyirsə sil.
- Server script üçün ServerScriptService və ya istifadəçi konkret obyekt deyirsə həmin Model/Part içini istifadə et.
- LocalScript yalnız LocalScript-in işlədiyi uyğun client konteynerində işləyir; istifadəçi maşının Modeli/Partı içində local davranış istəyirsə, uyğun client yerləşməsini nəzərə al.
- ModuleScript seçiləndə scriptType=ModuleScript qaytar. ModuleScript özü avtomatik işləmir, require olunması nəzərdə tutulur.
- İstifadəçi “maşının içindəki Part-a script yaz”, “evin Modelinə script yaz”, “bu Part-a yaz” deyirsə targetName və ya targetPath doldur.
- Studio-da seçilmiş obyekt varsa plugin onu da hədəf kimi istifadə edə bilər.
- Script source daxilində Owner UserId-ni sabit yoxla.
- Əgər istifadəçi konkret script adı verməyibsə, mənalı unikal ad seç.
- Script yaratmaq üçün yalnız yeni source qaytar; mövcud scripti düzəltmək və overwrite etmək istənmirsə etmə.
- Bütün AI scriptləri müvəqqətidir: AIEphemeral=true, deleteOnOwnerLeave=true, doNotPersist=true.

FOLLOW: {"type":"FOLLOW","target":"player adı və ya OWNER"}
DANCE_WITH_OWNER: {"type":"DANCE_WITH_OWNER"}
HUG: {"type":"HUG"}
CARRY: {"type":"CARRY"}
DROP: {"type":"DROP"}
STOP_DANCE: {"type":"STOP_DANCE"}
WALK_TO: {"type":"WALK_TO","position":[x,y,z],"distance":3}
TURN: {"type":"TURN","direction":"LEFT|RIGHT","degrees":90}
VEHICLE_ENTER: {"type":"VEHICLE_ENTER"}
VEHICLE_EXIT: {"type":"VEHICLE_EXIT"}
VEHICLE_DRIVE: {"type":"VEHICLE_DRIVE","target":"player adı və ya destination","follow":true}
BUILD: {"type":"BUILD","name":"UserRequestedObject","description":"istifadəçinin bütün detalı","parts":[{"shape":"Block|Ball|Cylinder|Wedge","size":[4,1,4],"offset":[0,0,0],"material":"Plastic","color":[255,255,255],"anchored":true,"name":"Part"}]}
TOOLBOX: {"type":"TOOLBOX","query":"specific decoration requested by user","count":1}
WEAR: {"type":"WEAR","assetId":123}
EDIT: {"type":"EDIT","target":"Part","properties":{"Size":[4,2,4],"Material":"Metal"}}
REMOVE: {"type":"REMOVE","target":"Part"}
CLEAR: sahibinin yaratdığın bütün BUILD və TOOLBOX obyektlərini sil.
CLEAR_OUTFIT: geyimi təmizlə.

UNIVERSAL BUILD QAYDASI:
- Tikinti yalnız "ev", "maşın", "qatar" kimi nümunələrlə məhdud deyil. İstifadəçi nə təsvir edirsə, onu yarat.
- İstifadəçinin ölçü, mərtəbə, otaq, qapı, pəncərə, mebel, mühərrik, təkər, oturacaq, rels, dam, dekorasiya və digər detallarını nəzərə al.
- Ev istənirsə yalnız çöl divarları yox, istifadəçi içini istəyirsə daxili də yarat.
- Maşın istənirsə kuzovla yanaşı təkər, oturacaq, sükan, şüşə, işıq və istifadəçinin istədiyi əlavə hissələri qur.
- Qatar istənirsə lokomotiv, vaqonlar, təkərlər və lazım olan detallar qur.
- Heç vaxt sorğuya uyğun olmayan hazır tipə keçmə; "spaceship" deyilirsə spaceship, "robot" deyilirsə robot, "shop" deyilirsə shop və s.
- BUILD action-da hissələri bir-bir Part kimi göstər. Model hazır asset kimi istifadə olunmamalıdır.
- İstifadəçi dekorasiya üçün Toolbox istəyirsə BUILD-dən sonra bir və ya bir neçə TOOLBOX action qaytara bilərsən.
- İstifadəçi ayrıca Toolbox istəməyibsə, tikintinin əsas gövdəsini BUILD parts ilə et.
- BUILD üçün istifadəçinin dediyi bütün detalları bir action-da mümkün qədər çox Part ilə təmsil et; limit 500 Part.
- Sayğac yalnız həqiqətən action.parts içində göndərilən və Roblox-da yaradılan Part sayına uyğun olacaq; saxta 0/10 və ya sabit 10 yazma.

Qeyd: İstifadəçi əmri nə qədər sərbəstdirsə, onu təhlil et və uyğun action qaytar. Mətndə nə etdiyini deməklə kifayətlənmə; action mütləq olsun.`;
  } else {
    context += '\nAdi söhbətdirsə actions boş array olsun.\n';
  }

  return (base + context).trim();
}

function parseModelJson(text) {
  let t = safeString(text).trim();
  if (!t) return null;

  if (t.startsWith('```')) {
    const firstNewline = t.indexOf('\n');
    if (firstNewline >= 0) t = t.slice(firstNewline + 1);
    if (t.endsWith('```')) t = t.slice(0, -3).trim();
  }

  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') return null;

  const out = { ...action };
  out.type = safeString(out.type).toUpperCase().trim();
  if (!out.type) return null;

  if (Array.isArray(out.position)) {
    out.position = out.position.slice(0, 3).map(n => Number(n) || 0);
  }
  if (Array.isArray(out.offset)) {
    out.offset = out.offset.slice(0, 3).map(n => Number(n) || 0);
  }
  if (Array.isArray(out.size)) {
    out.size = out.size.slice(0, 3).map(n => Math.max(0.1, Number(n) || 1));
  }
  if (Array.isArray(out.color)) {
    out.color = out.color.slice(0, 3).map(n => Math.max(0, Math.min(255, Number(n) || 0)));
  }
  if (Array.isArray(out.parts)) {
    out.parts = out.parts.slice(0, 500).map(part => ({
      ...part,
      shape: safeString(part?.shape, 'Block'),
      size: Array.isArray(part?.size)
        ? part.size.slice(0, 3).map(n => Math.max(0.1, Number(n) || 1))
        : [4, 1, 4],
      offset: Array.isArray(part?.offset)
        ? part.offset.slice(0, 3).map(n => Number(n) || 0)
        : [0, 0, 0],
      material: safeString(part?.material, 'Plastic'),
      color: Array.isArray(part?.color)
        ? part.color.slice(0, 3).map(n => Math.max(0, Math.min(255, Number(n) || 255)))
        : [255, 255, 255],
      anchored: part?.anchored !== false,
      name: safeString(part?.name, 'Part'),
    }));
  }

  if (out.scriptType !== undefined) out.scriptType = safeString(out.scriptType, 'Script');
  if (out.typeName !== undefined) out.typeName = safeString(out.typeName, 'Script');
  if (out.targetName !== undefined) out.targetName = safeString(out.targetName, '');
  if (out.targetPath !== undefined) out.targetPath = safeString(out.targetPath, '');

  if (out.degrees !== undefined) out.degrees = Math.max(1, Math.min(360, Number(out.degrees) || 90));
  if (out.distance !== undefined) out.distance = Math.max(1, Math.min(100, Number(out.distance) || 3));
  if (out.count !== undefined) out.count = Math.max(1, Math.min(10, Number(out.count) || 1));
  if (out.assetId !== undefined) out.assetId = Number(out.assetId) || 0;

  return out;
}

function cleanAIReply(text) {
  let s = String(text || '').trim();

  const prefixes = [
    'GPT:',
    'Gemini:',
    'Grok:',
    'User:',
    'USER:',
    'Sage:',
    'SAGE:',
    '[GPT]',
    '[Gemini]',
    '[Grok]',
    '[User]',
    '[Sage]',
  ];

  for (const prefix of prefixes) {
    if (s.toLowerCase().startsWith(prefix.toLowerCase())) {
      s = s.slice(prefix.length).trim();
    }
  }

  return s;
}

function normalizeModelOutput(rawText) {
  const parsed = parseModelJson(rawText);

  if (parsed && typeof parsed === 'object') {
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.map(normalizeAction).filter(Boolean)
      : [];

    return {
      reply: clampText(parsed.reply || parsed.message || parsed.text || 'Hazirdir.'),
      actions,
      raw: rawText,
    };
  }

  return {
    reply: clampText(rawText || 'Hazirdir.'),
    actions: [],
    raw: rawText,
  };
}

function normalizeTextForCommand(message) {
  return String(message || '')
    .trim()
    .toLowerCase()
    .split('ı').join('i')
    .split('ə').join('e')
    .split('ö').join('o')
    .split('ü').join('u')
    .split('ş').join('s')
    .split('ç').join('c');
}

function localCommand(message) {
  const m = normalizeTextForCommand(message);
  const result = { reply: '', actions: [], local: true };
  const hasAny = (...phrases) => phrases.some(p => m.includes(normalizeTextForCommand(p)));

  // TOOLBOX requests are handled deterministically so the AI cannot mistake
  // a Toolbox request for a server-script request.
  const wantsToolbox =
    m.includes('toolbox') ||
    m.includes('creator store') ||
    m.includes('creatorstore');

  if (wantsToolbox) {
    let query = String(message || '').trim();

    query = query
      .replace(/^.*?toolbox(?:dan|dən|dan|den)?/i, '')
      .replace(/^.*?creator\s*store/i, '')
      .replace(/^(dan|dən|den|de|da)\s*/i, '')
      .replace(/^(bir|bir dene|bir dənə|bir tane)\s+/i, '')
      .replace(/\b(gotur|getir|götür|get|yerlesdir|yerlesdir|yerləşdir|qoy|al|modeli|model)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!query) query = 'decoration';

    result.reply = 'Oldu, Toolbox-dan axtarıb götürürəm.';
    result.actions = [{
      type: 'TOOLBOX',
      query,
      count: 1,
    }];
    return result;
  }

  // Script requests remain deterministic.
  const wantsDeleteScript =
    m.includes('script sil') || m.includes('scripti sil') || m.includes('sil script') || m.includes('scripti poz');

  const wantsCreateScript =
    m.includes('script yaz') || m.includes('script yarat') || m.includes('script hazirla') ||
    m.includes('server script') || m.includes('starterplayer') || m.includes('localscript') ||
    m.includes('local script') || m.includes('modulescript') || m.includes('module script') ||
    m.includes('modulscript') || m.includes('modul script') || m.includes('luau kod') || m.includes('kod yaz');

  if (wantsDeleteScript) {
    result.reply = 'Oldu, öz yaratdığım scripti silirəm.';
    result.actions = [{
      type: 'STUDIO_SCRIPT_DELETE',
      prompt: m,
      scriptName: '',
      targetService: scriptTargetFromPrompt(message, ''),
    }];
    return result;
  }

  if (wantsCreateScript) {
    const scriptType = inferScriptType(message, '');
    const targetSpec = inferScriptTarget(message, '', '');
    result.reply = 'Oldu, dediyin məlumata görə yeni script hazırlayıram.';
    result.actions = [{
      type: 'STUDIO_SCRIPT_CREATE',
      prompt: message,
      scriptType,
      targetService: scriptTargetFromPrompt(message, ''),
      targetName: targetSpec.targetName,
      targetPath: targetSpec.targetPath,
    }];
    return result;
  }

  if (m === 'dayan' || m === 'dur' || m === 'stop' || hasAny('dans dayandir', 'dance dayandir', 'dansi dayandir', 'reqsi dayandir', 'dansimi durdur', 'dansimizi durdur', 'hareketi dayandir')) {
    result.reply = 'Oldu, hamısını dayandırdım.';
    result.actions = [{ type: 'STOP' }];
    return result;
  }

  if (hasAny('meni izleme', 'artiq izleme', 'artik izleme', 'follow off', 'follow dayandir', 'izlemeyi dayandir')) {
    result.reply = 'Oldu, səni izləməyi dayandırdım.';
    result.actions = [{ type: 'UNFOLLOW' }];
    return result;
  }

  if (hasAny('meni takip et', 'meni takip ele', 'meni teqib et', 'meni teqib ele', 'meni izle', 'izle meni', 'izlemeni', 'izlə məni', 'follow me', 'ardimca gel')) {
    result.reply = 'Oldu, səni izləyirəm.';
    result.actions = [{ type: 'FOLLOW', target: 'OWNER' }];
    return result;
  }

  if (hasAny('mene gel', 'bura gel', 'buraya gel', 'yanima gel', 'yanima gəl', 'come here')) {
    result.reply = 'Yanına gəlirəm.';
    result.actions = [{ type: 'COME' }];
    return result;
  }

  if (hasAny('mene tp ol', 'mene tp ele', 'mene teleport ol', 'mene teleport et', 'meni tp et', 'meni teleport et', 'yanima tp ol')) {
    result.reply = 'Yanına teleport oldum.';
    result.actions = [{ type: 'TELEPORT' }];
    return result;
  }

  if (hasAny('meni tullan', 'tullan', 'jump', 'hopla')) {
    result.reply = 'Oldu.';
    result.actions = [{ type: 'JUMP' }];
    return result;
  }

  if (hasAny('meni de dans etdir', 'meni de reqs etdir', 'məni də rəqs etdir', 'menimle dans et', 'menimle dance et', 'menimle reqs et', 'menimlə rəqs et', 'birlikde dans', 'birlikdə rəqs')) {
    result.reply = 'Oldu, birlikdə rəqs edirik!';
    result.actions = [{ type: 'DANCE_WITH_OWNER' }];
    return result;
  }

  if (hasAny('dans et', 'dance et', 'reqs et', 'rəqs et', 'dance', 'dans', 'reqs', 'rəqs')) {
    result.reply = 'Rəqs edirəm!';
    result.actions = [{ type: 'DANCE' }];
    return result;
  }

  if (hasAny('qucagina al', 'qucagima al', 'qucağına al', 'qucağıma al', 'meni qucagina al', 'məni qucağına al', 'hug me', 'hug')) {
    result.reply = 'Oldu, səni qucaqladım.';
    result.actions = [{ type: 'HUG' }];
    return result;
  }

  if (hasAny('meni dasi', 'meni daşı', 'meni dasima al', 'meni qaldir', 'məni qaldır', 'carry me', 'carry')) {
    result.reply = 'Oldu, səni qaldırdım.';
    result.actions = [{ type: 'CARRY' }];
    return result;
  }

  if (hasAny('burax meni', 'meni burax', 'birak meni', 'yere qoy meni', 'drop me', 'drop')) {
    result.reply = 'Oldu, buraxdım.';
    result.actions = [{ type: 'DROP' }];
    return result;
  }

  if (hasAny('duz get', 'düz get', 'irəli get', 'ileri get', 'get qabağa', 'get qabaqa')) {
    result.reply = 'İrəli gedirəm.';
    result.actions = [{ type: 'MOVE', direction: 'forward', duration: 3, speed: 8 }];
    return result;
  }

  if (hasAny('geri get', 'geriye get', 'geri')) {
    result.reply = 'Geri gedirəm.';
    result.actions = [{ type: 'MOVE', direction: 'back', duration: 3, speed: 8 }];
    return result;
  }

  if (hasAny('sola get', 'sol get', 'left')) {
    result.reply = 'Sola gedirəm.';
    result.actions = [{ type: 'MOVE', direction: 'left', duration: 2, speed: 8 }];
    return result;
  }

  if (hasAny('saga get', 'sağa get', 'saga don', 'sağa dön', 'right')) {
    result.reply = 'Sağa gedirəm.';
    result.actions = [{ type: 'MOVE', direction: 'right', duration: 2, speed: 8 }];
    return result;
  }

  if (m === 'clear' || m === 'her seyi sil' || m === 'hamisini sil' ||
      m.includes('qoyduqlarini sil') || m.includes('qoyduqlarimi sil') ||
      m.includes('tikdiklerini sil') || m.includes('tikdiklerimi sil') ||
      m.includes('qurduqlarini sil') || m.includes('qurduqlarimi sil') ||
      m.includes('yerlesdirdiklerini sil') || m.includes('yerlesdirdiklerimi sil') ||
      m.includes('yerləşdirdiklərini sil')) {
    result.reply = 'Tikdiklərimi və qoyduqlarımı sildim.';
    result.actions = [{ type: 'CLEAR' }];
    return result;
  }

  if (m === 'clear outfit' || m === 'geyimi sil' || m === 'paltari sil') {
    result.reply = 'Geyim təmizləndi.';
    result.actions = [{ type: 'CLEAR_OUTFIT' }];
    return result;
  }

  return null;
}

async function callGrok({ ownerName, message, history, world, assets }) {
  if (!ZENMUX_API_KEY) {
    throw Object.assign(
      new Error('ZENMUX_API_KEY tapilmadi.'),
      { status: 401 }
    );
  }

  const actionMode = isActionMessage(message);
  const system = buildSystemPrompt({
    provider: 'grok',
    ownerName,
    world: actionMode ? compactWorld(world) : null,
    assets: actionMode ? compactAssets(assets) : [],
    actionMode,
  });

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: clampText(message) },
  ];

  const data = await fetchJson(
    'https://zenmux.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + ZENMUX_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ZENMUX_GROK_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: actionMode ? 14000 : 500,
      }),
    },
    'ZenMux Grok'
  );

  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      'ZenMux Grok boş cavab qaytardı.'
    );
  }

  return normalizeModelOutput(content);
}

async function callGPT({ ownerName, message, history, world, assets }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY tapilmadi.');

  const actionMode = isActionMessage(message);
  const system = buildSystemPrompt({
    provider: 'gpt',
    ownerName,
    world: actionMode ? compactWorld(world) : null,
    assets: actionMode ? compactAssets(assets) : [],
    actionMode,
  });

  const messages = [
    { role: 'developer', content: system },
    ...history.slice(-MAX_HISTORY),
    { role: 'user', content: clampText(message) },
  ];

  const data = await fetchJson(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: actionMode ? 14000 : 500,
      }),
    },
    'OpenAI'
  );

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI boş cavab qaytardı.');
  }

  return normalizeModelOutput(content);
}
async function callGemini({ ownerName, message, history, world, assets }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY tapilmadi.');

  const actionMode = isActionMessage(message);
  const system = buildSystemPrompt({
    provider: 'gemini',
    ownerName,
    world: actionMode ? compactWorld(world) : null,
    assets: actionMode ? compactAssets(assets) : [],
    actionMode,
  });

  const contents = [];

  for (const item of history.slice(-MAX_HISTORY)) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;

    contents.push({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: clampText(item.content, 3500) }],
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: clampText(message) }],
  });

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
    ':generateContent';

  const data = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: actionMode ? 14000 : 500,
        },
      }),
    },
    'Gemini'
  );

  const parts = data?.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts)
    ? parts.map(p => safeString(p?.text)).filter(Boolean).join('')
    : '';

  if (!content.trim()) {
    const reason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
    throw new Error('Gemini boş cavab qaytardı (' + reason + ').');
  }

  return normalizeModelOutput(content);
}

function extractMessage(body) {
  if (typeof body === 'string') return clampText(body);
  if (!body || typeof body !== 'object') return '';

  const candidates = [
    body.message,
    body.text,
    body.prompt,
    body.query,
    body.input,
    body.userMessage,
    body.messageText,
    body.content,
    body.question,
    body.data?.message,
    body.data?.text,
    body.data?.prompt,
    body.payload?.message,
    body.payload?.text,
    body.payload?.prompt,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return clampText(value);
  }

  return '';
}

async function processAI(provider, body) {
  const safeBody = body && typeof body === 'object' ? body : {};
  const ownerId = getOwnerId(safeBody);
  const ownerName = getOwnerName(safeBody);
  const message = extractMessage(body);

  console.log(
    '[' + provider.toUpperCase() + ' REQUEST]',
    'owner=' + ownerId,
    'message="' + message.slice(0, 120) + '"'
  );

  if (!message.trim()) {
    return {
      ok: false,
      provider,
      reply: 'Mesaj boşdur.',
      actions: [],
    };
  }

  const brain = getBrain(ownerId, provider, safeBody.history);
  const local = localCommand(message);

  if (local) {
    pushHistory(brain, 'user', message);
    pushHistory(brain, 'assistant', local.reply);

    return {
      ok: true,
      provider,
      ownerUserId: ownerId,
      ownerName,
      reply: local.reply,
      action: local.actions[0] || null,
      actions: local.actions,
      local: true,
    };
  }

  const world = safeBody.world || safeBody.worldSnapshot || null;
  const assets = safeBody.assets || safeBody.availableAssets || [];
  const call = provider === 'gemini' ? callGemini : provider === 'grok' ? callGrok : callGPT;

  pushHistory(brain, 'user', message);

  try {
    const result = await withProviderQueue(provider, () => call({
      ownerName,
      message,
      history: brain.history.slice(0, -1),
      world,
      assets,
    }));

    pushHistory(brain, 'assistant', result.reply);

    return {
      ok: true,
      provider,
      ownerUserId: ownerId,
      ownerName,
      reply: result.reply,
      action: result.actions[0] || null,
      actions: result.actions,
      raw: result.raw,
      local: false,
    };
  } catch (err) {
    if (brain.history[brain.history.length - 1]?.role === 'user') {
      brain.history.pop();
    }

    const status = Number(err?.status || 500);
    let reply = provider === 'gemini'
      ? 'Gemini hazırda cavab verə bilmədi.'
      : provider === 'grok'
        ? 'Grok cavab verə bilmədi.'
        : 'GPT hazırda cavab verə bilmədi.';

    if (status === 429) {
      reply = provider === 'gemini'
        ? 'Gemini sorğu limitinə çatdı. Bir az sonra yenidən yoxla.'
        : provider === 'grok'
          ? 'Grok sorğu limitinə çatdı. Bir az sonra yenidən yoxla.'
          : 'GPT sorğu limitinə çatdı. Bir az sonra yenidən yoxla.';
    } else if (status === 401 || status === 403) {
      reply = provider === 'gemini'
        ? 'Gemini API açarı qəbul edilmədi.'
        : provider === 'grok'
          ? 'ZenMux API açarı qəbul edilmədi.'
          : 'OpenAI API açarı qəbul edilmədi.';
    } else if (status === 400) {
      reply = 'AI sorğusunun formatında problem var.';
    }

    console.error('[' + provider.toUpperCase() + ' ERROR]', err);

    return {
      ok: false,
      provider,
      ownerUserId: ownerId,
      ownerName,
      reply,
      action: null,
      actions: [],
      error: err?.message || String(err),
      status,
    };
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, payload) {
  setCors(res);
  const data = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(data));
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let finished = false;

    req.on('data', chunk => {
      if (finished) return;

      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finished = true;
        reject(new Error('Request çox böyükdür.'));
        req.destroy();
        return;
      }

      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;

      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(body);
        resolve(typeof parsed === 'string' ? { message: parsed } : parsed);
      } catch {
        resolve({ message: body.trim() });
      }
    });

    req.on('error', err => {
      if (finished) return;
      finished = true;
      reject(err);
    });
  });
}


function inferScriptType(prompt, requested) {
  const p = normalizeTextForCommand(prompt);
  const r = normalizeTextForCommand(requested);

  if (r.includes('modulescript') || r.includes('module script') || r.includes('modulscript') || r.includes('modul script')) {
    return 'ModuleScript';
  }

  if (r.includes('localscript') || r.includes('local script')) {
    return 'LocalScript';
  }

  if (p.includes('modulescript') || p.includes('module script') || p.includes('modulscript') || p.includes('modul script')) {
    return 'ModuleScript';
  }

  if (p.includes('localscript') || p.includes('local script')) {
    return 'LocalScript';
  }

  return 'Script';
}

function inferScriptTarget(prompt, providedName, providedPath) {
  const p = String(prompt || '').trim();
  const directName = safeString(providedName || '').trim();
  const directPath = safeString(providedPath || '').trim();

  if (directPath) {
    return { targetName: directName, targetPath: directPath };
  }

  if (directName) {
    return { targetName: directName, targetPath: '' };
  }

  const m = normalizeTextForCommand(p);
  const patterns = [
    /(?:masinin|masin|car|evin|ev|obyektin|modelin|partin|part|modelin icine|modelin icindeki|parta|parta|part-in icine|icindeki parta)\s*(?:icindeki\s+)?(?:parta|parta)?/i,
  ];

  let targetName = '';

  if (m.includes('masinin icinde') || m.includes('masinin icindeki') || m.includes('masin icinde')) targetName = 'Car';
  else if (m.includes('evin icinde') || m.includes('evin icindeki')) targetName = 'House';
  else if (m.includes('qatarin icinde') || m.includes('qatarin icindeki') || m.includes('trainin icindeki')) targetName = 'Train';
  else if (m.includes('parta script') || m.includes('parta kod') || m.includes('bu parta')) targetName = '';

  return { targetName, targetPath: '' };
}

function scriptTargetFromPrompt(prompt, requested) {
  const p = normalizeTextForCommand(prompt);
  const r = normalizeTextForCommand(requested);
  if (r.includes('starterplayer') || r.includes('localscript') || r.includes('local script')) {
    return 'StarterPlayerScripts';
  }
  if (p.includes('starterplayer') || p.includes('localscript') || p.includes('local script') ||
      p.includes('client script') || p.includes('input script') || p.includes('keybind') ||
      p.includes('keyboard') || p.includes('mouse') || p.includes('fly') || p.includes('uc') ||
      p.includes('uç') || p.includes('kamera') || p.includes('mousebutton')) {
    return 'StarterPlayerScripts';
  }
  return 'ServerScriptService';
}

function safeStudioName(name) {
  const cleaned = safeString(name, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 70);
  return cleaned || 'AI_GeneratedScript';
}

function ownerGuardSource(source, ownerUserId, targetService, scriptType) {
  const id = Number(ownerUserId) || 0;
  const src = String(source || '').trim();
  if (!src) return src;

  const marker = '-- AI_OWNER_GUARD';
  if (src.includes(marker)) return src;

  if (scriptType === 'LocalScript' || targetService === 'StarterPlayerScripts') {
    return `${marker}
local __AI_OWNER_USER_ID = ${id}
local __AI_LOCAL_PLAYER = game:GetService("Players").LocalPlayer
if not __AI_LOCAL_PLAYER or __AI_LOCAL_PLAYER.UserId ~= __AI_OWNER_USER_ID then return end

${src}`;
  }

  if (scriptType === 'ModuleScript') {
    return `${marker}
local __AI_OWNER_USER_ID = ${id}

${src}`;
  }

  return `${marker}
local __AI_OWNER_USER_ID = ${id}
local __AI_PLAYERS = game:GetService("Players")
local function __AI_IsOwner(player) return player and player.UserId == __AI_OWNER_USER_ID end

${src}`;
}

async function generateStudioSource({ provider, prompt, ownerUserId, targetService, scriptType }) {
  const finalScriptType = scriptType || (targetService === 'StarterPlayerScripts' ? 'LocalScript' : 'Script');
  const system = [
    'You generate Roblox Luau source only.',
    'Return ONLY raw Luau source code. No markdown fences.',
    `Target service: ${targetService}. Script type: ${finalScriptType}.`,
    `Owner UserId: ${Number(ownerUserId) || 0}.`,
    'The script is created by a Roblox Studio plugin.',
    'Do not use loadstring, executor APIs, backdoors, arbitrary require IDs, or suspicious remote code.',
    'Do not edit, delete, or overwrite existing scripts.',
    'The code must be safe and intended only for the owner.',
    'If script type is ModuleScript, return a valid module value/table at the end as appropriate.',
    'If script type is LocalScript, use client-only APIs and only locations where LocalScripts run.',
    'Honor every detail in the user request.',
  ].join('\n');

  if (provider === 'grok' && ZENMUX_API_KEY) {
    const data = await fetchJson(
      'https://zenmux.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + ZENMUX_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ZENMUX_GROK_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0.12,
          max_tokens: 5000,
        }),
      },
      'ZenMux Grok Studio'
    );

    const raw = data?.choices?.[0]?.message?.content || '';
    return String(raw)
      .replace(/^```(?:lua|luau)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  if (provider === 'gemini' && GEMINI_API_KEY) {
    const data = await fetchJson(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(GEMINI_MODEL) + ':generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.12, maxOutputTokens: 5000 },
        }),
      },
      'Gemini Studio'
    );
    const parts = data?.candidates?.[0]?.content?.parts;
    const raw = Array.isArray(parts) ? parts.map(p => safeString(p?.text)).filter(Boolean).join('') : '';
    return raw.replace(/^```(?:lua|luau)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  if (provider === 'gpt' && OPENAI_API_KEY) {
    const data = await fetchJson(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + OPENAI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: 'developer', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0.12,
          max_tokens: 5000,
        }),
      },
      'OpenAI Studio'
    );
    const raw = data?.choices?.[0]?.message?.content || '';
    return String(raw).replace(/^```(?:lua|luau)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  return '';
}

async function searchRobloxToolbox(query, count = 25) {
  if (!ROBLOX_TOOLBOX_API_KEY) {
    throw Object.assign(
      new Error('ROBLOX_TOOLBOX_API_KEY tapılmadı.'),
      { status: 401 }
    );
  }

  const q = encodeURIComponent(String(query || '').trim());
  const url =
    'https://apis.roblox.com/toolbox-service/v2/assets:search' +
    '?searchCategoryType=Model' +
    '&query=' + q +
    '&maxPageSize=' + Math.min(100, Math.max(1, Number(count) || 25)) +
    '&pageNumber=0' +
    '&searchView=Core' +
    '&includeOnlyVerifiedCreators=false' +
    '&sortCategory=Relevance';

  const data = await fetchJson(
    url,
    {
      method: 'GET',
      headers: {
        'x-api-key': ROBLOX_TOOLBOX_API_KEY,
        'Content-Type': 'application/json',
      },
    },
    'Roblox Toolbox Search'
  );

  const list =
    data?.creatorStoreAssets ||
    data?.assets ||
    data?.items ||
    data?.results ||
    data?.data ||
    [];

  if (!Array.isArray(list)) return [];

  return list
    .map(item => {
      const asset = item?.asset || item;
      const id = Number(
        asset?.id ??
        asset?.assetId ??
        asset?.AssetId ??
        asset?.asset?.id
      );

      const name =
        asset?.name ||
        asset?.Name ||
        asset?.asset?.name ||
        ('Model_' + id);

      return id > 0
        ? { id, name: String(name) }
        : null;
    })
    .filter(Boolean);
}

async function createStudioScript(body) {
  const prompt = clampText(body?.prompt || body?.message || body?.text || '', 6000).trim();
  const ownerUserId = getOwnerId(body);
  const ownerName = getOwnerName(body);
  const provider = normalizeProvider(body?.provider);
  const action = String(body?.action || body?.type || 'CREATE').toUpperCase();
  const targetService = scriptTargetFromPrompt(prompt, body?.targetService || body?.target || '');
  const scriptType = inferScriptType(prompt, body?.scriptType || body?.typeName || '');
  const targetSpec = inferScriptTarget(prompt, body?.targetName || '', body?.targetPath || '');
  const requestedName = safeStudioName(body?.scriptName || body?.name || (scriptType === 'ModuleScript' ? 'AI_Module' : scriptType === 'LocalScript' ? 'AI_LocalScript' : 'AI_Script'));
  const requestId = `studio_${Date.now()}_${studioRequestId++}`;

  if (!prompt && action !== 'DELETE') {
    throw new Error('Script promptu boşdur.');
  }

  if (action === 'DELETE' || action.includes('DELETE')) {
    const item = {
      id: requestId,
      action: 'DELETE_SCRIPT',
      provider,
      ownerUserId,
      ownerName,
      scriptName: requestedName,
      scriptType,
      targetService,
      targetName: targetSpec.targetName,
      targetPath: targetSpec.targetPath,
      prompt,
      ownerOnly: true,
      doNotFixExisting: true,
      ephemeral: true,
      deleteOnOwnerLeave: true,
      doNotPersist: true,
      createdAt: Date.now(),
    };
    studioQueue.push(item);
    while (studioQueue.length > 100) studioQueue.shift();
    return {
      ok: true,
      requestId,
      queued: true,
      action: 'DELETE_SCRIPT',
      scriptName: requestedName,
      targetService,
    };
  }

  let source = '';
  try {
    source = await generateStudioSource({
      provider,
      prompt,
      ownerUserId,
      targetService,
      scriptType,
    });
  } catch (err) {
    console.warn('[STUDIO SOURCE]', err?.message || err);
  }

  if (!source) {
    const id = Number(ownerUserId) || 0;
    if (targetService === 'StarterPlayerScripts') {
      source = `-- AI generated LocalScript\nlocal Players = game:GetService("Players")\nlocal OWNER_USER_ID = ${id}\nlocal LocalPlayer = Players.LocalPlayer\nif not LocalPlayer or LocalPlayer.UserId ~= OWNER_USER_ID then return end\n\n-- User request:\n-- ${prompt.replace(/[\r\n]/g, ' ').slice(0, 300)}\n`;
    } else {
      source = `-- AI generated ServerScript\nlocal Players = game:GetService("Players")\nlocal OWNER_USER_ID = ${id}\nlocal function isOwner(player) return player and player.UserId == OWNER_USER_ID end\n\n-- User request:\n-- ${prompt.replace(/[\r\n]/g, ' ').slice(0, 300)}\n`;
    }
  }

  source = ownerGuardSource(source, ownerUserId, targetService, scriptType);

  const item = {
    id: requestId,
    action: 'CREATE_SCRIPT',
    provider,
    ownerUserId,
    ownerName,
    scriptName: requestedName,
    scriptType,
    targetService,
    targetName: targetSpec.targetName,
    targetPath: targetSpec.targetPath,
    prompt,
    source,
    ownerOnly: true,
    doNotFixExisting: true,
    ephemeral: true,
    deleteOnOwnerLeave: true,
    doNotPersist: true,
    createdAt: Date.now(),
  };

  studioQueue.push(item);
  while (studioQueue.length > 100) studioQueue.shift();

  return {
    ok: true,
    requestId,
    queued: true,
    action: 'CREATE_SCRIPT',
    scriptName: requestedName,
    scriptType,
    targetService,
    targetName: targetSpec.targetName,
    targetPath: targetSpec.targetPath,
  };
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://' + (req.headers.host || '127.0.0.1'));

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      message: 'Roblox AI backend işləyir.',
      port: PORT,
      models: {
        gpt: OPENAI_MODEL,
        gemini: GEMINI_MODEL,
        grok: ZENMUX_GROK_MODEL,
      },
      keys: {
        openai: Boolean(OPENAI_API_KEY),
        gemini: Boolean(GEMINI_API_KEY),
        grok: Boolean(ZENMUX_API_KEY),
        robloxToolbox: Boolean(ROBLOX_TOOLBOX_API_KEY),
      },
      brains: brains.size,
      node: process.version,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/studio-queue') {
    sendJson(res, 200, {
      ok: true,
      items: studioQueue.filter(x => !studioCompleted.has(x.id)).slice(0, 10),
    });
    return;
  }

  // Toolbox search is GET and must be handled BEFORE the generic POST guard.
  if (req.method === 'GET' && url.pathname === '/toolbox-search') {
    try {
      const query = String(url.searchParams.get('query') || '').trim();
      const limit = Number(url.searchParams.get('limit') || 25);

      if (!query) {
        sendJson(res, 400, {
          ok: false,
          error: 'Toolbox query boşdur.',
        });
        return;
      }

      const results = await searchRobloxToolbox(query, limit);

      sendJson(res, 200, {
        ok: true,
        results,
      });
    } catch (err) {
      console.error('[TOOLBOX SEARCH ERROR]', err);
      sendJson(res, 500, {
        ok: false,
        error: err?.message || String(err),
        hasKey: Boolean(ROBLOX_TOOLBOX_API_KEY),
      });
    }
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, {
      ok: false,
      error: 'POST istifadə edin.',
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, {
      ok: false,
      reply: 'Sorğu oxunmadı.',
      error: err?.message || String(err),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/studio-script') {
    try {
      const result = await createStudioScript(body);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[STUDIO SCRIPT ERROR]', err);
      sendJson(res, 500, {
        ok: false,
        error: err?.message || String(err),
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/studio-script-complete') {
    const id = String(body?.requestId || '');
    if (id) studioCompleted.add(id);
    for (let i = studioQueue.length - 1; i >= 0; i--) {
      if (studioQueue[i].id === id) studioQueue.splice(i, 1);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  let provider;
  if (url.pathname === '/gemini') {
    provider = 'gemini';
  } else if (url.pathname === '/grok') {
    provider = 'grok';
  } else if (url.pathname === '/gpt') {
    provider = 'gpt';
  } else {
    provider = normalizeProvider(body?.provider);
  }

  if (url.pathname !== '/gpt' && url.pathname !== '/gemini' && url.pathname !== '/grok') {
    sendJson(res, 404, {
      ok: false,
      error: 'Endpoint tapılmadı. /gpt, /gemini və ya /grok istifadə edin.',
    });
    return;
  }

  try {
    const result = await processAI(provider, body);
    const status = result.ok ? 200 : 200;
    sendJson(res, status, result);
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    sendJson(res, 500, {
      ok: false,
      provider,
      reply: 'Server xətası baş verdi.',
      actions: [],
      error: err?.message || String(err),
    });
  }
});

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log(' Roblox AI Backend hazırdır');
  console.log(' http://127.0.0.1:' + PORT + '/health');
  console.log(' GPT endpoint:    http://127.0.0.1:' + PORT + '/gpt');
  console.log(' Gemini endpoint: http://127.0.0.1:' + PORT + '/gemini');
  console.log(' Grok endpoint:   http://127.0.0.1:' + PORT + '/grok');
  console.log(' OpenAI model:     ' + OPENAI_MODEL);
  console.log(' Gemini model:    ' + GEMINI_MODEL);
  console.log(' Grok model:      ' + ZENMUX_GROK_MODEL);
  console.log(' OpenAI key:       ' + (OPENAI_API_KEY ? 'OK' : 'YOOX'));
  console.log(' Gemini key:      ' + (GEMINI_API_KEY ? 'OK' : 'YOOX'));
  console.log(' ZenMux Grok key: ' + (ZENMUX_API_KEY ? 'OK' : 'YOOX'));
  console.log('==============================================');
});

process.on('SIGINT', () => {
  console.log('\nServer bağlanır...');
  server.close(() => process.exit(0));
});

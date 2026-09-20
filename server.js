'use strict';

// Roblox GPT + Gemini AI Backend
// Node.js 18+
//
// Render Environment Variables:
// OPENROUTER_API_KEY
// GEMINI_API_KEY
// ROBLOX_TOOLBOX_API_KEY
// OPENROUTER_MODEL (optional)
// GEMINI_MODEL (optional)
// PORT is supplied by Render automatically.

const http = require('http');
const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
  throw new Error('Node.js 18+ lazimdir.');
}

function loadDotEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;

  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();

      if (!line || line.startsWith('#')) {
        continue;
      }

      const i = line.indexOf('=');

      if (i < 1) {
        continue;
      }

      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();

      if (
        value.length >= 2 &&
        (
          (value[0] === '"' && value.at(-1) === '"') ||
          (value[0] === "'" && value.at(-1) === "'")
        )
      ) {
        value = value.slice(1, -1);
      }

      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (e) {
    console.warn('[ENV]', e.message);
  }
}

loadDotEnv();

const PORT = Number(
  process.env.PORT || 3000
);

const OPENROUTER_MODEL = String(
  process.env.OPENROUTER_MODEL ||
  'openrouter/free'
).trim();

const GEMINI_MODEL = String(
  process.env.GEMINI_MODEL ||
  'gemini-3.1-flash-lite'
).trim();

const OPENROUTER_API_KEY = String(
  process.env.OPENROUTER_API_KEY || ''
).trim();

const GEMINI_API_KEY = String(
  process.env.GEMINI_API_KEY || ''
).trim();

const ROBLOX_TOOLBOX_API_KEY = String(
  process.env.ROBLOX_TOOLBOX_API_KEY || ''
).trim();

const MAX_BODY = 1024 * 1024;
const MAX_HISTORY = 12;
const MAX_PARTS = 500;

const studioQueue = [];
const doneStudio = new Set();

const memories = new Map();

const queues = {
  gpt: Promise.resolve(),
  gemini: Promise.resolve()
};

let studioId = 1;

const sleep = ms =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

const s = (
  value,
  fallback = ''
) =>
  typeof value === 'string'
    ? value
    : fallback;

function norm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replaceAll('ı', 'i')
    .replaceAll('ə', 'e')
    .replaceAll('ö', 'o')
    .replaceAll('ü', 'u')
    .replaceAll('ş', 's')
    .replaceAll('ç', 'c')
    .replaceAll('ğ', 'g');
}

function ownerId(body) {
  return String(
    body?.ownerUserId ??
    body?.userId ??
    body?.playerUserId ??
    'unknown'
  );
}

function ownerName(body) {
  return s(
    body?.ownerName ??
    body?.playerName ??
    body?.username,
    'Owner'
  ).slice(0, 80);
}

function messageOf(body) {
  if (typeof body === 'string') {
    return body.slice(0, 6000);
  }

  for (
    const value of [
      body?.message,
      body?.text,
      body?.prompt,
      body?.query,
      body?.input,
      body?.userMessage,
      body?.content,
      body?.question
    ]
  ) {
    if (
      typeof value === 'string' &&
      value.trim()
    ) {
      return value.slice(0, 6000);
    }
  }

  return '';
}

function json(res, code, data) {
  res.statusCode = code;

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  const out = JSON.stringify(data);

  res.setHeader(
    'Content-Length',
    Buffer.byteLength(out)
  );

  res.end(out);
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let text = '';
      let size = 0;
      let done = false;

      req.on(
        'data',
        chunk => {
          if (done) {
            return;
          }

          size += chunk.length;

          if (size > MAX_BODY) {
            done = true;

            reject(
              new Error(
                'Request çox böyükdür.'
              )
            );

            req.destroy();

            return;
          }

          text += chunk.toString('utf8');
        }
      );

      req.on(
        'end',
        () => {
          if (done) {
            return;
          }

          done = true;

          if (!text.trim()) {
            resolve({});
            return;
          }

          try {
            const parsed =
              JSON.parse(text);

            resolve(
              typeof parsed === 'string'
                ? {
                    message: parsed
                  }
                : parsed
            );
          } catch {
            resolve({
              message:
                text.trim()
            });
          }
        }
      );

      req.on(
        'error',
        error => {
          if (!done) {
            done = true;
            reject(error);
          }
        }
      );
    }
  );
}

async function fetchJSON(
  url,
  options,
  label
) {
  let last;

  for (
    let attempt = 0;
    attempt < 3;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        25000
      );

    try {
      const response =
        await fetch(
          url,
          {
            ...options,
            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      let data;

      try {
        data = text
          ? JSON.parse(text)
          : null;
      } catch {
        data = {
          raw: text
        };
      }

      if (response.ok) {
        return data;
      }

      const error =
        new Error(
          `${label} HTTP ${response.status}: ${
            data?.error?.message ||
            data?.message ||
            data?.raw ||
            ''
          }`.trim()
        );

      error.status =
        response.status;

      last = error;

      if (
        ![
          408,
          429,
          500,
          502,
          503,
          504
        ].includes(
          response.status
        ) ||
        attempt === 2
      ) {
        throw error;
      }

      await sleep(
        700 * (attempt + 1)
      );
    } catch (error) {
      last =
        error?.name ===
        'AbortError'
          ? Object.assign(
              new Error(
                `${label}: timeout`
              ),
              {
                status: 408
              }
            )
          : error;

      if (attempt === 2) {
        throw last;
      }

      await sleep(
        700 * (attempt + 1)
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    last ||
    new Error(
      label + ': naməlum xəta'
    )
  );
}

function memoryFor(
  id,
  provider,
  history
) {
  const key =
    `${id}:${provider}`;

  if (!memories.has(key)) {
    memories.set(
      key,
      {
        history: []
      }
    );
  }

  const memory =
    memories.get(key);

  if (
    !memory.history.length &&
    Array.isArray(history)
  ) {
    memory.history =
      history
        .filter(
          x =>
            x &&
            (
              x.role === 'user' ||
              x.role === 'assistant'
            )
        )
        .slice(
          -MAX_HISTORY
        )
        .map(
          x => ({
            role:
              x.role,

            content:
              s(x.content)
                .slice(
                  0,
                  3500
                )
          })
        );
  }

  return memory;
}

function push(
  memory,
  role,
  content
) {
  memory.history.push({
    role,

    content:
      s(content)
        .slice(
          0,
          3500
        )
  });

  while (
    memory.history.length >
    MAX_HISTORY
  ) {
    memory.history.shift();
  }
}

function worldMini(world) {
  if (
    !world ||
    typeof world !== 'object'
  ) {
    return null;
  }

  return {
    selfPosition:
      world.selfPosition ||
      null,

    ownerPosition:
      world.ownerPosition ||
      null,

    nearbyPlayers:
      Array.isArray(
        world.nearbyPlayers
      )
        ? world.nearbyPlayers
            .slice(0, 15)
        : [],

    nearbyObjects:
      Array.isArray(
        world.nearbyObjects
      )
        ? world.nearbyObjects
            .slice(0, 30)
        : [],

    nearbyVehicles:
      Array.isArray(
        world.nearbyVehicles
      )
        ? world.nearbyVehicles
            .slice(0, 15)
        : [],

    obstacles:
      Array.isArray(
        world.obstacles
      )
        ? world.obstacles
            .slice(0, 15)
        : [],

    vehicle:
      world.vehicle ||
      null
  };
}

function systemPrompt(
  provider,
  body,
  action
) {
  const ai =
    provider === 'gemini'
      ? 'Gemini'
      : 'GPT';

  const id =
    ownerId(body);

  let prompt = `
Sən Roblox-da yaşayan ${ai} AI NPC-sən.
Sahibin ${ownerName(body)}-dir.
Owner UserId ${id}.

Azərbaycan dilində təbii danış.
Özbaşına hərəkət, tikinti və teleport etmə.
İstifadəçi açıq tapşırıq verəndə uyğun action qaytar.
Normal hərəkət fiziki olmalıdır.
`;

  if (body?.world) {
    prompt +=
      `
DÜNYA:
${JSON.stringify(
  worldMini(body.world)
)}
`;
  }

  if (!action) {
    prompt +=
      `
Adi söhbətdir.
actions boş array qaytar.
`;

    return prompt;
  }

  prompt += `
Yalnız JSON qaytar:

{
  "reply":"qısa cavab",
  "actions":[]
}

İcazəli action-lar:

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

FOLLOW:
{
  "type":"FOLLOW",
  "target":"OWNER"
}

COME:
{
  "type":"COME"
}

TELEPORT:
{
  "type":"TELEPORT"
}

JUMP:
{
  "type":"JUMP"
}

DANCE:
{
  "type":"DANCE"
}

DANCE_WITH_OWNER:
{
  "type":"DANCE_WITH_OWNER"
}

STOP_DANCE:
{
  "type":"STOP_DANCE"
}

HUG:
{
  "type":"HUG"
}

CARRY:
{
  "type":"CARRY"
}

DROP:
{
  "type":"DROP"
}

MOVE:
{
  "type":"MOVE",
  "direction":"forward|back|left|right",
  "duration":3,
  "speed":8
}

WALK_TO:
{
  "type":"WALK_TO",
  "position":[x,y,z],
  "distance":3
}

TURN:
{
  "type":"TURN",
  "direction":"LEFT|RIGHT",
  "degrees":90
}

BUILD:
{
  "type":"BUILD",
  "name":"Object",
  "description":"istifadəçinin bütün detalları",
  "parts":[
    {
      "name":"Part",
      "shape":"Block",
      "size":[4,1,4],
      "offset":[0,0,0],
      "material":"Plastic",
      "color":[255,255,255],
      "anchored":true
    }
  ]
}

BUILD QAYDALARI:

- Yalnız ev, maşın və qatarla məhdudlaşma.
- İstifadəçi nə istəyirsə onu qur.
- Robot, təyyarə, gəmi, mağaza, qüllə, körpü, qala, otaq və s. qur.
- İstifadəçinin ölçü, rəng, forma və digər detallarına əməl et.
- İç hissəni də qur.
- Otaq, qapı, pəncərə, mebel və digər detallar lazımdırsa parts ilə yarat.
- Maşında təkər, kuzov, şüşə, oturacaq, sükan və işıq kimi detalları yarat.
- Qatar üçün lokomotiv və vaqonları yarat.
- Hazır model əvəzinə əsas tikintini BUILD parts ilə yarat.
- Maksimum ${MAX_PARTS} Part.
- İstifadəçi dekorasiya üçün Toolbox istəyirsə BUILD və TOOLBOX birlikdə qaytarıla bilər.
- Sayğac üçün uydurma 0/10 və ya 10/10 yaratma.

TOOLBOX:

{
  "type":"TOOLBOX",
  "query":"specific model or decoration",
  "count":1
}

Script:

STUDIO_SCRIPT_CREATE:

{
  "type":"STUDIO_SCRIPT_CREATE",
  "scriptName":"AI_Script",
  "scriptType":"Script|LocalScript|ModuleScript",
  "targetService":"ServerScriptService|StarterPlayerScripts",
  "targetName":"optional Part or Model",
  "targetPath":"optional path",
  "prompt":"full request"
}

STUDIO_SCRIPT_DELETE:

{
  "type":"STUDIO_SCRIPT_DELETE",
  "scriptName":"AI_Script",
  "scriptType":"Script|LocalScript|ModuleScript",
  "targetService":"ServerScriptService|StarterPlayerScripts",
  "targetName":"optional Part or Model",
  "targetPath":"optional path"
}

SCRIPT QAYDALARI:

- Yeni script yarat.
- Mövcud scripti özbaşına düzəltmə.
- Mövcud scripti overwrite etmə.
- Owner UserId ${id} üçün işləsin.
- Script AI tərəfindən müvəqqətidir.
- Owner çıxanda silinəcək.
- DataStore-a yazılmayacaq.
- Maşının içindəki Part üçün targetName və ya targetPath istifadə et.
- ModuleScript üçün scriptType ModuleScript.
- LocalScript üçün uyğun client konteyneri seç.
`;

  return prompt;
}

function isActionMessage(
  message
) {
  const m = norm(message);

  return [
    'tik',
    'tikinti',
    'qur',
    'build',
    'yarat',
    'hazirla',
    'ev',
    'house',
    'masin',
    'car',
    'qatar',
    'train',
    'robot',
    'teyyare',
    'gemi',
    'ship',
    'tower',
    'qulle',
    'korpu',
    'bridge',
    'toolbox',
    'model',
    'follow',
    'takip',
    'teqib',
    'izle',
    'gel',
    'come',
    'tp',
    'teleport',
    'tullan',
    'jump',
    'dance',
    'dans',
    'reqs',
    'qucaq',
    'hug',
    'carry',
    'dasi',
    'qaldir',
    'burax',
    'drop',
    'sola',
    'saga',
    'don',
    'dayan',
    'stop',
    'davam',
    'sil',
    'clear',
    'remove',
    'edit',
    'duzelt',
    'gey',
    'wear',
    'script',
    'luau',
    'kod'
  ].some(
    x => m.includes(x)
  );
}

function parseAI(raw) {
  let text =
    String(raw || '')
      .trim()
      .replace(
        /^```(?:json)?\s*/i,
        ''
      )
      .replace(
        /\s*```$/,
        ''
      );

  let parsed =
    null;

  try {
    parsed =
      JSON.parse(text);
  } catch {
    const a =
      text.indexOf('{');

    const b =
      text.lastIndexOf('}');

    if (
      a >= 0 &&
      b > a
    ) {
      try {
        parsed =
          JSON.parse(
            text.slice(
              a,
              b + 1
            )
          );
      } catch {}
    }
  }

  if (
    !parsed ||
    typeof parsed !== 'object'
  ) {
    return {
      reply:
        String(
          raw ||
          'Hazirdir.'
        ).slice(
          0,
          6000
        ),

      actions: []
    };
  }

  const actions =
    Array.isArray(
      parsed.actions
    )
      ? parsed.actions
          .filter(
            a =>
              a &&
              typeof a ===
                'object'
          )
          .map(
            a => ({
              ...a,

              type:
                String(
                  a.type || ''
                )
                  .toUpperCase()
            })
          )
          .filter(
            a => a.type
          )
      : [];

  return {
    reply:
      String(
        parsed.reply ||
        parsed.message ||
        parsed.text ||
        'Hazirdir.'
      ).slice(
        0,
        6000
      ),

    actions
  };
}

async function askGPT(body) {
  if (
    !OPENROUTER_API_KEY
  ) {
    throw Object.assign(
      new Error(
        'OPENROUTER_API_KEY tapılmadı.'
      ),
      {
        status: 401
      }
    );
  }

  const msg =
    messageOf(body);

  const mode =
    isActionMessage(msg);

  const memory =
    memoryFor(
      ownerId(body),
      'gpt',
      body?.history
    );

  const response =
    await fetchJSON(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',

        headers: {
          Authorization:
            'Bearer ' +
            OPENROUTER_API_KEY,

          'Content-Type':
            'application/json',

          'X-Title':
            'Roblox AI NPC'
        },

        body:
          JSON.stringify({
            model:
              OPENROUTER_MODEL,

            messages: [
              {
                role:
                  'system',

                content:
                  systemPrompt(
                    'gpt',
                    body,
                    mode
                  )
              },

              ...memory.history,

              {
                role:
                  'user',

                content:
                  msg
              }
            ],

            temperature:
              0.65,

            max_tokens:
              mode
                ? 14000
                : 500
          })
      },

      'OpenRouter'
    );

  return parseAI(
    response
      ?.choices?.[0]
      ?.message
      ?.content ||
      ''
  );
}

async function askGemini(
  body
) {
  if (
    !GEMINI_API_KEY
  ) {
    throw Object.assign(
      new Error(
        'GEMINI_API_KEY tapılmadı.'
      ),
      {
        status: 401
      }
    );
  }

  const msg =
    messageOf(body);

  const mode =
    isActionMessage(msg);

  const memory =
    memoryFor(
      ownerId(body),
      'gemini',
      body?.history
    );

  const contents =
    memory.history.map(
      item => ({
        role:
          item.role ===
          'assistant'
            ? 'model'
            : 'user',

        parts: [
          {
            text:
              item.content
          }
        ]
      })
    );

  contents.push({
    role:
      'user',

    parts: [
      {
        text:
          msg
      }
    ]
  });

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(
      GEMINI_MODEL
    ) +
    ':generateContent';

  const response =
    await fetchJSON(
      url,
      {
        method: 'POST',

        headers: {
          'x-goog-api-key':
            GEMINI_API_KEY,

          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text:
                    systemPrompt(
                      'gemini',
                      body,
                      mode
                    )
                }
              ]
            },

            contents,

            generationConfig: {
              temperature:
                0.65,

              maxOutputTokens:
                mode
                  ? 14000
                  : 500
            }
          })
      },

      'Gemini'
    );

  const parts =
    response
      ?.candidates?.[0]
      ?.content
      ?.parts;

  const text =
    Array.isArray(parts)
      ? parts
          .map(
            x =>
              s(x?.text)
          )
          .join('')
      : '';

  return parseAI(text);
}

async function processAI(
  provider,
  body
) {
  const memory =
    memoryFor(
      ownerId(body),
      provider,
      body?.history
    );

  const message =
    messageOf(body);

  const local =
    simpleLocal(
      body
    );

  if (local) {
    push(
      memory,
      'user',
      message
    );

    push(
      memory,
      'assistant',
      local.reply
    );

    return {
      ok: true,
      provider,
      ownerUserId:
        ownerId(body),
      ownerName:
        ownerName(body),
      ...local
    };
  }

  push(
    memory,
    'user',
    message
  );

  try {
    let result;

    if (
      provider ===
      'gemini'
    ) {
      queues.gemini =
        queues.gemini.then(
          () =>
            askGemini(body)
        );

      result =
        await queues.gemini;
    } else {
      queues.gpt =
        queues.gpt.then(
          () =>
            askGPT(body)
        );

      result =
        await queues.gpt;
    }

    push(
      memory,
      'assistant',
      result.reply
    );

    return {
      ok: true,

      provider,

      ownerUserId:
        ownerId(body),

      ownerName:
        ownerName(body),

      ...result
    };
  } catch (error) {
    if (
      memory.history.at(-1)
        ?.role === 'user'
    ) {
      memory.history.pop();
    }

    return {
      ok: false,

      provider,

      ownerUserId:
        ownerId(body),

      ownerName:
        ownerName(body),

      reply:
        error?.message ||
        'AI xətası.',

      actions: [],

      error:
        error?.message ||
        String(error),

      status:
        Number(
          error?.status ||
          500
        )
    };
  }
}

function scriptTarget(
  prompt,
  supplied
) {
  const p =
    norm(prompt);

  const r =
    norm(supplied);

  if (
    r.includes(
      'starterplayer'
    ) ||
    r.includes(
      'localscript'
    ) ||
    r.includes(
      'local script'
    )
  ) {
    return 'StarterPlayerScripts';
  }

  if (
    p.includes(
      'starterplayer'
    ) ||
    p.includes(
      'localscript'
    ) ||
    p.includes(
      'local script'
    ) ||
    p.includes(
      'client script'
    ) ||
    p.includes(
      'keybind'
    ) ||
    p.includes(
      'keyboard'
    ) ||
    p.includes(
      'mouse'
    )
  ) {
    return 'StarterPlayerScripts';
  }

  return 'ServerScriptService';
}

function scriptType(
  prompt,
  supplied
) {
  const p =
    norm(prompt);

  const r =
    norm(supplied);

  if (
    r.includes('module') ||
    p.includes(
      'modulescript'
    ) ||
    p.includes(
      'module script'
    ) ||
    p.includes(
      'modulscript'
    ) ||
    p.includes(
      'modul script'
    )
  ) {
    return 'ModuleScript';
  }

  if (
    r.includes('local') ||
    p.includes(
      'localscript'
    ) ||
    p.includes(
      'local script'
    )
  ) {
    return 'LocalScript';
  }

  return 'Script';
}

function inferTarget(
  prompt,
  name,
  pathName
) {
  if (
    name ||
    pathName
  ) {
    return {
      targetName:
        s(name),

      targetPath:
        s(pathName)
    };
  }

  const p =
    norm(prompt);

  if (
    p.includes(
      'masinin icinde'
    ) ||
    p.includes(
      'masinin icindeki'
    )
  ) {
    return {
      targetName:
        'Car',

      targetPath:
        ''
    };
  }

  if (
    p.includes(
      'evin icinde'
    ) ||
    p.includes(
      'evin icindeki'
    )
  ) {
    return {
      targetName:
        'House',

      targetPath:
        ''
    };
  }

  if (
    p.includes(
      'qatarin icinde'
    ) ||
    p.includes(
      'qatarin icindeki'
    )
  ) {
    return {
      targetName:
        'Train',

      targetPath:
        ''
    };
  }

  return {
    targetName:
      '',
    targetPath:
      ''
  };
}

function safeScriptName(
  name,
  type
) {
  return String(
    name ||
      (
        type ===
        'ModuleScript'
          ? 'AI_Module'
          : type ===
            'LocalScript'
            ? 'AI_LocalScript'
            : 'AI_Script'
      )
  )
    .replace(
      /[^A-Za-z0-9_-]/g,
      '_'
    )
    .slice(
      0,
      70
    ) ||
    'AI_Script';
}

function guardSource(
  source,
  id,
  target,
  type
) {
  if (
    source.includes(
      '-- AI_OWNER_GUARD'
    )
  ) {
    return source;
  }

  const n =
    Number(id) || 0;

  if (
    type ===
      'LocalScript' ||
    target ===
      'StarterPlayerScripts'
  ) {
    return `-- AI_OWNER_GUARD
local OWNER_USER_ID = ${n}
local LocalPlayer = game:GetService("Players").LocalPlayer
if not LocalPlayer or LocalPlayer.UserId ~= OWNER_USER_ID then return end

${source}`;
  }

  if (
    type ===
    'ModuleScript'
  ) {
    return `-- AI_OWNER_GUARD
local OWNER_USER_ID = ${n}

${source}`;
  }

  return `-- AI_OWNER_GUARD
local OWNER_USER_ID = ${n}
local Players = game:GetService("Players")
local function IsOwner(player)
    return player and player.UserId == OWNER_USER_ID
end

${source}`;
}

async function makeScript(
  body
) {
  const prompt =
    messageOf(body);

  const id =
    ownerId(body);

  const name =
    ownerName(body);

  const provider =
    normalizeProvider(
      body?.provider
    );

  const action =
    norm(
      body?.action ||
      body?.type
    ).toUpperCase();

  const target =
    scriptTarget(
      prompt,
      body?.targetService ||
        body?.target
    );

  const type =
    scriptType(
      prompt,
      body?.scriptType ||
        body?.typeName
    );

  const targetSpec =
    inferTarget(
      prompt,
      body?.targetName,
      body?.targetPath
    );

  const sn =
    safeScriptName(
      body?.scriptName ||
        body?.name,
      type
    );

  const requestId =
    `studio_${Date.now()}_${studioId++}`;

  if (
    action.includes(
      'DELETE'
    )
  ) {
    const item = {
      id:
        requestId,

      action:
        'DELETE_SCRIPT',

      provider,

      ownerUserId:
        id,

      ownerName:
        name,

      scriptName:
        sn,

      scriptType:
        type,

      targetService:
        target,

      targetName:
        targetSpec.targetName,

      targetPath:
        targetSpec.targetPath,

      prompt,

      ownerOnly:
        true,

      ephemeral:
        true,

      deleteOnOwnerLeave:
        true,

      doNotPersist:
        true
    };

    studioQueue.push(
      item
    );

    if (
      studioQueue.length >
      100
    ) {
      studioQueue.shift();
    }

    return {
      ok: true,

      requestId,

      queued: true,

      action:
        item.action,

      scriptName:
        sn,

      scriptType:
        type,

      targetService:
        target,

      targetName:
        targetSpec.targetName,

      targetPath:
        targetSpec.targetPath
    };
  }

  if (!prompt) {
    throw new Error(
      'Script promptu boşdur.'
    );
  }

  const system = `
Roblox Luau source yaz.

Target:
${target}

Type:
${type}

Owner UserId:
${Number(id) || 0}

Yalnız raw Luau qaytar.
Mövcud scriptləri dəyişmə.
Mövcud scriptləri silmə.
Mövcud scriptlərin üstünə yazma.
loadstring, executor, backdoor, arbitrary require və şübhəli remote code istifadə etmə.
Script yalnız owner üçün işləsin.
İstifadəçinin bütün detallarına əməl et.
`;

  let source = '';

  try {
    if (
      provider === 'gpt' &&
      OPENROUTER_API_KEY
    ) {
      const response =
        await fetchJSON(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method:
              'POST',

            headers: {
              Authorization:
                'Bearer ' +
                OPENROUTER_API_KEY,

              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                model:
                  OPENROUTER_MODEL,

                messages: [
                  {
                    role:
                      'system',

                    content:
                      system
                  },

                  {
                    role:
                      'user',

                    content:
                      prompt
                  }
                ],

                temperature:
                  0.12,

                max_tokens:
                  5000
              })
          },

          'OpenRouter Studio'
        );

      source =
        String(
          response
            ?.choices?.[0]
            ?.message
            ?.content ||
          ''
        )
          .replace(
            /^```(?:lua|luau)?\s*/i,
            ''
          )
          .replace(
            /\s*```$/i,
            ''
          )
          .trim();
    } else if (
      provider ===
        'gemini' &&
      GEMINI_API_KEY
    ) {
      const response =
        await fetchJSON(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(
              GEMINI_MODEL
            ) +
            ':generateContent',

          {
            method:
              'POST',

            headers: {
              'x-goog-api-key':
                GEMINI_API_KEY,

              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                systemInstruction: {
                  parts: [
                    {
                      text:
                        system
                    }
                  ]
                },

                contents: [
                  {
                    role:
                      'user',

                    parts: [
                      {
                        text:
                          prompt
                      }
                    ]
                  }
                ],

                generationConfig: {
                  temperature:
                    0.12,

                  maxOutputTokens:
                    5000
                }
              })
          },

          'Gemini Studio'
        );

      source =
        Array.isArray(
          response
            ?.candidates?.[0]
            ?.content
            ?.parts
        )
          ? response.candidates[0]
              .content
              .parts
              .map(
                x =>
                  s(
                    x?.text
                  )
              )
              .join('')
              .replace(
                /^```(?:lua|luau)?\s*/i,
                ''
              )
              .replace(
                /\s*```$/i,
                ''
              )
              .trim()
          : '';
    }
  } catch (error) {
    console.warn(
      '[STUDIO SOURCE]',
      error.message
    );
  }

  if (!source) {
    if (
      type ===
        'LocalScript' ||
      target ===
        'StarterPlayerScripts'
    ) {
      source = `local Players = game:GetService("Players")
local player = Players.LocalPlayer

if not player then
    return
end

-- AI request:
-- ${prompt
  .replace(
    /[\r\n]/g,
    ' '
  )
  .slice(
    0,
    300
  )}
`;
    } else if (
      type ===
      'ModuleScript'
    ) {
      source = `local Module = {}

-- AI request:
-- ${prompt
  .replace(
    /[\r\n]/g,
    ' '
  )
  .slice(
    0,
    300
  )}

return Module
`;
    } else {
      source = `local Players = game:GetService("Players")

-- AI request:
-- ${prompt
  .replace(
    /[\r\n]/g,
    ' '
  )
  .slice(
    0,
    300
  )}
`;
    }
  }

  source =
    guardSource(
      source,
      id,
      target,
      type
    );

  const item = {
    id:
      requestId,

    action:
      'CREATE_SCRIPT',

    provider,

    ownerUserId:
      id,

    ownerName:
      name,

    scriptName:
      sn,

    scriptType:
      type,

    targetService:
      target,

    targetName:
      targetSpec.targetName,

    targetPath:
      targetSpec.targetPath,

    prompt,

    source,

    ownerOnly:
      true,

    ephemeral:
      true,

    deleteOnOwnerLeave:
      true,

    doNotPersist:
      true,

    doNotFixExisting:
      true
  };

  studioQueue.push(
    item
  );

  if (
    studioQueue.length >
    100
  ) {
    studioQueue.shift();
  }

  return {
    ok: true,

    requestId,

    queued: true,

    action:
      item.action,

    scriptName:
      sn,

    scriptType:
      type,

    targetService:
      target,

    targetName:
      targetSpec.targetName,

    targetPath:
      targetSpec.targetPath
  };
}

async function toolboxSearch(
  query,
  limit
) {
  if (
    !ROBLOX_TOOLBOX_API_KEY
  ) {
    throw Object.assign(
      new Error(
        'ROBLOX_TOOLBOX_API_KEY tapılmadı. Render Environment Variables bölməsinə əlavə et.'
      ),
      {
        status:
          401
      }
    );
  }

  const url =
    'https://apis.roblox.com/toolbox-service/v2/assets:search' +
    '?searchCategoryType=Model' +
    '&query=' +
    encodeURIComponent(
      query
    ) +
    '&maxPageSize=' +
    Math.min(
      100,
      Math.max(
        1,
        Number(
          limit
        ) || 25
      )
    ) +
    '&pageNumber=0' +
    '&searchView=Core' +
    '&includeOnlyVerifiedCreators=false' +
    '&sortCategory=Relevance';

  const data =
    await fetchJSON(
      url,
      {
        method:
          'GET',

        headers: {
          'x-api-key':
            ROBLOX_TOOLBOX_API_KEY,

          Accept:
            'application/json'
        }
      },

      'Roblox Toolbox'
    );

  const list =
    data?.creatorStoreAssets ||
    data?.assets ||
    data?.items ||
    data?.results ||
    data?.data ||
    [];

  if (
    !Array.isArray(list)
  ) {
    return [];
  }

  return list
    .map(
      item => {
        const asset =
          item?.asset ||
          item;

        const id =
          Number(
            asset?.id ??
            asset?.assetId ??
            asset?.AssetId ??
            asset?.asset?.id
          );

        const name =
          asset?.name ||
          asset?.Name ||
          asset?.asset?.name ||
          (
            'Model_' +
            id
          );

        return id > 0
          ? {
              id,
              name:
                String(
                  name
                )
            }
          : null;
      }
    )
    .filter(Boolean);
}

async function handler(
  req,
  res
) {
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  if (
    req.method ===
    'OPTIONS'
  ) {
    res.statusCode =
      204;

    res.end();

    return;
  }

  const url =
    new URL(
      req.url || '/',
      'http://' +
        (
          req.headers.host ||
          'localhost'
        )
    );

  if (
    req.method ===
      'GET' &&
    url.pathname ===
      '/health'
  ) {
    json(
      res,
      200,
      {
        ok: true,

        message:
          'Roblox AI backend işləyir.',

        port:
          PORT,

        models: {
          gpt:
            OPENROUTER_MODEL,

          gemini:
            GEMINI_MODEL
        },

        keys: {
          openrouter:
            Boolean(
              OPENROUTER_API_KEY
            ),

          gemini:
            Boolean(
              GEMINI_API_KEY
            ),

          robloxToolbox:
            Boolean(
              ROBLOX_TOOLBOX_API_KEY
            )
        },

        brains:
          memories.size,

        studioQueue:
          studioQueue.length,

        node:
          process.version
      }
    );

    return;
  }

  if (
    req.method ===
      'GET' &&
    url.pathname ===
      '/studio-queue'
  ) {
    json(
      res,
      200,
      {
        ok: true,

        items:
          studioQueue
            .filter(
              x =>
                !doneStudio.has(
                  x.id
                )
            )
            .slice(
              0,
              20
            )
      }
    );

    return;
  }

  // IMPORTANT:
  // Toolbox GET route MUST come before generic POST check.
  if (
    (
      req.method ===
        'GET' ||
      req.method ===
        'POST'
    ) &&
    url.pathname ===
      '/toolbox-search'
  ) {
    try {
      let query =
        String(
          url.searchParams.get(
            'query'
          ) ||
          ''
        ).trim();

      let limit =
        Number(
          url.searchParams.get(
            'limit'
          ) ||
          25
        );

      if (
        req.method ===
        'POST'
      ) {
        const body =
          await readBody(
            req
          );

        query =
          String(
            body?.query ||
            query
          ).trim();

        limit =
          Number(
            body?.limit ||
            limit ||
            25
          );
      }

      if (!query) {
        return json(
          res,
          400,
          {
            ok: false,

            error:
              'Toolbox query boşdur.',

            hasKey:
              Boolean(
                ROBLOX_TOOLBOX_API_KEY
              )
          }
        );
      }

      const results =
        await toolboxSearch(
          query,
          limit
        );

      return json(
        res,
        200,
        {
          ok: true,

          query,

          count:
            results.length,

          results
        }
      );
    } catch (e) {
      console.error(
        '[TOOLBOX ERROR]',
        e
      );

      return json(
        res,
        Number(
          e?.status
        ) || 500,
        {
          ok: false,

          error:
            e?.message ||
            String(e),

          hasKey:
            Boolean(
              ROBLOX_TOOLBOX_API_KEY
            ),

          hint:
            ROBLOX_TOOLBOX_API_KEY
              ? 'Roblox API key scope-unu yoxla.'
              : 'Render Environment Variables bölməsində ROBLOX_TOOLBOX_API_KEY əlavə et.'
        }
      );
    }
  }

  if (
    req.method !==
    'POST'
  ) {
    return json(
      res,
      405,
      {
        ok: false,

        error:
          'POST istifadə edin.'
      }
    );
  }

  let body;

  try {
    body =
      await readBody(
        req
      );
  } catch (e) {
    return json(
      res,
      400,
      {
        ok: false,

        error:
          e.message
      }
    );
  }

  if (
    url.pathname ===
    '/studio-script'
  ) {
    try {
      return json(
        res,
        200,
        await makeScript(
          body
        )
      );
    } catch (e) {
      return json(
        res,
        Number(
          e?.status
        ) || 500,
        {
          ok: false,

          error:
            e?.message ||
            String(e)
        }
      );
    }
  }

  if (
    url.pathname ===
      '/studio-script-complete' ||
    url.pathname ===
      '/studio-ack'
  ) {
    const id =
      String(
        body?.requestId ||
        body?.id ||
        ''
      );

    if (id) {
      doneStudio.add(id);
    }

    for (
      let i =
        studioQueue.length - 1;
      i >= 0;
      i--
    ) {
      if (
        studioQueue[i].id ===
        id
      ) {
        studioQueue.splice(
          i,
          1
        );
      }
    }

    return json(
      res,
      200,
      {
        ok: true,

        requestId:
          id
      }
    );
  }

  if (
    url.pathname !==
      '/gpt' &&
    url.pathname !==
      '/gemini'
  ) {
    return json(
      res,
      404,
      {
        ok: false,

        error:
          'Endpoint tapılmadı.'
      }
    );
  }

  const provider =
    url.pathname ===
      '/gemini'
      ? 'gemini'
      : 'gpt';

  return json(
    res,
    200,
    await processAI(
      provider,
      body
    )
  );
}

const server =
  http.createServer(
    (
      req,
      res
    ) => {
      handler(
        req,
        res
      ).catch(
        e => {
          console.error(
            '[SERVER ERROR]',
            e
          );

          if (
            !res.headersSent
          ) {
            json(
              res,
              500,
              {
                ok:
                  false,

                error:
                  e?.message ||
                  String(e),

                reply:
                  'Server xətası baş verdi.',

                actions:
                  []
              }
            );
          } else {
            try {
              res.end();
            } catch {}
          }
        }
      );
    }
  );

server.on(
  'clientError',
  (
    err,
    socket
  ) => {
    try {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\n\r\n'
      );
    } catch {}
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      '=============================================='
    );

    console.log(
      'Roblox AI Backend hazırdır'
    );

    console.log(
      'Port:',
      PORT
    );

    console.log(
      'GPT:',
      '/gpt'
    );

    console.log(
      'Gemini:',
      '/gemini'
    );

    console.log(
      'Toolbox:',
      '/toolbox-search'
    );

    console.log(
      'Studio:',
      '/studio-script'
    );

    console.log(
      'OpenRouter key:',
      OPENROUTER_API_KEY
        ? 'OK'
        : 'YOOX'
    );

    console.log(
      'Gemini key:',
      GEMINI_API_KEY
        ? 'OK'
        : 'YOOX'
    );

    console.log(
      'Toolbox key:',
      ROBLOX_TOOLBOX_API_KEY
        ? 'OK'
        : 'YOOX'
    );

    console.log(
      '=============================================='
    );
  }
);

process.on(
  'SIGINT',
  () =>
    server.close(
      () =>
        process.exit(0)
    )
);
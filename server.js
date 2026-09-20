'use strict';

// Roblox GPT + Gemini AI Backend
// Node.js 18+
//
// .env:
// OPENROUTER_API_KEY=...
// GEMINI_API_KEY=...
// PORT=3000
// OPENROUTER_MODEL=openrouter/free
// GEMINI_MODEL=gemini-3.1-flash-lite

const http = require('http');
const fs = require('fs');
const path = require('path');

if (typeof fetch !== 'function') {
    throw new Error('Node.js 18+ lazimdir.');
}

function loadDotEnv() {
    const envPath = path.join(process.cwd(), '.env');

    if (!fs.existsSync(envPath)) {
        return;
    }

    try {
        const lines = fs
            .readFileSync(envPath, 'utf8')
            .split(/\r?\n/);

        for (const raw of lines) {
            const line = raw.trim();

            if (!line || line.startsWith('#')) {
                continue;
            }

            const eq = line.indexOf('=');

            if (eq < 1) {
                continue;
            }

            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();

            if (
                value.length >= 2 &&
                (
                    (value.startsWith('"') && value.endsWith('"')) ||
                    (value.startsWith("'") && value.endsWith("'"))
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

const PORT = Number(process.env.PORT || 3000);

const OPENROUTER_MODEL = String(
    process.env.OPENROUTER_MODEL || 'openrouter/free'
).trim();

const GEMINI_MODEL = String(
    process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
).trim();

const OPENROUTER_API_KEY = String(
    process.env.OPENROUTER_API_KEY || ''
).trim();

const GEMINI_API_KEY = String(
    process.env.GEMINI_API_KEY || ''
).trim();

const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_RETRIES = 2;
const MAX_STUDIO_QUEUE = 100;

const brains = new Map();

const studioQueue = [];

let studioRequestId = 1;

const providerChains = {
    gpt: Promise.resolve(),
    gemini: Promise.resolve()
};

const lastRequestAt = {
    gpt: 0,
    gemini: 0
};

const minGap = {
    gpt: 250,
    gemini: 1200
};

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

const str = (v, fallback = '') =>
    typeof v === 'string'
        ? v
        : fallback;

const clamp = (
    v,
    n = MAX_MESSAGE_CHARS
) =>
    str(v).slice(0, n);

function providerName(v) {
    const s = String(v || '')
        .toLowerCase()
        .replace(/[^a-z]/g, '');

    return s.includes('gemini')
        ? 'gemini'
        : 'gpt';
}

function ownerIdOf(body) {
    return String(
        body?.ownerUserId ??
        body?.userId ??
        body?.playerUserId ??
        body?.playerId ??
        'unknown'
    );
}

function ownerNameOf(body) {
    return str(
        body?.ownerName ??
        body?.playerName ??
        body?.username ??
        'Owner',
        'Owner'
    ).slice(0, 80);
}

function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/ə/g, 'e')
        .replace(/ö/g, 'o')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ç/g, 'c');
}

function isActionMessage(message) {
    const m = normalizeText(message);

    return [
        'build',
        'tik',
        'tikinti',
        'qur',
        'ev',
        'house',
        'masin',
        'masın',
        'car',
        'vehicle',
        'follow',
        'izle',
        'teqib',
        'takip',
        'gez',
        'wander',
        'dayan',
        'stop',
        'davam',
        'tp',
        'teleport',
        'come',
        'gel',
        'tullan',
        'jump',
        'dance',
        'dans',
        'reqs',
        'qucaq',
        'hug',
        'carry',
        'dasi',
        'dasima',
        'qaldir',
        'burax',
        'drop',
        'sola',
        'saga',
        'don',
        'toolbox',
        'model',
        'wear',
        'gey',
        'paltar',
        'edit',
        'duzelt',
        'remove',
        'sil',
        'clear',
        'power',
        'guc',
        'speed',
        'fly',
        'forcefield',
        'script',
        'skript',
        'luau',
        'kod'
    ].some(x => m.includes(x));
}

function compactWorld(world) {
    if (!world || typeof world !== 'object') {
        return null;
    }

    return {
        selfPosition: world.selfPosition || null,
        ownerPosition: world.ownerPosition || null,

        otherAIs: Array.isArray(world.otherAIs)
            ? world.otherAIs.slice(0, 12)
            : [],

        nearbyPlayers: Array.isArray(world.nearbyPlayers)
            ? world.nearbyPlayers.slice(0, 20)
            : [],

        nearbyObjects: Array.isArray(world.nearbyObjects)
            ? world.nearbyObjects.slice(0, 40)
            : [],

        vehicle: world.vehicle || null,
        time: world.time ?? null
    };
}

function compactAssets(assets) {
    if (!Array.isArray(assets)) {
        return [];
    }

    return assets.slice(0, 60).map(a => {
        if (typeof a === 'string') {
            return a.slice(0, 150);
        }

        return {
            name: str(a?.name),
            assetId: a?.assetId ?? a?.id ?? null,
            category: str(a?.category),
            source: str(a?.source)
        };
    });
}

function getBrain(
    ownerId,
    provider,
    incomingHistory
) {
    const key = `${ownerId}:${provider}`;

    let brain = brains.get(key);

    if (!brain) {
        brain = {
            history: [],
            updatedAt: Date.now()
        };

        brains.set(key, brain);
    }

    if (
        !brain.history.length &&
        Array.isArray(incomingHistory)
    ) {
        brain.history = incomingHistory
            .filter(
                x =>
                    x &&
                    (
                        x.role === 'user' ||
                        x.role === 'assistant'
                    )
            )
            .map(x => ({
                role: x.role,
                content: clamp(
                    x.content,
                    3500
                )
            }))
            .slice(-MAX_HISTORY);
    }

    return brain;
}

function pushHistory(
    brain,
    role,
    content
) {
    brain.history.push({
        role,
        content: clamp(
            content,
            3500
        )
    });

    while (
        brain.history.length >
        MAX_HISTORY
    ) {
        brain.history.shift();
    }

    brain.updatedAt = Date.now();
}

async function withProviderQueue(
    provider,
    fn
) {
    const previous =
        providerChains[provider];

    let release;

    providerChains[provider] =
        new Promise(resolve => {
            release = resolve;
        });

    try {
        await previous;

        const wait =
            minGap[provider] -
            (
                Date.now() -
                lastRequestAt[provider]
            );

        if (wait > 0) {
            await sleep(wait);
        }

        lastRequestAt[provider] =
            Date.now();

        return await fn();
    } finally {
        release();
    }
}

async function fetchJson(
    url,
    options,
    label
) {
    let last = null;

    for (
        let attempt = 0;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        const controller =
            new AbortController();

        const timer =
            setTimeout(
                () => controller.abort(),
                REQUEST_TIMEOUT_MS
            );

        try {
            const res = await fetch(
                url,
                {
                    ...options,
                    signal:
                        controller.signal
                }
            );

            const text =
                await res.text();

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

            if (res.ok) {
                return data;
            }

            const detail =
                data?.error?.message ||
                data?.message ||
                data?.raw ||
                `HTTP ${res.status}`;

            const err =
                new Error(
                    `${label} HTTP ${res.status}: ${detail}`
                );

            err.status =
                res.status;

            last = err;

            if (
                ![408, 429, 500, 502, 503, 504]
                    .includes(res.status) ||
                attempt === MAX_RETRIES
            ) {
                throw err;
            }

            await sleep(
                800 * (attempt + 1)
            );
        } catch (e) {
            last =
                e?.name === 'AbortError'
                    ? Object.assign(
                          new Error(
                              `${label}: timeout`
                          ),
                          {
                              status: 408
                          }
                      )
                    : e;

            if (
                attempt === MAX_RETRIES
            ) {
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
            `${label}: namelum xeta`
        )
    );
}

function buildSystemPrompt({
    provider,
    ownerName,
    world,
    assets,
    actionMode,
    ownerUserId
}) {
    const ai =
        provider === 'gemini'
            ? 'Gemini'
            : 'GPT';

    const base = `
Sən Roblox oyununda yaşayan ${ai} AI NPC-sən.
Sahibin ${ownerName}-dir.

Azərbaycan dilində təbii danış.
Qısa, normal və insani cavab ver.

User, GPT, Gemini, Assistant kimi başlıq yazma.

İstifadəçinin açıq əmrlərini Roblox action-larına çevir.
Özbaşına gəzişmə.
Özbaşına tikinti etmə.
Özbaşına teleport etmə.

Normal hərəkət fiziki olmalıdır.
Teleport yalnız istifadəçi teleport istəyəndə istifadə olunur.

Dünya məlumatını nəzərə al.

Owner UserId:
${ownerUserId}
`;

    let context = '';

    if (world) {
        context += `
DÜNYA:
${JSON.stringify(
    compactWorld(world)
)}
`;
    }

    if (assets?.length) {
        context += `
ASSETLƏR:
${JSON.stringify(
    compactAssets(assets)
)}
`;
    }

    if (!actionMode) {
        return `${base}${context}
Bu adi söhbətdir.
actions boş array olsun.
`;
    }

    return `${base}${context}

Yalnız bu JSON formasında cavab ver:

{
  "reply": "....",
  "actions": []
}

İcazəli action-lar:

STOP
RESUME
FOLLOW
UNFOLLOW
COME
TELEPORT
JUMP
DANCE
DANCE_WITH_OWNER
STOP_DANCE
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

Əmrlər:

"məni takip et"
→ FOLLOW

"məni izlə"
→ FOLLOW

"mənimlə gəl"
→ COME

"yanıma gəl"
→ COME

"mənə TP ol"
→ TELEPORT

"tullan"
→ JUMP

"dans et"
→ DANCE

"mənimlə dans et"
→ DANCE_WITH_OWNER

"dansımızı dayandır"
→ STOP_DANCE

"dayan"
→ STOP

"davam et"
→ RESUME

"məni qucağına al"
→ HUG

"məni daşı"
→ CARRY

"məni burax"
→ DROP

"düz get"
→ MOVE forward

"geri get"
→ MOVE back

"sola get"
→ MOVE left

"sağa get"
→ MOVE right

"sağa dön"
→ TURN RIGHT

"sola dön"
→ TURN LEFT

"tikdiklərini sil"
→ CLEAR

"tikdiklərindən evi sil"
→ REMOVE

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

TURN:
{
  "type":"TURN",
  "direction":"LEFT|RIGHT",
  "degrees":90
}

WALK_TO:
{
  "type":"WALK_TO",
  "position":[x,y,z],
  "distance":3
}

BUILD:

{
  "type":"BUILD",
  "name":"UserRequestedObject",
  "description":"istifadəçinin dəqiq istəyi",
  "parts":[
    {
      "shape":"Block",
      "size":[4,1,4],
      "offset":[0,0,0],
      "material":"Plastic",
      "color":[255,255,255],
      "anchored":true,
      "name":"Part"
    }
  ]
}

BUILD üçün əvvəlcədən yalnız Ev/Maşın/Qatar ilə məhdudlaşma.

İstifadəçi nə istəyirsə onu qur.

Məsələn:
ev
maşın
qatar
təyyarə
robot
qüllə
körpü
meşə
mağaza
ofis
garaj
otaq
fabrik
stadion
gəmi
helikopter
tank
raket
qala
və s.

İstifadəçinin verdiyi detallara mümkün qədər tam əməl et.

İç hissələri də qur.
Otaqları qur.
Divarları qur.
Döşəməni qur.
Tavanı qur.
Qapıları qur.
Pəncərələri qur.
Mebeli qur.
Maşın üçün təkərləri, oturacaqları, sükanı və s. qur.
Qatar üçün vaqonları, relsləri, oturacaqları və s. qur.

Hazır bir modelə ehtiyac yaratma.
Əsas tikinti Part-lardan olsun.

BUILD-də mümkün qədər çox düzgün hissə qaytar.

TOOLBOX yalnız istifadəçi dekorasiya/model istəyəndə istifadə oluna bilər.

Əgər həm BUILD, həm TOOLBOX lazımdırsa:
actions array-də hər ikisini ardıcıl qaytar.

TOOLBOX:
{
  "type":"TOOLBOX",
  "query":"istifadəçinin istədiyi dekorasiya",
  "count":1
}

Script:

STUDIO_SCRIPT_CREATE:
{
  "type":"STUDIO_SCRIPT_CREATE",
  "scriptName":"OwnerScript",
  "targetService":"ServerScriptService|StarterPlayerScripts",
  "prompt":"tam tələb"
}

STUDIO_SCRIPT_DELETE:
{
  "type":"STUDIO_SCRIPT_DELETE",
  "scriptName":"OwnerScript",
  "targetService":"ServerScriptService|StarterPlayerScripts"
}

Script yalnız istifadəçi istəyəndə yaradılır.

Mövcud scriptləri avtomatik düzəltmə.
Mövcud scriptləri avtomatik overwrite etmə.
İstifadəçi xüsusi olaraq deməyincə mövcud scriptə toxunma.

Server Script:
ServerScriptService

LocalScript/Input:
StarterPlayerScripts

Owner-only tələb olunanda:
yalnız UserId ${ownerUserId} üçün işləməlidir.
`;
}

function parseJSON(text) {
    let t = str(text).trim();

    t = t
        .replace(
            /^```(?:json)?\s*/i,
            ''
        )
        .replace(
            /\s*```$/i,
            ''
        )
        .trim();

    try {
        return JSON.parse(t);
    } catch {}

    const a =
        t.indexOf('{');

    const b =
        t.lastIndexOf('}');

    if (
        a >= 0 &&
        b > a
    ) {
        try {
            return JSON.parse(
                t.slice(
                    a,
                    b + 1
                )
            );
        } catch {}
    }

    return null;
}

function normalizeAction(a) {
    if (
        !a ||
        typeof a !== 'object'
    ) {
        return null;
    }

    const x = {
        ...a,
        type: str(a.type)
            .toUpperCase()
            .trim()
    };

    if (!x.type) {
        return null;
    }

    if (
        Array.isArray(x.position)
    ) {
        x.position = x.position
            .slice(0, 3)
            .map(
                v =>
                    Number(v) || 0
            );
    }

    if (
        Array.isArray(x.size)
    ) {
        x.size = x.size
            .slice(0, 3)
            .map(v =>
                Math.max(
                    0.1,
                    Number(v) || 1
                )
            );
    }

    if (
        Array.isArray(x.offset)
    ) {
        x.offset =
            x.offset
                .slice(0, 3)
                .map(
                    v =>
                        Number(v) || 0
                );
    }

    if (
        Array.isArray(x.color)
    ) {
        x.color =
            x.color
                .slice(0, 3)
                .map(v =>
                    Math.max(
                        0,
                        Math.min(
                            255,
                            Number(v) || 0
                        )
                    )
                );
    }

    if (x.count != null) {
        x.count =
            Math.max(
                1,
                Math.min(
                    10,
                    Number(x.count) || 1
                )
            );
    }

    if (x.assetId != null) {
        x.assetId =
            Number(x.assetId) || 0;
    }

    if (x.duration != null) {
        x.duration =
            Math.max(
                0.2,
                Math.min(
                    120,
                    Number(x.duration) || 3
                )
            );
    }

    if (x.speed != null) {
        x.speed =
            Math.max(
                0.1,
                Math.min(
                    100,
                    Number(x.speed) || 8
                )
            );
    }

    if (x.degrees != null) {
        x.degrees =
            Math.max(
                1,
                Math.min(
                    360,
                    Number(x.degrees) || 90
                )
            );
    }

    if (
        Array.isArray(x.parts)
    ) {
        x.parts =
            x.parts
                .slice(0, 120)
                .map(
                    p => ({
                        ...p,

                        shape:
                            str(
                                p?.shape,
                                'Block'
                            ),

                        size:
                            Array.isArray(
                                p?.size
                            )
                                ? p.size
                                    .slice(0, 3)
                                    .map(
                                        v =>
                                            Math.max(
                                                0.1,
                                                Number(v) || 1
                                            )
                                    )
                                : [
                                    4,
                                    1,
                                    4
                                ],

                        offset:
                            Array.isArray(
                                p?.offset
                            )
                                ? p.offset
                                    .slice(0, 3)
                                    .map(
                                        v =>
                                            Number(v) || 0
                                    )
                                : [
                                    0,
                                    0,
                                    0
                                ],

                        material:
                            str(
                                p?.material,
                                'Plastic'
                            ),

                        color:
                            Array.isArray(
                                p?.color
                            )
                                ? p.color
                                    .slice(0, 3)
                                    .map(
                                        v =>
                                            Math.max(
                                                0,
                                                Math.min(
                                                    255,
                                                    Number(v) || 255
                                                )
                                            )
                                    )
                                : [
                                    255,
                                    255,
                                    255
                                ],

                        anchored:
                            p?.anchored !== false,

                        name:
                            str(
                                p?.name,
                                'Part'
                            )
                    })
                );
    }

    return x;
}

function normalizeModelOutput(
    raw
) {
    const p =
        parseJSON(raw);

    if (
        p &&
        typeof p === 'object'
    ) {
        const actions =
            Array.isArray(
                p.actions
            )
                ? p.actions
                    .map(
                        normalizeAction
                    )
                    .filter(Boolean)
                : [];

        if (
            !actions.length &&
            p.action
        ) {
            const one =
                normalizeAction({
                    type:
                        p.action
                });

            if (one) {
                actions.push(one);
            }
        }

        return {
            reply: clamp(
                p.reply ||
                p.message ||
                p.text ||
                'Hazirdir.'
            ),

            actions,

            raw
        };
    }

    return {
        reply: clamp(
            raw ||
            'Hazirdir.'
        ),

        actions: [],

        raw
    };
}

function localCommand(
    message
) {
    const original =
        String(message || '')
            .trim();

    const m =
        normalizeText(
            original
        );

    const reply = (
        text,
        ...actions
    ) => ({
        reply: text,
        actions
    });

    if (
        /^(dayan|dur|stop|sakit ol)$/.test(m) ||
        /dans(imi|imizi)? durdur/.test(m) ||
        /dansi? dayandir/.test(m)
    ) {
        return reply(
            'Oldu, dayandım.',
            {
                type: 'STOP'
            }
        );
    }

    if (
        /^(davam|davam et|gez|gəz|wander)$/.test(m)
    ) {
        return reply(
            'Oldu, davam edirəm.',
            {
                type: 'RESUME'
            }
        );
    }

    if (
        /(meni|məni).*(takip|teqib|izle|izlə)/.test(m) ||
        /follow me/.test(m)
    ) {
        return reply(
            'Oldu, səni izləyirəm.',
            {
                type: 'FOLLOW',
                target: 'OWNER'
            }
        );
    }

    if (
        /(izleme|izləmə).*(meni|məni)/.test(m) ||
        /follow off/.test(m)
    ) {
        return reply(
            'Oldu, izləməyi dayandırdım.',
            {
                type:
                    'UNFOLLOW'
            }
        );
    }

    if (
        /(yanima|yanıma|bura|buraya|mene|mənə).*(gel|gəl)/.test(m) ||
        /come here/.test(m)
    ) {
        return reply(
            'Yanına gəlirəm.',
            {
                type: 'COME'
            }
        );
    }

    if (
        /(meni|məni|mene|mənə).*(tp|teleport)/.test(m) ||
        /^tp ol$/.test(m)
    ) {
        return reply(
            'Yanına teleport oluram.',
            {
                type:
                    'TELEPORT'
            }
        );
    }

    if (
        /^(tullan|jump|hopla)$/.test(m)
    ) {
        return reply(
            'Tullanıram!',
            {
                type: 'JUMP'
            }
        );
    }

    if (
        /(menimle|mənimlə|meni de|məni də).*(dance|dans|reqs|rəqs)/.test(m)
    ) {
        return reply(
            'Oldu, birlikdə rəqs edirik!',
            {
                type:
                    'DANCE_WITH_OWNER'
            }
        );
    }

    if (
        /^(dance|dans|reqs|rəqs)( et)?$/.test(m)
    ) {
        return reply(
            'Rəqs edirəm!',
            {
                type: 'DANCE'
            }
        );
    }

    if (
        /(meni|məni).*(qucagina|qucağına|hug)/.test(m) ||
        /^hug( me)?$/.test(m)
    ) {
        return reply(
            'Oldu, səni qucaqlayıram.',
            {
                type: 'HUG'
            }
        );
    }

    if (
        /(meni|məni).*(dasi|daşı|dasima|qaldir|qaldır|carry)/.test(m) ||
        /^carry( me)?$/.test(m)
    ) {
        return reply(
            'Oldu, səni daşıyıram.',
            {
                type: 'CARRY'
            }
        );
    }

    if (
        /(burax|birak|drop).*(meni|məni)/.test(m) ||
        /^drop( me)?$/.test(m)
    ) {
        return reply(
            'Oldu, buraxdım.',
            {
                type: 'DROP'
            }
        );
    }

    if (
        /duz get|düz get|ileri get|irəli get/.test(m)
    ) {
        return reply(
            'İrəli gedirəm.',
            {
                type: 'MOVE',
                direction:
                    'forward',
                duration: 3,
                speed: 8
            }
        );
    }

    if (
        /geri get|geriye get/.test(m)
    ) {
        return reply(
            'Geri gedirəm.',
            {
                type: 'MOVE',
                direction: 'back',
                duration: 3,
                speed: 8
            }
        );
    }

    if (
        /sola get|sol get|left/.test(m)
    ) {
        return reply(
            'Sola gedirəm.',
            {
                type: 'MOVE',
                direction: 'left',
                duration: 2,
                speed: 8
            }
        );
    }

    if (
        /saga get|sağa get|right/.test(m)
    ) {
        return reply(
            'Sağa gedirəm.',
            {
                type: 'MOVE',
                direction:
                    'right',
                duration: 2,
                speed: 8
            }
        );
    }

    if (
        /saga don|sağa dön/.test(m)
    ) {
        return reply(
            'Sağa dönürəm.',
            {
                type: 'TURN',
                direction:
                    'RIGHT',
                degrees: 90
            }
        );
    }

    if (
        /sola don|sola dön/.test(m)
    ) {
        return reply(
            'Sola dönürəm.',
            {
                type: 'TURN',
                direction:
                    'LEFT',
                degrees: 90
            }
        );
    }

    if (
        /^(clear|her seyi sil|hər şeyi sil|hamisini sil|hamısını sil)$/.test(m)
    ) {
        return reply(
            'Öz tikdiklərimi sildim.',
            {
                type: 'CLEAR'
            }
        );
    }

    if (
        /(masin|maşın|car|vehicle).*(tik|qur|build|duzelt|düzəlt)/.test(m)
    ) {
        return reply(
            'Oldu, maşın tikirəm.',
            {
                type: 'BUILD',
                name: 'Car',
                description:
                    original
            }
        );
    }

    if (
        /(ev|house).*(tik|qur|build|duzelt|düzəlt)/.test(m)
    ) {
        return reply(
            'Oldu, ev tikirəm.',
            {
                type: 'BUILD',
                name: 'House',
                description:
                    original
            }
        );
    }

    if (
        /(qulle|qüllə|tower).*(tik|qur|build)/.test(m)
    ) {
        return reply(
            'Oldu, qüllə tikirəm.',
            {
                type: 'BUILD',
                name: 'Tower',
                description:
                    original
            }
        );
    }

    if (
        /^(geyimi sil|paltari sil|paltarı sil|clear outfit)$/.test(m)
    ) {
        return reply(
            'Geyim təmizləndi.',
            {
                type:
                    'CLEAR_OUTFIT'
            }
        );
    }

    if (
        /script|skript|luau|kod yaz|script yaz|script yarat|script hazirla/.test(m)
    ) {
        if (
            /sil|poz|delete/.test(m)
        ) {
            return reply(
                'Oldu, öz yaratdığım scripti silirəm.',
                {
                    type:
                        'STUDIO_SCRIPT_DELETE',

                    scriptName:
                        '',

                    targetService:
                        'ServerScriptService'
                }
            );
        }

        return reply(
            'Oldu, yeni script hazırlayıram.',
            {
                type:
                    'STUDIO_SCRIPT_CREATE',

                prompt:
                    original
            }
        );
    }

    return null;
}

async function callGPT({
    ownerName,
    ownerUserId,
    message,
    history,
    world,
    assets
}) {
    if (!OPENROUTER_API_KEY) {
        throw Object.assign(
            new Error(
                'OPENROUTER_API_KEY tapilmadi.'
            ),
            {
                status: 401
            }
        );
    }

    const actionMode =
        isActionMessage(
            message
        );

    const system =
        buildSystemPrompt({
            provider:
                'gpt',

            ownerName,
            ownerUserId,

            world:
                actionMode
                    ? world
                    : null,

            assets:
                actionMode
                    ? assets
                    : [],

            actionMode
        });

    const data =
        await fetchJson(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                method: 'POST',

                headers: {
                    Authorization:
                        `Bearer ${OPENROUTER_API_KEY}`,

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
                                    system
                            },

                            ...history.slice(
                                -MAX_HISTORY
                            ),

                            {
                                role:
                                    'user',

                                content:
                                    clamp(message)
                            }
                        ],

                        temperature:
                            0.7,

                        max_tokens:
                            actionMode
                                ? 1000
                                : 500
                    })
            },
            'OpenRouter'
        );

    const content =
        data
            ?.choices?.[0]
            ?.message
            ?.content;

    if (!content) {
        throw new Error(
            'OpenRouter bos cavab qaytardi.'
        );
    }

    return normalizeModelOutput(
        content
    );
}

async function callGemini({
    ownerName,
    ownerUserId,
    message,
    history,
    world,
    assets
}) {
    if (!GEMINI_API_KEY) {
        throw Object.assign(
            new Error(
                'GEMINI_API_KEY tapilmadi.'
            ),
            {
                status: 401
            }
        );
    }

    const actionMode =
        isActionMessage(
            message
        );

    const system =
        buildSystemPrompt({
            provider:
                'gemini',

            ownerName,
            ownerUserId,

            world:
                actionMode
                    ? world
                    : null,

            assets:
                actionMode
                    ? assets
                    : [],

            actionMode
        });

    const contents =
        history
            .slice(-MAX_HISTORY)
            .map(x => ({
                role:
                    x.role ===
                    'assistant'
                        ? 'model'
                        : 'user',

                parts: [
                    {
                        text:
                            clamp(
                                x.content,
                                3500
                            )
                    }
                ]
            }));

    contents.push({
        role: 'user',

        parts: [
            {
                text:
                    clamp(
                        message
                    )
            }
        ]
    });

    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            GEMINI_MODEL
        )}:generateContent`;

    const data =
        await fetchJson(
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
                                        system
                                }
                            ]
                        },

                        contents,

                        generationConfig: {
                            temperature:
                                0.7,

                            maxOutputTokens:
                                actionMode
                                    ? 1000
                                    : 500
                        }
                    })
            },
            'Gemini'
        );

    const content =
        Array.isArray(
            data
                ?.candidates?.[0]
                ?.content
                ?.parts
        )
            ? data
                .candidates[0]
                .content.parts
                .map(
                    p =>
                        str(p?.text)
                )
                .filter(Boolean)
                .join('')
            : '';

    if (!content) {
        throw new Error(
            'Gemini bos cavab qaytardi.'
        );
    }

    return normalizeModelOutput(
        content
    );
}

function extractMessage(body) {
    if (
        typeof body === 'string'
    ) {
        return clamp(body);
    }

    const candidates = [
        body?.message,
        body?.text,
        body?.prompt,
        body?.query,
        body?.input,
        body?.userMessage,
        body?.messageText,
        body?.content,
        body?.question,
        body?.data?.message,
        body?.data?.text,
        body?.data?.prompt,
        body?.payload?.message,
        body?.payload?.text,
        body?.payload?.prompt
    ];

    for (
        const v of candidates
    ) {
        if (
            typeof v === 'string' &&
            v.trim()
        ) {
            return clamp(v);
        }
    }

    return '';
}

function safeScriptName(
    name
) {
    return String(
        name ||
        'AI_GeneratedScript'
    )
        .replace(
            /[^a-zA-Z0-9_-]/g,
            '_'
        )
        .slice(
            0,
            80
        ) ||
        'AI_GeneratedScript';
}

function inferTarget(
    prompt,
    supplied
) {
    const p =
        normalizeText(
            prompt
        );

    const s =
        normalizeText(
            supplied
        );

    if (
        s.includes(
            'starterplayer'
        ) ||
        s.includes(
            'localscript'
        ) ||
        s.includes(
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
            'input'
        )
    ) {
        return 'StarterPlayerScripts';
    }

    return 'ServerScriptService';
}

function stripFences(
    source
) {
    return str(source)
        .replace(
            /^```(?:lua|luau)?\s*/i,
            ''
        )
        .replace(
            /\s*```$/i,
            ''
        )
        .trim()
        .slice(
            0,
            60000
        );
}

function fallbackScript(
    prompt,
    ownerUserId,
    target
) {
    const id =
        Number(ownerUserId) ||
        0;

    const p =
        normalizeText(
            prompt
        );

    if (
        target ===
        'StarterPlayerScripts'
    ) {
        return `-- AI generated LocalScript
local Players = game:GetService("Players")
local LocalPlayer = Players.LocalPlayer
local OWNER_USER_ID = ${id}

if not LocalPlayer or LocalPlayer.UserId ~= OWNER_USER_ID then
    return
end

-- Request:
-- ${String(prompt)
            .replace(
                /[-\n\r]/g,
                ' '
            )
            .slice(
                0,
                180
            )}
`;
    }

    if (
        p.includes('speed') ||
        p.includes('suret') ||
        p.includes('surət')
    ) {
        return `-- Owner Speed
local Players = game:GetService("Players")
local OWNER_USER_ID = ${id}

local function apply(player)
    if player.UserId ~= OWNER_USER_ID then
        return
    end

    local character =
        player.Character or
        player.CharacterAdded:Wait()

    character
        :WaitForChild("Humanoid")
        .WalkSpeed = 32
end

for _, player in ipairs(
    Players:GetPlayers()
) do
    if player.UserId == OWNER_USER_ID then
        task.defer(
            apply,
            player
        )
    end
end

Players.PlayerAdded:Connect(
    function(player)
        if player.UserId == OWNER_USER_ID then
            player.CharacterAdded:Connect(
                function()
                    apply(player)
                end
            )
        end
    end
)
`;
    }

    if (
        p.includes('jump') ||
        p.includes('tullan')
    ) {
        return `-- Owner High Jump
local Players = game:GetService("Players")
local OWNER_USER_ID = ${id}

local function apply(player)
    if player.UserId ~= OWNER_USER_ID then
        return
    end

    local character =
        player.Character or
        player.CharacterAdded:Wait()

    local humanoid =
        character:WaitForChild("Humanoid")

    humanoid.UseJumpPower = true
    humanoid.JumpPower = 100
end

for _, player in ipairs(
    Players:GetPlayers()
) do
    if player.UserId == OWNER_USER_ID then
        task.defer(
            apply,
            player
        )
    end
end

Players.PlayerAdded:Connect(
    function(player)
        if player.UserId == OWNER_USER_ID then
            player.CharacterAdded:Connect(
                function()
                    apply(player)
                end
            )
        end
    end
)
`;
    }

    return `-- AI generated owner-only script
local Players = game:GetService("Players")
local OWNER_USER_ID = ${id}

if Players.LocalPlayer and
   Players.LocalPlayer.UserId ~= OWNER_USER_ID then
    return
end

-- Request:
-- ${String(prompt)
            .replace(
                /[-\n\r]/g,
                ' '
            )
            .slice(
                0,
                240
            )}
`;
}

async function createStudioScriptTask(
    body
) {
    const prompt =
        clamp(
            body?.prompt ||
            body?.message ||
            body?.text ||
            '',
            4000
        ).trim();

    const ownerUserId =
        ownerIdOf(body);

    const ownerName =
        ownerNameOf(body);

    const provider =
        providerName(
            body?.provider
        );

    const actionRaw =
        String(
            body?.action ||
            body?.type ||
            body?.scriptAction ||
            'CREATE'
        ).toUpperCase();

    const isDelete =
        actionRaw.includes(
            'DELETE'
        ) ||
        actionRaw.includes(
            'REMOVE'
        ) ||
        actionRaw.includes(
            'SIL'
        );

    const targetService =
        inferTarget(
            prompt,
            body?.targetService ||
            body?.target
        );

    const scriptType =
        targetService ===
        'StarterPlayerScripts'
            ? 'LocalScript'
            : 'Script';

    const scriptName =
        safeScriptName(
            body?.scriptName ||
            body?.name ||
            ''
        );

    const id =
        `studio_${Date.now()}_${studioRequestId++}`;

    if (
        !prompt &&
        !isDelete
    ) {
        throw new Error(
            'Script prompt bosdur.'
        );
    }

    if (isDelete) {
        const item = {
            id,

            action:
                'DELETE_SCRIPT',

            prompt,

            provider,

            scriptName,

            targetService,

            scriptType,

            source: '',

            ownerUserId,

            ownerName,

            createdAt:
                Date.now(),

            ownerOnly:
                true,

            doNotFixExisting:
                true
        };

        studioQueue.push(
            item
        );

        while (
            studioQueue.length >
            MAX_STUDIO_QUEUE
        ) {
            studioQueue.shift();
        }

        return {
            ok: true,

            requestId: id,

            queued: true,

            action:
                'DELETE_SCRIPT',

            scriptName,

            targetService
        };
    }

    const system = `
You write only valid Roblox Luau source code.

Owner UserId:
${Number(ownerUserId) || 0}

Owner name:
${ownerName}

Target:
${targetService}

Script type:
${scriptType}

Rules:

1. Script must affect ONLY owner UserId ${Number(ownerUserId) || 0}.
2. Never use loadstring.
3. Never use executor APIs.
4. Never use backdoors.
5. Never use arbitrary require IDs.
6. Never use external URLs unless explicitly required and safe.
7. Do not overwrite existing scripts.
8. Create a new script.
9. Return ONLY Luau source code.
`;

    let source = '';

    try {
        if (
            provider === 'gpt' &&
            OPENROUTER_API_KEY
        ) {
            const data =
                await fetchJson(
                    'https://openrouter.ai/api/v1/chat/completions',
                    {
                        method: 'POST',

                        headers: {
                            Authorization:
                                `Bearer ${OPENROUTER_API_KEY}`,

                            'Content-Type':
                                'application/json',

                            'X-Title':
                                'Roblox AI Studio Writer'
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
                                    0.15,

                                max_tokens:
                                    1800
                            })
                    },
                    'OpenRouter Studio'
                );

            source =
                stripFences(
                    data
                        ?.choices?.[0]
                        ?.message
                        ?.content ||
                    ''
                );
        } else if (
            provider === 'gemini' &&
            GEMINI_API_KEY
        ) {
            const data =
                await fetchJson(
                    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
                        GEMINI_MODEL
                    )}:generateContent`,
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
                                        0.15,

                                    maxOutputTokens:
                                        1800
                                }
                            })
                    },
                    'Gemini Studio'
                );

            source =
                stripFences(
                    (
                        data
                            ?.candidates?.[0]
                            ?.content
                            ?.parts ||
                        []
                    )
                        .map(
                            p =>
                                str(
                                    p?.text
                                )
                        )
                        .filter(
                            Boolean
                        )
                        .join('')
                );
        }
    } catch (e) {
        console.warn(
            '[STUDIO SCRIPT] AI generation failed:',
            e.message
        );
    }

    if (!source) {
        source =
            fallbackScript(
                prompt,
                ownerUserId,
                targetService
            );
    }

    const item = {
        id,

        action:
            'CREATE_SCRIPT',

        prompt,

        provider,

        scriptName,

        targetService,

        scriptType,

        source,

        ownerUserId,

        ownerName,

        ownerOnly:
            true,

        doNotFixExisting:
            true,

        createdAt:
            Date.now()
    };

    studioQueue.push(
        item
    );

    while (
        studioQueue.length >
        MAX_STUDIO_QUEUE
    ) {
        studioQueue.shift();
    }

    return {
        ok: true,

        requestId: id,

        queued: true,

        action:
            'CREATE_SCRIPT',

        scriptName,

        targetService,

        source
    };
}

async function processAI(
    provider,
    body
) {
    const ownerUserId =
        ownerIdOf(body);

    const ownerName =
        ownerNameOf(body);

    const message =
        extractMessage(body);

    if (!message.trim()) {
        return {
            ok: false,

            provider,

            reply:
                'Mesaj boşdur.',

            actions: []
        };
    }

    console.log(
        `[${provider.toUpperCase()}] ${ownerName} (${ownerUserId}): ${message}`
    );

    const brain =
        getBrain(
            ownerUserId,
            provider,
            body?.history
        );

    const local =
        localCommand(message);

    if (local) {
        pushHistory(
            brain,
            'user',
            message
        );

        const localAction =
            local.actions?.[0];

        if (
            localAction?.type ===
                'STUDIO_SCRIPT_CREATE' ||
            localAction?.type ===
                'STUDIO_SCRIPT'
        ) {
            const task =
                await createStudioScriptTask(
                    {
                        ...body,

                        provider,

                        ownerUserId,

                        ownerName,

                        prompt:
                            localAction.prompt ||
                            message
                    }
                );

            const reply =
                `Oldu, ${task.scriptName} hazırlanıb. Studio queue-ya göndərildi.`;

            pushHistory(
                brain,
                'assistant',
                reply
            );

            return {
                ok: true,

                provider,

                ownerUserId,

                ownerName,

                reply,

                action:
                    'STUDIO_SCRIPT_CREATE',

                actions: [
                    {
                        type:
                            'STUDIO_SCRIPT_CREATE',

                        scriptName:
                            task.scriptName,

                        targetService:
                            task.targetService
                    }
                ],

                studioRequestId:
                    task.requestId,

                local: true
            };
        }

        if (
            localAction?.type ===
            'STUDIO_SCRIPT_DELETE'
        ) {
            const task =
                await createStudioScriptTask(
                    {
                        ...body,

                        provider,

                        ownerUserId,

                        ownerName,

                        prompt:
                            message,

                        action:
                            'DELETE_SCRIPT',

                        scriptName:
                            body?.scriptName ||
                            '',

                        targetService:
                            body?.targetService
                    }
                );

            const reply =
                'Oldu, silinmə əmri queue-ya göndərildi.';

            pushHistory(
                brain,
                'assistant',
                reply
            );

            return {
                ok: true,

                provider,

                ownerUserId,

                ownerName,

                reply,

                action:
                    'STUDIO_SCRIPT_DELETE',

                actions: [
                    {
                        type:
                            'STUDIO_SCRIPT_DELETE',

                        scriptName:
                            task.scriptName,

                        targetService:
                            task.targetService
                    }
                ],

                studioRequestId:
                    task.requestId,

                local: true
            };
        }

        pushHistory(
            brain,
            'assistant',
            local.reply
        );

        return {
            ok: true,

            provider,

            ownerUserId,

            ownerName,

            reply:
                local.reply,

            action:
                local.actions[0]?.type ||
                'NONE',

            actions:
                local.actions,

            local: true
        };
    }

    const world =
        body?.world ||
        body?.worldSnapshot ||
        null;

    const assets =
        body?.assets ||
        body?.availableAssets ||
        [];

    pushHistory(
        brain,
        'user',
        message
    );

    try {
        const result =
            await withProviderQueue(
                provider,

                () =>
                    provider ===
                    'gemini'
                        ? callGemini(
                              {
                                  ownerName,
                                  ownerUserId,
                                  message,

                                  history:
                                      brain.history.slice(
                                          0,
                                          -1
                                      ),

                                  world,

                                  assets
                              }
                          )
                        : callGPT(
                              {
                                  ownerName,
                                  ownerUserId,
                                  message,

                                  history:
                                      brain.history.slice(
                                          0,
                                          -1
                                      ),

                                  world,

                                  assets
                              }
                          )
            );

        pushHistory(
            brain,
            'assistant',
            result.reply
        );

        return {
            ok: true,

            provider,

            ownerUserId,

            ownerName,

            reply:
                result.reply,

            action:
                result.actions[0]?.type ||
                'NONE',

            actions:
                result.actions,

            raw:
                result.raw,

            local:
                false
        };
    } catch (e) {
        if (
            brain.history.at(-1)?.role ===
            'user'
        ) {
            brain.history.pop();
        }

        const status =
            Number(
                e?.status ||
                500
            );

        let reply =
            provider ===
            'gemini'
                ? 'Gemini hazırda cavab verə bilmədi.'
                : 'GPT hazırda cavab verə bilmədi.';

        if (
            status === 401 ||
            status === 403
        ) {
            reply =
                provider ===
                'gemini'
                    ? 'Gemini API açarı yanlışdır və ya yoxdur.'
                    : 'OpenRouter API açarı yanlışdır və ya yoxdur.';
        } else if (
            status === 429
        ) {
            reply =
                'AI sorğu limitinə çatdı. Bir az sonra yenidən yoxla.';
        }

        console.error(
            `[${provider.toUpperCase()} ERROR]`,
            e
        );

        return {
            ok: false,

            provider,

            ownerUserId,

            ownerName,

            reply,

            action:
                'NONE',

            actions: [],

            error:
                e.message,

            status
        };
    }
}

function setCors(res) {
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
}

function sendJson(
    res,
    status,
    payload
) {
    const data =
        JSON.stringify(
            payload
        );

    res.statusCode =
        status;

    res.setHeader(
        'Content-Type',
        'application/json; charset=utf-8'
    );

    res.setHeader(
        'Content-Length',
        Buffer.byteLength(data)
    );

    res.end(data);
}

function readBody(req) {
    return new Promise(
        (resolve, reject) => {
            let body = '';
            let size = 0;

            req.on(
                'data',
                chunk => {
                    size +=
                        chunk.length;

                    if (
                        size >
                        MAX_BODY_BYTES
                    ) {
                        reject(
                            new Error(
                                'Request çox böyükdür.'
                            )
                        );

                        req.destroy();
                        return;
                    }

                    body +=
                        chunk.toString(
                            'utf8'
                        );
                }
            );

            req.on(
                'end',
                () => {
                    if (
                        !body.trim()
                    ) {
                        return resolve(
                            {}
                        );
                    }

                    try {
                        const parsed =
                            JSON.parse(
                                body
                            );

                        resolve(
                            typeof parsed ===
                            'string'
                                ? {
                                      message:
                                          parsed
                                  }
                                : parsed
                        );
                    } catch {
                        resolve({
                            message:
                                body.trim()
                        });
                    }
                }
            );

            req.on(
                'error',
                reject
            );
        }
    );
}

const server =
    http.createServer(
        async (
            req,
            res
        ) => {
            setCors(res);

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
                    req.url ||
                        '/',
                    `http://${
                        req.headers.host ||
                        '127.0.0.1'
                    }`
                );

            if (
                req.method ===
                    'GET' &&
                url.pathname ===
                    '/health'
            ) {
                return sendJson(
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
                                !!OPENROUTER_API_KEY,

                            gemini:
                                !!GEMINI_API_KEY
                        },

                        brains:
                            brains.size,

                        studioQueue:
                            studioQueue.length,

                        node:
                            process.version
                    }
                );
            }

            if (
                req.method ===
                    'GET' &&
                url.pathname ===
                    '/studio-queue'
            ) {
                const owner =
                    String(
                        url.searchParams.get(
                            'ownerUserId'
                        ) ||
                        ''
                    );

                const items =
                    owner
                        ? studioQueue.filter(
                              x =>
                                  String(
                                      x.ownerUserId
                                  ) === owner
                          )
                        : studioQueue.slice();

                return sendJson(
                    res,
                    200,
                    {
                        ok: true,

                        items:
                            items.slice(
                                0,
                                20
                            )
                    }
                );
            }

            if (
                req.method ===
                    'POST' &&
                url.pathname ===
                    '/studio-script'
            ) {
                try {
                    const body =
                        await readBody(
                            req
                        );

                    const result =
                        await createStudioScriptTask(
                            body
                        );

                    return sendJson(
                        res,
                        200,
                        result
                    );
                } catch (e) {
                    console.error(
                        '[STUDIO]',
                        e
                    );

                    return sendJson(
                        res,
                        400,
                        {
                            ok: false,

                            error:
                                e.message
                        }
                    );
                }
            }

            if (
                req.method ===
                    'POST' &&
                url.pathname ===
                    '/studio-ack'
            ) {
                try {
                    const body =
                        await readBody(
                            req
                        );

                    const id =
                        String(
                            body?.id ||
                            body?.requestId ||
                            ''
                        );

                    const owner =
                        String(
                            body?.ownerUserId ||
                            ''
                        );

                    const index =
                        studioQueue.findIndex(
                            x =>
                                String(
                                    x.id
                                ) === id &&
                                String(
                                    x.ownerUserId
                                ) === owner
                        );

                    if (
                        index >= 0
                    ) {
                        studioQueue.splice(
                            index,
                            1
                        );
                    }

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true,

                            removed:
                                index >= 0
                        }
                    );
                } catch (e) {
                    return sendJson(
                        res,
                        400,
                        {
                            ok: false,

                            error:
                                e.message
                        }
                    );
                }
            }

            if (
                req.method ===
                    'POST' &&
                url.pathname ===
                    '/studio-script-complete'
            ) {
                try {
                    const body =
                        await readBody(
                            req
                        );

                    const id =
                        String(
                            body?.requestId ||
                            body?.id ||
                            ''
                        );

                    const owner =
                        String(
                            body?.ownerUserId ||
                            ''
                        );

                    const index =
                        studioQueue.findIndex(
                            x =>
                                String(
                                    x.id
                                ) === id &&
                                (
                                    !owner ||
                                    String(
                                        x.ownerUserId
                                    ) === owner
                                )
                        );

                    if (
                        index >= 0
                    ) {
                        studioQueue.splice(
                            index,
                            1
                        );
                    }

                    return sendJson(
                        res,
                        200,
                        {
                            ok: true,

                            requestId:
                                id
                        }
                    );
                } catch (e) {
                    return sendJson(
                        res,
                        400,
                        {
                            ok: false,

                            error:
                                e.message
                        }
                    );
                }
            }

            if (
                req.method !==
                'POST'
            ) {
                return sendJson(
                    res,
                    405,
                    {
                        ok: false,

                        error:
                            'POST istifadə edin.'
                    }
                );
            }

            if (
                url.pathname !==
                    '/gpt' &&
                url.pathname !==
                    '/gemini'
            ) {
                return sendJson(
                    res,
                    404,
                    {
                        ok: false,

                        error:
                            'Endpoint tapılmadı. /gpt və ya /gemini istifadə edin.'
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
                return sendJson(
                    res,
                    400,
                    {
                        ok: false,

                        reply:
                            'Sorğu oxunmadı.',

                        error:
                            e.message
                    }
                );
            }

            const provider =
                url.pathname ===
                    '/gemini'
                    ? 'gemini'
                    : 'gpt';

            const result =
                await processAI(
                    provider,
                    body
                );

            return sendJson(
                res,
                200,
                result
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
            ' Roblox AI Backend hazırdır'
        );

        console.log(
            ` Port: ${PORT}`
        );

        console.log(
            ` GPT: https://robloxaisystem.onrender.com/gpt`
        );

        console.log(
            ` Gemini: https://robloxaisystem.onrender.com/gemini`
        );

        console.log(
            ` GPT model: ${OPENROUTER_MODEL}`
        );

        console.log(
            ` Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
            ` OpenRouter key: ${
                OPENROUTER_API_KEY
                    ? 'OK'
                    : 'YOOX'
            }`
        );

        console.log(
            ` Gemini key: ${
                GEMINI_API_KEY
                    ? 'OK'
                    : 'YOOX'
            }`
        );

        console.log(
            '=============================================='
        );
    }
);

process.on(
    'SIGINT',
    () => {
        server.close(
            () =>
                process.exit(0)
        );
    }
);
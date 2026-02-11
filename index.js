/**
 * Spell Vision - SillyTavern Extension
 * Detects spell markers in AI replies, then either translates descriptions
 * via an OpenAI-compatible API or parses direct SVG JSON from the main AI.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const EXT_NAME = 'spell-vision';
const renderCache = new Map(); // cache: description -> sanitized renderData
const pendingRenderKeys = new Set();
let spellCounter = 0; // unique id for glow filters

const DEFAULT_SETTINGS = {
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-2.5-pro-preview-06-05',
    enabled: true,
    renderMode: 'translate',
};
const MAX_DOM_RETRIES = 8;
const DOM_RETRY_DELAY_MS = 200;
const TRANSLATE_TIMEOUT_MS = 30000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const INIT_GUARD_KEY = '__spellVisionInitialized';
const SV_PRIMARY_TAG = {
    open: '[[SV::SPELL::BEGIN::A9X5]]',
    close: '[[SV::SPELL::END::A9X5]]',
};
const SV_LEGACY_TAGS = [
    { open: '<spell>', close: '</spell>' },
    { open: '[spell]', close: '[/spell]' },
];

const ALLOWED_ELEMENT_TYPES = new Set(['circle', 'rect', 'ellipse', 'line', 'polygon', 'path', 'text']);
const ALLOWED_ATTRS = new Set([
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'width',
    'height',
    'points',
    'd',
    'text-anchor',
    'font-size',
    'font-family',
    'font-weight',
    'letter-spacing',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'transform',
    'opacity',
    'fill-opacity',
    'stroke-opacity',
]);
const ALLOWED_STYLE_PROPS = new Set([
    'fill',
    'stroke',
    'stroke-width',
    'opacity',
    'fill-opacity',
    'stroke-opacity',
    'mix-blend-mode',
    'font-size',
    'font-family',
    'font-weight',
    'letter-spacing',
]);
const ALLOWED_ANIMATIONS = new Set(['pulse', 'rotate', 'fade-in', 'float', 'flicker']);

// ─── Settings ────────────────────────────────────────────────────────

function loadSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    const s = extension_settings[EXT_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    if (s.renderMode !== 'translate' && s.renderMode !== 'main-json') {
        s.renderMode = 'translate';
    }
}

function getSettings() {
    return extension_settings[EXT_NAME];
}

// ─── Settings UI ─────────────────────────────────────────────────────

function createSettingsUI() {
    $('#spell-vision-settings').remove();

    const html = `
    <div id="spell-vision-settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔮 Spell Vision</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="sv-enabled">
                    <input type="checkbox" id="sv-enabled" />
                    启用 Spell Vision / Enable
                </label>

                <label for="sv-api-url">API URL</label>
                <input type="text" id="sv-api-url" class="text_pole"
                       placeholder="https://generativelanguage.googleapis.com/v1beta/openai" />
                <div class="spell-vision-note">OpenAI 兼容 API 地址 (base URL, 不含 /chat/completions)</div>

                <label for="sv-render-mode">渲染模式 / Render Mode</label>
                <select id="sv-render-mode" class="text_pole">
                    <option value="translate">额外模型翻译（推荐）</option>
                    <option value="main-json">主AI直出 SVG JSON（不二次请求）</option>
                </select>
                <div class="spell-vision-note">切换“主AI直出”后，将不调用下方 API URL/Model/API Key。</div>

                <label for="sv-model">Model</label>
                <input type="text" id="sv-model" class="text_pole"
                       placeholder="gemini-2.5-pro-preview-06-05" />
                <div class="spell-vision-note">推荐 gemini-2.5-pro-preview-06-05，也可用其他 OpenAI 兼容模型</div>

                <label for="sv-api-key">API Key</label>
                <input type="password" id="sv-api-key" class="text_pole"
                       placeholder="sk-... 或 Google AI API Key" />

                <hr />
                <div class="spell-vision-note" style="margin-top:8px;">
                    ⚡ 模式=翻译：标记内写视觉描述；模式=主AI直出：标记内写完整 SVG JSON。
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);

    // Bind values
    const s = getSettings();
    const updateModeUi = () => {
        const directMode = s.renderMode === 'main-json';
        $('#sv-api-url, #sv-model, #sv-api-key').prop('disabled', directMode);
        $('#sv-api-url, #sv-model, #sv-api-key').toggleClass('sv-input-disabled', directMode);
    };

    $('#sv-enabled').prop('checked', s.enabled).on('change', function () {
        s.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#sv-render-mode').val(s.renderMode).on('change', function () {
        const mode = $(this).val();
        s.renderMode = mode === 'main-json' ? 'main-json' : 'translate';
        saveSettingsDebounced();
        updateModeUi();
    });
    $('#sv-api-url').val(s.apiUrl).on('input', function () {
        s.apiUrl = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#sv-model').val(s.model).on('input', function () {
        s.model = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#sv-api-key').val(s.apiKey).on('input', function () {
        s.apiKey = $(this).val().trim();
        saveSettingsDebounced();
    });

    updateModeUi();
}

// ─── Spell Tag Parser ────────────────────────────────────────────────

/**
 * Extract spell description blocks from primary/legacy markers.
 * Returns array of { raw, description }.
 */
function extractSpellTags(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }

    const extractByTokens = (input, openToken, closeToken) => {
        const chunks = [];
        let cursor = 0;

        while (cursor < input.length) {
            const start = input.indexOf(openToken, cursor);
            if (start === -1) break;

            const contentStart = start + openToken.length;
            const end = input.indexOf(closeToken, contentStart);
            if (end === -1) break;

            const raw = input.slice(start, end + closeToken.length);
            const description = input.slice(contentStart, end).trim();
            if (description) {
                chunks.push({ raw, description });
            }

            cursor = end + closeToken.length;
        }

        return chunks;
    };

    const candidates = [
        SV_PRIMARY_TAG,
        ...SV_LEGACY_TAGS,
    ];
    const seen = new Set();
    const results = [];

    for (const tag of candidates) {
        const chunks = extractByTokens(text, tag.open, tag.close);
        for (const chunk of chunks) {
            const key = `${chunk.raw}\n${chunk.description}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push(chunk);
        }
    }

    // Case-insensitive compatibility for legacy tags.
    const legacyPatterns = [
        /<spell>([\s\S]*?)<\/spell>/gi,
        /\[spell\]([\s\S]*?)\[\/spell\]/gi,
    ];
    for (const pattern of legacyPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const description = (match[1] || '').trim();
            if (!description) continue;
            const raw = match[0];
            const key = `${raw}\n${description}`;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({ raw, description });
        }
    }

    return results;
}

// ─── Translation API Call ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a spell-to-SVG translator. The user gives you a natural language description of a magical spell visual effect. You MUST respond with ONLY a valid JSON object (no markdown, no code fences, no explanation).

JSON Schema:
{
  "name": "string (short spell name)",
  "width": number (SVG width, default 360),
  "height": number (SVG height, default 240),
  "background": "string (CSS color, optional)",
  "elements": [
    {
      "type": "circle" | "line" | "polygon" | "rect" | "ellipse" | "path" | "text",
      "attrs": { SVG attributes as key-value pairs, e.g. "cx","cy","r","x1","y1","x2","y2","points","d","x","y","width","height" },
      "style": { CSS style properties, e.g. "fill","stroke","stroke-width","opacity","fill-opacity" },
      "glow": true | false (apply glow filter),
      "glowStrength": "soft" | "strong",
      "animation": "pulse" | "rotate" | "fade-in" | "float" | "flicker" | null,
      "animationDuration": "string (CSS duration, e.g. '2s')",
      "content": "string (for text type only)"
    }
  ],
  "particles": {
    "enabled": true | false,
    "count": number (5-30),
    "color": "string (CSS color)",
    "size": number (2-8, px),
    "speed": number (1-5, seconds)
  }
}

Guidelines:
- Use vibrant magical colors (purples, blues, golds, cyans, greens)
- Always include at least one glowing element
- Use animations to make the spell feel alive
- Keep it visually impressive but not overly complex (5-15 elements)
- Coordinates should fit within the width/height you specify
- For polygon, use "points" attr like "100,10 40,198 190,78 10,78 160,198"
- For path, use standard SVG path "d" attribute
- Respond with raw JSON only, no wrapping`;

function toKebabCase(value) {
    return String(value).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function sanitizeStringValue(value, maxLen = 300) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text || text.length > maxLen) return null;
    const lower = text.toLowerCase();
    if (lower.includes('javascript:') || text.includes('<') || text.includes('>')) return null;
    return text;
}

function sanitizeAttrName(name) {
    const key = String(name).trim();
    if (!key) return null;
    const normalized = key.toLowerCase();
    if (normalized.startsWith('on')) return null;
    if (!ALLOWED_ATTRS.has(normalized)) return null;
    return normalized;
}

function sanitizeStyleName(name) {
    const key = toKebabCase(String(name).trim()).toLowerCase().replace(/^-+/, '');
    if (!ALLOWED_STYLE_PROPS.has(key)) return null;
    return key;
}

function parseDuration(value, fallback = '2s') {
    const text = sanitizeStringValue(value, 20);
    if (!text) return fallback;
    if (!/^\d+(\.\d+)?(ms|s)$/i.test(text)) return fallback;
    return text;
}

function sanitizeRenderData(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const width = Math.min(Math.max(Number(input.width) || 360, 120), 1024);
    const height = Math.min(Math.max(Number(input.height) || 240, 80), 768);

    const spell = {
        name: sanitizeStringValue(input.name, 80) || '',
        width,
        height,
        background: sanitizeStringValue(input.background, 40) || '',
        elements: [],
        particles: null,
    };

    const elements = Array.isArray(input.elements) ? input.elements.slice(0, 60) : [];
    for (const item of elements) {
        if (!item || typeof item !== 'object') continue;

        const type = String(item.type || '').trim();
        if (!ALLOWED_ELEMENT_TYPES.has(type)) continue;

        const element = {
            type,
            attrs: {},
            style: {},
            glow: !!item.glow,
            glowStrength: item.glowStrength === 'strong' ? 'strong' : 'soft',
            animation: null,
            animationDuration: '2s',
            content: '',
        };

        if (item.attrs && typeof item.attrs === 'object') {
            for (const [k, v] of Object.entries(item.attrs)) {
                const attrName = sanitizeAttrName(k);
                const attrValue = sanitizeStringValue(v);
                if (!attrName || !attrValue) continue;
                element.attrs[attrName] = attrValue;
            }
        }

        if (item.style && typeof item.style === 'object') {
            for (const [k, v] of Object.entries(item.style)) {
                const styleName = sanitizeStyleName(k);
                const styleValue = sanitizeStringValue(v);
                if (!styleName || !styleValue) continue;
                element.style[styleName] = styleValue;
            }
        }

        const animation = String(item.animation || '').trim();
        if (ALLOWED_ANIMATIONS.has(animation)) {
            element.animation = animation;
            element.animationDuration = parseDuration(item.animationDuration, '2s');
        }

        if (type === 'text') {
            element.content = sanitizeStringValue(item.content, 120) || '';
        }

        spell.elements.push(element);
    }

    if (spell.elements.length === 0) {
        spell.elements.push({
            type: 'circle',
            attrs: { cx: '180', cy: '120', r: '42' },
            style: { fill: '#66ccff', opacity: '0.75' },
            glow: true,
            glowStrength: 'soft',
            animation: 'pulse',
            animationDuration: '2s',
            content: '',
        });
    }

    const particles = input.particles && typeof input.particles === 'object' ? input.particles : null;
    if (particles) {
        spell.particles = {
            enabled: !!particles.enabled,
            count: Math.min(Math.max(Number(particles.count) || 10, 1), 40),
            color: sanitizeStringValue(particles.color, 40) || '#a855f7',
            size: Math.min(Math.max(Number(particles.size) || 4, 1), 12),
            speed: Math.min(Math.max(Number(particles.speed) || 3, 0.5), 8),
        };
    }

    return spell;
}

function extractContentFromResponse(data) {
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            })
            .join('\n');
    }

    return '';
}

function extractFirstJsonObject(text) {
    if (!text) return null;

    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
            }
            continue;
        }

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

async function translateSpell(description) {
    const normalizedDesc = description.trim();
    if (!normalizedDesc) {
        throw new Error('空法术描述，无法渲染');
    }

    // Check cache first
    if (renderCache.has(normalizedDesc)) {
        return renderCache.get(normalizedDesc);
    }

    const s = getSettings();
    const baseUrl = s.apiUrl.trim();
    if (!baseUrl) {
        throw new Error('请先在 Spell Vision 设置中填写 API URL');
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const body = {
        model: s.model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: normalizedDesc },
        ],
        temperature: 0.7,
        max_tokens: 2048,
    };

    const headers = {
        'Content-Type': 'application/json',
    };
    if (s.apiKey) {
        headers['Authorization'] = `Bearer ${s.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
    const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId));

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    let content = extractContentFromResponse(data);
    if (!content) {
        throw new Error('模型返回为空，无法解析渲染指令');
    }

    // Strip possible markdown code fences and surrounding text
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    // Try to extract first complete JSON object if there's extra text around it
    const jsonObject = extractFirstJsonObject(content);
    if (!jsonObject) {
        throw new Error(`模型返回不是合法 JSON: ${content.slice(0, 200)}`);
    }

    const parsed = JSON.parse(jsonObject);
    const result = sanitizeRenderData(parsed);

    // Cache the result
    renderCache.set(normalizedDesc, result);
    if (renderCache.size > 200) {
        const oldestKey = renderCache.keys().next().value;
        if (oldestKey) renderCache.delete(oldestKey);
    }

    return result;
}

function parseDirectSpellJson(description) {
    const content = String(description || '').trim();
    if (!content) {
        throw new Error('法术标记为空，未提供 SVG JSON');
    }

    const trimmed = content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    const jsonObject = extractFirstJsonObject(trimmed);
    if (!jsonObject) {
        throw new Error('主AI模式需要在标记内输出合法 JSON 对象');
    }

    let parsed;
    try {
        parsed = JSON.parse(jsonObject);
    } catch {
        throw new Error('主AI输出的 SVG JSON 解析失败');
    }

    return sanitizeRenderData(parsed);
}

// ─── SVG Renderer ────────────────────────────────────────────────────

function renderSpellSVG(spell) {
    const w = spell.width || 360;
    const h = spell.height || 240;
    const uid = spellCounter++;

    // Build SVG
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    const softId = `spellGlowSoft_${uid}`;
    const strongId = `spellGlowStrong_${uid}`;

    // Defs: glow filters (unique per spell instance)
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = `
        <filter id="${softId}" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="${strongId}" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="8" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>`;
    svg.appendChild(defs);

    // Background rect
    if (spell.background) {
        const bg = document.createElementNS(SVG_NS, 'rect');
        bg.setAttribute('width', w);
        bg.setAttribute('height', h);
        bg.setAttribute('fill', spell.background);
        svg.appendChild(bg);
    }

    // Elements
    const elements = spell.elements || [];
    for (const el of elements) {
        let node;
        if (el.type === 'text') {
            node = document.createElementNS(SVG_NS, 'text');
            node.textContent = el.content || '';
        } else {
            node = document.createElementNS(SVG_NS, el.type);
        }

        // Set SVG attributes
        if (el.attrs) {
            for (const [k, v] of Object.entries(el.attrs)) {
                node.setAttribute(k, v);
            }
        }

        // Set inline styles (handle both camelCase and kebab-case)
        if (el.style) {
            for (const [k, v] of Object.entries(el.style)) {
                node.style.setProperty(k, v);
            }
        }

        // Glow
        if (el.glow) {
            const filterId = el.glowStrength === 'strong' ? strongId : softId;
            node.setAttribute('filter', `url(#${filterId})`);
        }

        // Animation
        if (el.animation) {
            node.classList.add(`sv-anim-${el.animation}`);
            if (el.animationDuration) {
                node.style.setProperty('--sv-duration', el.animationDuration);
            }
        }

        svg.appendChild(node);
    }

    return svg;
}

function createParticles(spell, container) {
    const p = spell.particles;
    if (!p || !p.enabled) return;

    const count = Math.min(p.count || 10, 40);
    const color = p.color || '#a855f7';
    const size = p.size || 4;
    const speed = p.speed || 3;

    for (let i = 0; i < count; i++) {
        const dot = document.createElement('div');
        dot.classList.add('sv-particle');
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.background = color;
        dot.style.boxShadow = `0 0 ${size * 2}px ${color}`;
        dot.style.left = `${Math.random() * 90 + 5}%`;
        dot.style.bottom = `${Math.random() * 30}%`;
        dot.style.setProperty('--sv-particle-duration', `${speed + Math.random() * 2}s`);
        dot.style.animationDelay = `${Math.random() * speed}s`;
        container.appendChild(dot);
    }
}

// ─── Build visual container ──────────────────────────────────────────

function buildSpellVisual(spell) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('spell-vision-container');

    const svg = renderSpellSVG(spell);
    wrapper.appendChild(svg);

    // Particles overlay
    createParticles(spell, wrapper);

    // Label
    if (spell.name) {
        const label = document.createElement('div');
        label.classList.add('spell-vision-label');
        label.textContent = `✦ ${spell.name} ✦`;
        wrapper.appendChild(label);
    }

    return wrapper;
}

// ─── Message Handler ─────────────────────────────────────────────────

function normalizeMessageIndex(payload) {
    if (typeof payload === 'number' && Number.isInteger(payload)) return payload;
    if (typeof payload === 'string' && /^\d+$/.test(payload)) return Number(payload);
    if (!payload || typeof payload !== 'object') return null;

    const candidates = [payload.message_id, payload.mesid, payload.id, payload.messageIndex, payload.index];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return null;
}

function getRenderSignature(spells) {
    return spells.map((s) => s.description.trim()).filter(Boolean).join('\n---\n');
}

function hashText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
}

function buildRenderKey(context, messageIndex, signatureHash) {
    const chatId = context?.chatId ?? context?.groupId ?? 'default';
    return `${chatId}:${messageIndex}:${signatureHash}`;
}

async function renderSpellsForMessage(messageIndex, spells, options = {}) {
    const { showPlaceholder = false, showUiErrors = false } = options;
    const signature = getRenderSignature(spells);
    if (!signature) return;
    const signatureHash = hashText(signature);
    const s = getSettings();
    const directJsonMode = s.renderMode === 'main-json';

    const context = getContext();
    const msgEl = $(`.mes[mesid="${messageIndex}"]`);
    const mesText = msgEl.find('.mes_text');

    if (msgEl.length === 0 || mesText.length === 0) return;

    const renderKey = buildRenderKey(context, messageIndex, signatureHash);
    if (pendingRenderKeys.has(renderKey)) return;

    const alreadyRendered = msgEl.attr('data-sv-signature') === signatureHash
        && msgEl.find('.spell-vision-container, .spell-vision-error, .spell-vision-loading').length > 0;
    if (alreadyRendered) return;

    pendingRenderKeys.add(renderKey);
    msgEl.attr('data-sv-signature', signatureHash);
    mesText.find('.spell-vision-container, .spell-vision-error, .spell-vision-loading').remove();

    try {
        for (const spell of spells) {
            if (!spell.description) continue;

            let placeholder = null;
            if (showPlaceholder) {
                placeholder = $('<div class="spell-vision-container spell-vision-loading">⏳ 正在渲染法术效果...</div>');
                mesText.append(placeholder);
            }

            try {
                const renderData = directJsonMode
                    ? parseDirectSpellJson(spell.description)
                    : await translateSpell(spell.description);
                const visual = buildSpellVisual(renderData);
                if (placeholder) {
                    placeholder.replaceWith(visual);
                } else {
                    mesText.append(visual);
                }
                console.log(`[Spell Vision] Rendered: ${renderData.name || 'unnamed'}`);
            } catch (err) {
                if (placeholder) placeholder.remove();
                const message = err?.name === 'AbortError'
                    ? '请求超时，请检查网络或模型响应速度'
                    : (err?.message || '未知错误');

                if (showUiErrors) {
                    const errDiv = $('<div class="spell-vision-error"></div>');
                    errDiv.text(`⚠️ 法术渲染失败: ${message}`);
                    mesText.append(errDiv);
                }
                console.error('[Spell Vision] Render error:', err);
            }
        }
    } finally {
        pendingRenderKeys.delete(renderKey);
    }
}

async function onMessageReceived(payload, retry = 0) {
    const s = getSettings();
    if (!s.enabled) return;

    const messageIndex = normalizeMessageIndex(payload);
    if (messageIndex === null) return;

    const context = getContext();
    const msg = context.chat?.[messageIndex];
    if (!msg || msg.is_user) return;

    const spells = extractSpellTags(msg.mes);
    if (spells.length === 0) return;

    // Find the message element in DOM
    const msgEl = $(`.mes[mesid="${messageIndex}"]`);
    const mesText = msgEl.find('.mes_text');
    if (msgEl.length === 0 || mesText.length === 0) {
        if (retry < MAX_DOM_RETRIES) {
            setTimeout(() => onMessageReceived(payload, retry + 1), DOM_RETRY_DELAY_MS);
        }
        return;
    }

    await renderSpellsForMessage(messageIndex, spells, { showPlaceholder: true, showUiErrors: true });
}

// ─── Re-render on chat load (for history) ────────────────────────────

async function onChatChanged() {
    const s = getSettings();
    if (!s.enabled) return;

    // Small delay to let DOM render
    await new Promise(r => setTimeout(r, 500));

    const context = getContext();
    if (!context.chat) return;

    for (let i = 0; i < context.chat.length; i++) {
        const msg = context.chat[i];
        if (msg.is_user) continue;

        const spells = extractSpellTags(msg.mes);
        if (spells.length === 0) continue;

        await renderSpellsForMessage(i, spells, { showPlaceholder: false, showUiErrors: false });
    }
}

// ─── Init ────────────────────────────────────────────────────────────

jQuery(async () => {
    if (window[INIT_GUARD_KEY]) {
        console.warn('[Spell Vision] Duplicate init prevented.');
        return;
    }
    window[INIT_GUARD_KEY] = true;

    loadSettings();
    createSettingsUI();

    // Listen for new AI messages
    eventSource.on(event_types.MESSAGE_RECEIVED, (payload) => {
        onMessageReceived(payload);
    });

    // Re-render when chat changes (switching chats, loading history)
    eventSource.on(event_types.CHAT_CHANGED, () => {
        onChatChanged();
    });

    console.log('[Spell Vision] Extension loaded.');
});

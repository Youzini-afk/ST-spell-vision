# 🔮 Spell Vision - SillyTavern 法术可视化扩展

将法术描述自动转化为炫酷的 SVG 动画效果，直接嵌入聊天消息中。

![MVP Version](https://img.shields.io/badge/version-1.0.0-purple)

## ✨ 功能

- **自动检测** AI 回复中的 `<spell>` 标签
- **AI 翻译** 将法术描述发送给翻译模型，转换为渲染指令
- **SVG 渲染** 支持圆形、线条、多边形等基本图形
- **视觉效果** 发光、脉冲、旋转、淡入淡出、闪烁等动画
- **粒子效果** 漂浮的魔法粒子
- **设置面板** 可配置 API 地址、模型、密钥

## 📦 安装

### 方法一：直接复制

1. 将整个 `spell-vision` 文件夹复制到 SillyTavern 的扩展目录：
   ```
   SillyTavern/public/scripts/extensions/third-party/spell-vision/
   ```
2. 重启 SillyTavern
3. 在 **扩展 (Extensions)** 面板中确认 Spell Vision 已启用

### 方法二：通过 Git（推荐）

```bash
cd SillyTavern/public/scripts/extensions/third-party/
git clone <your-repo-url> spell-vision
```

## ⚙️ 配置

安装后，在 SillyTavern 右侧设置面板找到 **🔮 Spell Vision** 配置区：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| **Enable** | 启用/禁用扩展 | ✅ |
| **API URL** | OpenAI 兼容 API 地址 | `https://generativelanguage.googleapis.com/v1beta/openai` |
| **Model** | 翻译模型名称 | `gemini-2.5-pro-preview-06-05` |
| **API Key** | API 密钥（可选，取决于提供商） | (空) |

### 支持的 API 提供商

只要兼容 OpenAI `/chat/completions` 格式即可：

- **Google Gemini** (推荐): `https://generativelanguage.googleapis.com/v1beta/openai`
- **OpenAI**: `https://api.openai.com/v1`
- **OpenRouter**: `https://openrouter.ai/api/v1`
- **本地 LLM** (Ollama 等): `http://localhost:11434/v1`

## 📖 世界书设置

**这是关键步骤！** 你需要将世界书模板导入，AI 才会在施法时输出 `<spell>` 标签。

### 导入方法

1. 打开 SillyTavern 的 **世界书 (World Info / Lorebook)** 面板
2. 点击 **导入 (Import)** 按钮
3. 选择 `worldbook-template.json` 文件
4. 确认导入后，确保该条目已**启用**
5. 建议将此世界书设为**全局启用**

### 手动添加（替代方案）

如果你不想导入文件，可以手动创建世界书条目：

- **触发关键词**: `spell casting, magic spell, cast spell, casting, incantation`
- **次要关键词**: `magic, spell, mana, arcane`
- **内容**: 参考 `worldbook-template.json` 中的 `content` 字段
- **位置**: Author's Note (深度 4)
- **常驻**: ✅ 建议开启

## 🎯 工作原理

```
AI 输出带 <spell> 标签的消息
        ↓
Spell Vision 检测到 <spell> 标签
        ↓
提取法术描述，发送给翻译模型
        ↓
翻译模型返回 SVG 渲染指令 (JSON)
        ↓
前端渲染 SVG + CSS 动画 + 粒子效果
        ↓
嵌入聊天消息中显示
```

## 📝 Spell 标签格式

AI 在角色扮演时会这样输出：

```
*她举起法杖，开始吟唱古老的咒语...*

<spell>A swirling vortex of crimson and orange flames erupts from the caster's palm, spiraling outward in concentric rings. Golden sparks trail behind each ring, pulsing with arcane energy.</spell>

*一道灼热的火焰从法杖尖端喷射而出，直奔目标！*
```

扩展会将 `<spell>` 标签中的描述翻译为 SVG 渲染指令并显示。

## 🎨 渲染指令 JSON Schema

翻译模型返回的 JSON 格式如下：

```json
{
  "name": "Flame Vortex",
  "width": 360,
  "height": 240,
  "background": "#0a0520",
  "elements": [
    {
      "type": "circle",
      "attrs": { "cx": 180, "cy": 120, "r": 40 },
      "style": { "fill": "#ff6b35", "opacity": "0.8" },
      "glow": true,
      "glowStrength": "strong",
      "animation": "pulse",
      "animationDuration": "2s"
    }
  ],
  "particles": {
    "enabled": true,
    "count": 15,
    "color": "#ff9f43",
    "size": 4,
    "speed": 3
  }
}
```

### 支持的图形类型
`circle` | `rect` | `ellipse` | `line` | `polygon` | `path` | `text`

### 支持的动画
`pulse` | `rotate` | `fade-in` | `float` | `flicker`

## 🐛 故障排除

| 问题 | 解决方案 |
|------|----------|
| 没有渲染效果 | 检查扩展是否启用、API URL/Model 是否正确；仅在提供商要求时填写 API Key |
| API 报错 | 检查 API URL 是否正确，密钥是否有效 |
| AI 不输出 `<spell>` 标签 | 确认世界书已导入并启用 |
| 效果没出现 | 打开浏览器控制台 (F12) 查看 `[Spell Vision]` 日志 |

## 📄 License

MIT

---

*Made with ✨ magic*

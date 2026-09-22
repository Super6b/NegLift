# NegLift

**专业胶卷负片去色罩调色软件**  
Desktop film-negative color correction & grading

[English](#english) · 简体中文

---

把扫描/翻拍的负片变成可用的正片颜色，再在统一界面里完成风格化调色。面向胶卷扫描、翻拍灯箱、底片数字化流程。

## 功能概览

| 模块 | 说明 |
|------|------|
| **有效区域** | 自动识别片夹/黑边，或手动框选；旋转、翻转、裁切 |
| **标准色彩** | 通道对齐去色罩（自动检测黑/白场）、除尘、降噪 |
| **风格调色** | 曝光、曲线（端点可拖）、HSL、色彩分级、胶片预设 |
| **胶片条** | 多图导入、逐张独立编辑、勾选后批量导出 |
| **除尘** | 笔触涂抹灰尘/浮毛；自动识别后可删改 |
| **预设** | 保存当前流程，批量套用到整卷胶片 |
| **批量处理** | 模板式简易批处理（可选） |
| **保真模式预览** | 针对已记录的彩色负片相机翻拍配置，导出 16 位 TIFF 与谱系记录；缺少验证证据时明确标记为未验证 |

修复派生文件需从已验证保真 TIFF 继续编辑；旧版未记录输出文件校验值的 TIFF 需从原始图像重新导出，才能建立可核对的父子关系。

## 安装与运行

### 使用已打包版本

从 [Releases](../../releases) 下载：

- **绿色版**：`NegLift-x.y.z-win-portable.exe`，双击即用  
- **安装版**：`NegLift-x.y.z-win-x64.exe`

### 开发运行

```bash
npm install
npm run dev
```

### 构建

```bash
npm run typecheck
npm test
npm run dist:win    # Windows portable + 安装包
```

> 打包时若项目路径含空格，已配置 `npmRebuild: false`，使用当前环境已验证的 native 模块（LibRaw / sharp）。请在与运行环境相近的机器上构建。

## 推荐工作流

1. **打开图片**（可多选）→ 底部胶片条出现缩略图  
2. **① 有效区域**：自动识别片夹，或手动框选  
3. **② 标准色彩**：自动检测去色罩；必要时除尘、降噪  
4. **③ 风格调色**：曲线、HSL、分级；或套用预设  
5. **导出**：单张，或胶片条勾选后批量导出  

## 技术架构

- **Electron + React + TypeScript + Zustand**
- **WebGL2** 实时预览（CPU 回退）；LibRaw 解码 RAW
- 共享管线保证预览 / 导出 / 批量一致
- 去色罩默认 **通道对齐**（base 片基反相已停用）

```
src/
  main/       解码 · IPC · 导出 · 批量
  preload/    contextBridge API
  renderer/   界面 · 状态 · GPU/CPU 预览
  shared/     类型 · 管线算法
```

## 支持格式

| 输入 | 输出 |
|------|------|
| RAW：CR2 / CR3 / NEF / NRW / ARW / RAF / RW2 / ORF / DNG 等 | JPEG / PNG / TIFF(8·16) / BMP |
| 常见图像：JPEG / PNG / TIFF / WebP / BMP 等 | |

## 文档

- [`docs/denoise.md`](docs/denoise.md) — 降噪说明  
- [`docs/dust-repair-and-models.md`](docs/dust-repair-and-models.md) — 除尘与可选 ONNX 模型  
- [`docs/camera-profile.example.json`](docs/camera-profile.example.json) — 机型配置示例  
- [`models/README.md`](models/README.md) — 内置修补模型说明  
- [`docs/fidelity-preview-quality-report-template.md`](docs/fidelity-preview-quality-report-template.md) — 保真模式预览质量报告模板

## License

MIT

---

## English

**NegLift** is a desktop app for developing scanned or copy-shot film negatives: remove the orange mask, recover natural color, then grade with curves, HSL, and color tools.

### Highlights

- Guided 3-step workflow: **frame → color → look**
- Multi-image filmstrip with per-frame edits and batch export
- Auto holder/black-border detection and dust repair
- Film-inspired presets you can apply across a roll
- Real-time WebGL preview; LibRaw for RAW decode

### Quick start

```bash
npm install
npm run dev
```

Or download the portable / installer builds from Releases.

### Stack

Electron · React · TypeScript · Zustand · WebGL2 · LibRaw · sharp

License: MIT

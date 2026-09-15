# 内置除尘模型（LaMa）

推荐使用 **LaMa** 大面积修复模型的 ONNX 导出，对灰尘、浮毛、长划痕效果明显好于经典扩散。

## 如何安装（选其一）

1. **项目内置（推荐）**  
   将模型放到本目录，文件名必须为：

   ```
   models/lama.onnx
   ```

2. **用户目录**  
   放到应用数据目录下的 `neglift-models/lama.onnx`  
   （界面「模型目录」按钮可打开该文件夹）

放置后重启 NegLift，除尘面板应显示「内置 / 自定义 · lama.onnx」。

## 从哪里获取

任选社区提供的 **LaMa ONNX 导出**（体积通常 200MB+）：

- [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting) 中的 `big-lama.onnx` / `lama_fp32.onnx`
- Hugging Face 上搜索 `lama onnx inpainting`

> 本机若无法访问 GitHub/HuggingFace，请在其它网络下载后再拷贝到 `models/`。

## 格式要求

- 输入：`image` + `mask`（float32，0..1；NCHW 或 NHWC 均可）
- 输出：补全后的 image
- 兼容常见 LaMa 导出 I/O 命名

## 打包

`electron-builder.yml` 已包含 `models/**/*`，打包时会把 `models/lama.onnx` 一并装入安装包。

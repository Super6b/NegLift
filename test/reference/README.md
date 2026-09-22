# 保真模式公开参考测试集

此目录只接受具有明确再分发许可的真实参考资产；不得提交用户底片、用户原始图像或无法证明许可的样本。测量记录仅用于声明“用户确认的验证”，不是使用或预览发布门槛（见 ADR-0002）。

本地 RAW 冒烟测试使用 `raw-smoke.ts`：在仓库根目录执行以下命令，结果写入忽略的 `out/reference-smoke/run-*`，不提交源文件或导出文件。

```sh
node node_modules/esbuild/bin/esbuild test/reference/raw-smoke.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --external:lightdrift-libraw --external:sharp --external:electron --outfile=out/raw-smoke.cjs
node out/raw-smoke.cjs DSC_2054.NEF DSC_2055.NEF
```

这两张本地 Nikon Z 6_2 负片 RAW 均可完整解码为 6064×4040 的十六位像素，自动反相后导出同尺寸十六位 TIFF，试用状态正确保留 `_unverified` 后缀和校验值回链。样片可检验流程与视觉起点，但不包含可量化的色彩目标或密度参考，不能用于声称色彩准确或跨帧一致性通过。当前 TIFF 回读未发现嵌入的 ICC profile，这一输出缺口必须单独修复，不能据此宣称完整色彩管理。

FADGI 官方提供 35 毫米、120 和 4×5 负片目标及参考数据，可作为以后自行为可选验证寻找资料的起点：<https://stage.digitizationguidelines.gov/guidelines/digitize-OpenDice.html>。该页面未在下载处声明可再分发许可，因此本仓库不复制其目标或参考数据。

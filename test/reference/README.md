# 保真模式公开参考测试集

此目录只接受具有明确再分发许可的真实参考资产；不得提交用户底片、用户原始图像或无法证明许可的样本。测量记录仅用于声明“用户确认的验证”，不是使用或预览发布门槛（见 ADR-0002）。

本地 RAW 冒烟测试使用 `raw-smoke.ts`：在仓库根目录执行以下命令，结果写入忽略的 `out/reference-smoke/run-*`，不提交源文件或导出文件。

```sh
node node_modules/esbuild/bin/esbuild test/reference/raw-smoke.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --external:lightdrift-libraw --external:sharp --external:electron --outfile=out/raw-smoke.cjs
node out/raw-smoke.cjs DSC_2054.NEF DSC_2055.NEF
```

这两张本地 Nikon Z 6_2 负片 RAW 均可完整解码为 6064×4040 的十六位像素，自动反相后导出同尺寸十六位 TIFF，试用状态正确保留 `_unverified` 后缀和校验值回链。TIFF 回读现可找到嵌入的 sRGB ICC；桌面应用的双图导入、预览和单张未验证导出也已走通。样片可检验流程与视觉起点，但不包含可量化的色彩目标或密度参考，不能用于声称色彩准确或跨帧一致性通过。

FADGI 官方提供 35 毫米、120 和 4×5 负片目标及参考数据，可作为以后自行为可选验证寻找资料的起点：<https://stage.digitizationguidelines.gov/guidelines/digitize-OpenDice.html>。该页面未在下载处声明可再分发许可，因此本仓库不复制其目标或参考数据。

raw.pixls.us 提供按单文件标记许可的相机 RAW 样片：<https://raw.pixls.us/>。它可用于以后补充解码器回归，但不能将普通相机样片当作负片验收数据；逐文件核对许可和底片内容后再引用或分发。

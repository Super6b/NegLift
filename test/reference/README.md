# 参考资料与本地 RAW 测试

此目录只接受具有明确再分发许可的真实参考资产；不得提交用户底片、用户原始图像或无法证明许可的样本。测量记录仅用于声明“用户确认的验证”，不是使用或预览发布门槛（见 ADR-0002）。

本地 RAW 冒烟测试使用 `raw-smoke.ts`：在仓库根目录执行以下命令，结果写入忽略的 `out/reference-smoke/run-*`，不提交源文件或导出文件。

```sh
node node_modules/esbuild/bin/esbuild test/reference/raw-smoke.ts --bundle --platform=node --format=cjs --target=node20 --alias:@shared=./src/shared --external:lightdrift-libraw --external:sharp --external:electron --outfile=out/raw-smoke.cjs
node out/raw-smoke.cjs DSC_2054.NEF DSC_2055.NEF
```

这两张本地 Nikon Z 6_2 负片 RAW 均可完整解码为 6064×4040 的十六位像素，自动反相后导出同尺寸十六位 TIFF，试用状态正确保留 `_unverified` 后缀和校验值回链。TIFF 回读现可找到嵌入的 sRGB ICC；桌面应用的双图导入、预览和单张未验证导出也已走通。样片可检验流程与视觉起点，但不包含可量化的色彩目标或密度参考，不能用于声称色彩准确或跨帧一致性通过。

公开资料核对（不提交任何外部原片）：

| 资料 | 来源与许可 | 校验值 | 可用于 |
| --- | --- | --- | --- |
| Nikon Z 6_2，12-bit lossless NEF，30,709,026 字节 | [raw.pixls.us 元数据目录](https://raw.pixls.us/json/getrepository.php?set=all) 的文件 ID `4163` 标注 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)；[样本文件](https://raw.pixls.us/getfile.php/4163/nice/Nikon%20-%20Z%206_2%20-%2012bit%2012bit%20compressed%20(Lossless)%20(3:2).NEF) | SHA-256 `04ad59c3b97609e72a54ad277ab433444b12392b032207ca7244571f60ab2514`（下载后复核与目录一致） | 已本地完整解码为 6064×4040、16 位且未回退；仅证明 Nikon RAW 解码兼容性，不可当负片或测量目标 |
| FADGI 35 mm / 120 / 4×5 负片目标和参考数据 | [官方页面](https://www.digitizationguidelines.gov/guidelines/digitize-OpenDice.html)；下载处没有明确再分发许可 | 未下载，故无本地 SHA-256 | 可选采集验收资料线索；不复制到本仓库，不充当相机 RAW 回归集 |

只有取得具体资产明确的再分发许可且适用于该测试时，才可能加入仓库；公开解码样片不能代替底片或校准数据。

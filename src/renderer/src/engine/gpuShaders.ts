/**
 * GPU 预览渲染的 GLSL 着色器。
 *
 * 与 CPU 路径（`@shared/pipeline`）严格对齐：
 *   1. 按几何变换（有效区域 → 旋转/翻转 → 裁切）反查源坐标，双线性采样线性 RGB
 *   2. 逐通道查色调链 LUT（由 `bakeChannelLuts` 在 CPU 端烘焙，包含去色罩/
 *      白平衡/曝光/sRGB 编码/阴影高光/黑白场/对比度/曲线）
 *   3. 显示域跨通道步骤：饱和度与自然饱和度、HSL 色彩分离、色彩分级
 */

export const QUAD_VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  // WebGL 绘图缓冲原点在左下，翻转 v 轴使第 0 行对应画面顶部
  vUV = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const PREVIEW_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 vUV;

/** 线性 RGB16 源图（交错，0..65535）：按缩小倍率选定的金字塔层级 */
uniform usampler2D uSrc;
/** 色调链查找表：宽 4097、高 3，行号即通道（0=R,1=G,2=B） */
uniform sampler2D uLut;

uniform vec2 uSrcSize;
/** 旋转后画布尺寸的一半 */
uniform vec2 uTransHalf;
/** (cos, sin) 旋转量 */
uniform vec2 uRot;
/** 有效区域原点与半尺寸（对应层级的像素坐标） */
uniform vec2 uAreaOrigin;
uniform vec2 uAreaHalf;
/** 输出区域（裁切后）在旋转画布中的原点与尺寸（对应层级） */
uniform vec2 uRegionOrigin;
uniform vec2 uRegionSize;
/** 翻转符号：1 = 不翻转，-1 = 翻转 */
uniform vec2 uFlipSign;

uniform float uSatAmount;
uniform float uVibAmount;
uniform int uSatActive;

uniform int uHslActive;
uniform float uHueShift[8];
uniform float uSatAdj[8];
uniform float uLumAdj[8];

uniform int uGradeActive;
uniform vec3 uGradeS;
uniform vec3 uGradeM;
uniform vec3 uGradeH;
uniform float uGradePivot;
uniform float uGradeGamma;

/** 除尘：线段存纹理，无 uniform 低段数上限；uRepairSegCount=段数 */
uniform int uRepairSegCount;
uniform sampler2D uRepairTex;
/** 纹理宽 = max(2, 2*segCount) */
uniform vec2 uRepairTexSize;

out vec4 fragColor;

const float LUT_SIZE = 4096.0;
const float BAND_HALF = 60.0;
const float BAND_CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 285.0, 320.0);

/** 与 CPU 端 lookup16 一致：0..1 输入，线性插值（越界直接取末端） */
float lutLookup(int ch, float v) {
  float p = clamp(v, 0.0, 1.0) * LUT_SIZE;
  int i = int(floor(p));
  float f = p - float(i);
  float a = texelFetch(uLut, ivec2(i, ch), 0).r;
  float b = texelFetch(uLut, ivec2(min(i + 1, 4096), ch), 0).r;
  return mix(a, b, f);
}

vec3 fetchTexel(usampler2D tex, ivec2 c) {
  return vec3(texelFetch(tex, c, 0).rgb) / 65535.0;
}

/** 线性光域双线性采样；越界像素权重归零，与 CPU 版行为一致 */
vec3 sampleSource(usampler2D tex, vec2 p, vec2 size) {
  vec2 pp = p - 0.5;
  vec2 base = floor(pp);
  vec2 f = pp - base;
  ivec2 i0 = ivec2(base);
  ivec2 i1 = i0 + 1;
  ivec2 hi = ivec2(size) - 1;

  vec3 c00 = vec3(0.0);
  vec3 c10 = vec3(0.0);
  vec3 c01 = vec3(0.0);
  vec3 c11 = vec3(0.0);
  if (all(greaterThanEqual(i0, ivec2(0))) && all(lessThanEqual(i0, hi))) c00 = fetchTexel(tex, i0);
  if (all(greaterThanEqual(ivec2(i1.x, i0.y), ivec2(0))) && all(lessThanEqual(ivec2(i1.x, i0.y), hi)))
    c10 = fetchTexel(tex, ivec2(i1.x, i0.y));
  if (all(greaterThanEqual(ivec2(i0.x, i1.y), ivec2(0))) && all(lessThanEqual(ivec2(i0.x, i1.y), hi)))
    c01 = fetchTexel(tex, ivec2(i0.x, i1.y));
  if (all(greaterThanEqual(i1, ivec2(0))) && all(lessThanEqual(i1, hi))) c11 = fetchTexel(tex, i1);

  float w00 = (1.0 - f.x) * (1.0 - f.y);
  float w10 = f.x * (1.0 - f.y);
  float w01 = (1.0 - f.x) * f.y;
  float w11 = f.x * f.y;
  return c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;
}

/** 由输出坐标反查某一层的源坐标并采样 */
vec3 sceneSample(
  vec2 uv,
  usampler2D tex,
  vec2 srcSize,
  vec2 transHalf,
  vec2 areaOrigin,
  vec2 areaHalf,
  vec2 regionOrigin,
  vec2 regionSize
) {
  vec2 tx = regionOrigin + uv * regionSize;
  vec2 d = tx - transHalf;
  vec2 l = vec2(uRot.x * d.x + uRot.y * d.y + areaHalf.x, -uRot.y * d.x + uRot.x * d.y + areaHalf.y);
  if (uFlipSign.x < 0.0) l.x = 2.0 * areaHalf.x - l.x;
  if (uFlipSign.y < 0.0) l.y = 2.0 * areaHalf.y - l.y;
  return sampleSource(tex, areaOrigin + l, srcSize);
}

vec4 rgbToHsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d < 1e-6) return vec4(0.0, 0.0, l, 0.0);
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = ((c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0)) * 60.0;
  else if (mx == c.g) h = ((c.b - c.r) / d + 2.0) * 60.0;
  else h = ((c.r - c.g) / d + 4.0) * 60.0;
  return vec4(h, s, l, 1.0);
}

float hueToRgb(float p, float q, float t) {
  float tt = t;
  if (tt < 0.0) tt += 1.0;
  if (tt > 1.0) tt -= 1.0;
  if (tt < 1.0 / 6.0) return p + (q - p) * 6.0 * tt;
  if (tt < 0.5) return q;
  if (tt < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - tt) * 6.0;
  return p;
}

vec3 hslToRgb(float h, float s, float l) {
  if (s < 1e-6) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float hn = mod(mod(h, 360.0) + 360.0, 360.0) / 360.0;
  return vec3(hueToRgb(p, q, hn + 1.0 / 3.0), hueToRgb(p, q, hn), hueToRgb(p, q, hn - 1.0 / 3.0));
}

vec3 applyHsl(vec3 c) {
  vec4 hsl = rgbToHsl(c);
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;

  float weights[8];
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    float d = mod(abs(h - BAND_CENTERS[i]), 360.0);
    if (d > 180.0) d = 360.0 - d;
    float w = d >= BAND_HALF ? 0.0 : 1.0 - d / BAND_HALF;
    weights[i] = w;
    total += w;
  }
  if (total < 1e-6) return c;

  float hueShift = 0.0;
  float satAdj = 0.0;
  float lumAdj = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = weights[i];
    if (w == 0.0) continue;
    hueShift += w * uHueShift[i];
    satAdj += w * uSatAdj[i];
    lumAdj += w * uLumAdj[i];
  }
  hueShift /= total;
  satAdj /= total;
  lumAdj /= total;

  float nh = h + hueShift;
  s = clamp(s * (1.0 + satAdj), 0.0, 1.0);
  l = clamp(lumAdj >= 0.0 ? l + (1.0 - l) * lumAdj : l * (1.0 + lumAdj), 0.0, 1.0);
  return hslToRgb(nh, s, l);
}

vec3 applyGrading(vec3 c) {
  float lum = clamp(dot(vec3(0.2126, 0.7152, 0.0722), c), 0.0, 1.0);
  float p = uGradePivot;
  float ws;
  float wh;
  float wm;
  if (lum < p) {
    ws = 1.0 - lum / p;
    wh = 0.0;
    wm = 1.0 - ws;
  } else {
    wh = (lum - p) / (1.0 - p);
    ws = 0.0;
    wm = 1.0 - wh;
  }
  ws = pow(ws, uGradeGamma);
  wh = pow(wh, uGradeGamma);
  wm = pow(wm, uGradeGamma);
  return clamp(c + uGradeS * ws + uGradeM * wm + uGradeH * wh, 0.0, 1.0);
}

/** 按输出 UV 完整走色调链，供除尘邻域取样 */
vec3 toneAt(vec2 uv) {
  vec3 lin = sceneSample(
    uv, uSrc, uSrcSize, uTransHalf, uAreaOrigin, uAreaHalf, uRegionOrigin, uRegionSize
  );
  vec3 c = vec3(lutLookup(0, lin.r), lutLookup(1, lin.g), lutLookup(2, lin.b));
  if (uSatActive == 1) {
    float lum = dot(vec3(0.2126, 0.7152, 0.0722), c);
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx <= 1e-6 ? 0.0 : (mx - mn) / mx;
    float f = 1.0 + uSatAmount + uVibAmount * (1.0 - sat) * 0.8;
    c = vec3(lum) + (c - vec3(lum)) * f;
  }
  if (uHslActive == 1) c = applyHsl(c);
  if (uGradeActive == 1) c = applyGrading(c);
  return clamp(c, 0.0, 1.0);
}

/**
 * 除尘笔触（预览）：线段存在 uRepairTex 中（每段 2 个 texel）。
 * 独立处理每段到折线的最小距离，只替换灰尘像素；无 64 段硬上限。
 */
vec3 applyRepairPass(vec3 c, vec2 uv) {
  if (uRepairSegCount <= 0) return c;
  float aspect = uRegionSize.x / max(uRegionSize.y, 1.0);
  float invAspect = 1.0 / max(aspect, 1e-6);
  float texW = max(uRepairTexSize.x, 2.0);

  float bestDist = 1e9;
  vec2 bestClosest = vec2(0.0);
  float bestR = 0.0;
  float bestS = 0.0;

  int maxSeg = uRepairSegCount;
  for (int s = 0; s < 1024; s++) {
    if (s >= maxSeg) break;
    float col0 = float(s * 2) + 0.5;
    float col1 = float(s * 2 + 1) + 0.5;
    vec4 seg = texture(uRepairTex, vec2(col0 / texW, 0.5));
    vec4 meta = texture(uRepairTex, vec2(col1 / texW, 0.5));
    float holeR = max(meta.x * 1.35, 0.0004);
    float strength = clamp(meta.y, 0.0, 1.0);
    if (strength <= 0.0 || holeR <= 0.0) continue;

    vec2 pa = vec2((uv.x - seg.x) * aspect, uv.y - seg.y);
    vec2 ba = vec2((seg.z - seg.x) * aspect, seg.w - seg.y);
    float ab2 = max(dot(ba, ba), 1e-12);
    float t = clamp(dot(pa, ba) / ab2, 0.0, 1.0);
    vec2 closest = vec2(seg.x + (seg.z - seg.x) * t, seg.y + (seg.w - seg.y) * t);
    float dist = length(vec2((uv.x - closest.x) * aspect, uv.y - closest.y));
    if (dist < bestDist) {
      bestDist = dist;
      bestClosest = closest;
      bestR = holeR;
      bestS = strength;
    }
  }

  if (bestDist > bestR || bestS <= 0.0) return c;

  vec3 bg = vec3(0.0);
  float outer = bestR * 1.85;
  for (int k = 0; k < 12; k++) {
    float ang = float(k) * 0.5235987756;
    vec2 o = vec2(cos(ang) * invAspect, sin(ang)) * outer;
    bg += toneAt(clamp(bestClosest + o, vec2(0.001), vec2(0.999)));
  }
  bg /= 12.0;

  float diff = length(c - bg);
  float thr = 0.045 + 0.18 * dot(bg, vec3(0.299, 0.587, 0.114));
  // 阈值略降：盖住半透明灰尘边，减少白圈
  if (diff > thr * 0.75) {
    float w = clamp((diff - thr * 0.75) / (thr * 0.55 + 1e-5), 0.0, 1.0) * bestS;
    c = mix(c, bg, w);
  }
  return c;
}

void main() {
  vec3 lin = sceneSample(
    vUV, uSrc, uSrcSize, uTransHalf, uAreaOrigin, uAreaHalf, uRegionOrigin, uRegionSize
  );
  vec3 c = vec3(lutLookup(0, lin.r), lutLookup(1, lin.g), lutLookup(2, lin.b));

  if (uSatActive == 1) {
    float lum = dot(vec3(0.2126, 0.7152, 0.0722), c);
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx <= 1e-6 ? 0.0 : (mx - mn) / mx;
    float f = 1.0 + uSatAmount + uVibAmount * (1.0 - sat) * 0.8;
    c = vec3(lum) + (c - vec3(lum)) * f;
  }
  if (uHslActive == 1) c = applyHsl(c);
  if (uGradeActive == 1) c = applyGrading(c);
  if (uRepairSegCount > 0) c = applyRepairPass(c, vUV);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

/**
 * 源图降采样 Pass：把上一级纹理做 2×2 盒平均，生成 mip 金字塔的下一级。
 *
 * 缩小预览时必须做面积平均，否则双线性只取 4 个源像素，
 * 噪声几乎不会被平均掉，画面会显得很噪。
 *
 * 必须用 gl_FragCoord 取目标 texel，不能用显示用的 vUV：
 * 顶点着色器为屏幕显示做了 v 翻转，写入 FBO 时会把每一级金字塔上下颠倒。
 * 结果是放大（level 0）方向正确、缩小（level ≥ 1）整幅上下翻转，表现为「换缩放就颠倒」。
 * gl_FragCoord.y=0 对应纹理第 0 行，与 texImage2D 上传的第 0 行（画面顶部）一致。
 */
export const DOWNSAMPLE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 vUV;

uniform usampler2D uSrc;
uniform ivec2 uSrcSize;
uniform ivec2 uDstSize;

out uvec4 fragColor;

void main() {
  // FBO 纹理行 0 = gl_FragCoord.y ∈ [0,1) = 源图第 0 行（画面顶部）
  ivec2 d = min(ivec2(gl_FragCoord.xy), uDstSize - 1);
  ivec2 base = d * 2;
  uvec3 sum = uvec3(0u);
  uint n = 0u;
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      ivec2 s = base + ivec2(dx, dy);
      if (s.x < uSrcSize.x && s.y < uSrcSize.y) {
        sum += texelFetch(uSrc, s, 0).rgb;
        n += 1u;
      }
    }
  }
  uint safe = max(n, 1u);
  fragColor = uvec4((sum + uvec3(safe / 2u)) / safe, 1u);
}
`

/**
 * 降噪 Pass（在色调链 Pass 之后）。
 *
 * 与 CPU 端 `denoiseDisplay` 采用同一套参数与思路：
 * - 色彩噪点：读取上一 Pass 结果的 mipmap **level 3**（8×8 盒平均，即 1/8 分辨率），
 *   在其上做 3×3 亮度引导滤波，再把结果混回色度通道。亮度通道完全不参与替换，
 *   因此色斑被抹掉而亮度细节全部保留。
 * - 亮度噪点：在 level 0 上做 3×3 亮度引导滤波，只改亮度、保留原色度。
 */
export const DENOISE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUV;

/** 色调链渲染结果，已生成 mipmap */
uniform sampler2D uScene;
/** 场景纹理尺寸（level 0） */
uniform vec2 uSceneSize;
uniform float uColorAmount;
uniform float uLumaAmount;
uniform float uChromaSigma;
uniform float uLumaSigma;
uniform float uWMin;

out vec4 fragColor;

const vec3 YW = vec3(0.2126, 0.7152, 0.0722);
/** 由 Y / Cb / Cr 还原 G：G = Y - 0.29726·Cr - 0.10095·Cb */
const float G_CB = -0.10095;
const float G_CR = -0.29726;
/** 色度滤波在 mip level 3（1/8 分辨率）上的采样间隔，等效全分辨率约 ±16px */
const float CHROMA_STEP = 2.0;
/** 色度滤波使用的 mip 级别：level 3 即 8×8 盒平均，与 CPU 端 1/8 工作平面一致 */
const float CHROMA_LOD = 3.0;

float luma(vec3 c) {
  return dot(c, YW);
}

/** 紧支撑二次核：跨边缘的邻居被压到下限，避免色晕 */
float guidedWeight(float delta, float sigma) {
  float t = delta / sigma;
  return max(uWMin, 1.0 - t * t);
}

void main() {
  // 上一 Pass 写入的是帧缓冲纹理（原点在左下），而 vUV 是自上而下的画面坐标，
  // 因此采样场景纹理时必须把 v 翻转回来，否则整幅画面会上下颠倒。
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);

  vec3 c0 = texture(uScene, uv).rgb;
  float y0 = luma(c0);

  float cb = c0.b - y0;
  float cr = c0.r - y0;

  if (uColorAmount > 0.0) {
    vec2 texelL = 1.0 / max(vec2(1.0), floor(uSceneSize * 0.125));
    float wSum = 0.0;
    float cbSum = 0.0;
    float crSum = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 suv = uv + vec2(float(dx), float(dy)) * texelL * CHROMA_STEP;
        vec3 cs = textureLod(uScene, suv, CHROMA_LOD).rgb;
        float ys = luma(cs);
        float w = guidedWeight(abs(ys - y0), uChromaSigma);
        wSum += w;
        cbSum += w * (cs.b - ys);
        crSum += w * (cs.r - ys);
      }
    }
    cb = mix(cb, cbSum / wSum, uColorAmount);
    cr = mix(cr, crSum / wSum, uColorAmount);
  }

  if (uLumaAmount > 0.0) {
    vec2 texel0 = 1.0 / max(vec2(1.0), uSceneSize);
    float wSum = 0.0;
    float ySum = 0.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        vec2 suv = uv + vec2(float(dx), float(dy)) * texel0;
        float ys = luma(textureLod(uScene, suv, 0.0).rgb);
        float w = guidedWeight(abs(ys - y0), uLumaSigma);
        wSum += w;
        ySum += w * ys;
      }
    }
    y0 = mix(y0, ySum / wSum, uLumaAmount);
  }

  vec3 rgb = vec3(y0 + cr, y0 + G_CB * cb + G_CR * cr, y0 + cb);
  fragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`

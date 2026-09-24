# 纯 Python PNG 解码 → 粗粒度 ASCII 可视化（不装任何第三方库）
# 用途：判断一张截图里各元素的空间位置/分组，而不是靠肉眼猜
import sys, zlib, struct

path = sys.argv[1]
data = open(path, 'rb').read()
assert data[:8] == b'\x89PNG\r\n\x1a\n'

pos = 8
idat = b''
w = h = bitdepth = colortype = None
while pos < len(data):
    ln = struct.unpack('>I', data[pos:pos+4])[0]
    typ = data[pos+4:pos+8]
    chunk = data[pos+8:pos+8+ln]
    if typ == b'IHDR':
        w, h, bitdepth, colortype = struct.unpack('>IIBB', chunk[:10])
    elif typ == b'IDAT':
        idat += chunk
    elif typ == b'IEND':
        break
    pos += 12 + ln

print(f'size={w}x{h} bitdepth={bitdepth} colortype={colortype}')

channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colortype]
raw = zlib.decompress(idat)
bpp = channels * (bitdepth // 8)
stride = w * bpp

rows = []
prev = bytearray(stride)
i = 0
for y in range(h):
    ft = raw[i]; i += 1
    line = bytearray(raw[i:i+stride]); i += stride
    if ft == 1:
        for x in range(bpp, stride):
            line[x] = (line[x] + line[x-bpp]) & 0xFF
    elif ft == 2:
        for x in range(stride):
            line[x] = (line[x] + prev[x]) & 0xFF
    elif ft == 3:
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0
            line[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xFF
    elif ft == 4:
        for x in range(stride):
            a = line[x-bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x-bpp] if x >= bpp else 0
            p = a + b - c
            pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[x] = (line[x] + pr) & 0xFF
    prev = line
    rows.append(line)

def px(x, y):
    r = rows[y]
    o = x * bpp
    if channels >= 3:
        return r[o], r[o+1], r[o+2]
    return r[o], r[o], r[o]

# 背景色 = 四角采样里出现最多的那个
from collections import Counter
corners = Counter(px(x, y) for x in (0, w-1) for y in (0, h-1))
bg = corners.most_common(1)[0][0]
print('bg =', bg)

def isfg(x, y):
    p = px(x, y)
    return abs(p[0]-bg[0]) + abs(p[1]-bg[1]) + abs(p[2]-bg[2]) > 24

# 行的前景像素数 → 找内容带
print('--- 每一行有内容的比例 (y: 0..h-1, 每 h/40 采样) ---')
band = max(1, h // 40)
for y0 in range(0, h, band):
    cnt = sum(1 for x in range(w) for y in range(y0, min(y0+band, h)) if isfg(x, y))
    print(f'y {y0:4d}-{min(y0+band,h)-1:4d}: {"#" * int(60*cnt/(band*w))}')

# 列的连通段（用整图投影找按钮/分组空隙）
print('--- 列投影 (x, 每 w/120 采样) ---')
bandx = max(1, w // 120)
segs = []
cur = None
for x0 in range(0, w, bandx):
    cnt = sum(1 for x in range(x0, min(x0+bandx, w)) for y in range(h) if isfg(x, y))
    has = cnt > 0
    if has and cur is None:
        cur = x0
    elif not has and cur is not None:
        segs.append((cur, x0-1)); cur = None
if cur is not None:
    segs.append((cur, w-1))
print('列上有内容的段 (x1-x2, 宽度):')
for s, e in segs:
    print(f'  {s:5d}-{e:5d}  宽 {e-s+1}')

# 每段的前景垂直范围
print('--- 每个列段的垂直范围 ---')
for s, e in segs:
    ys = [y for y in range(h) if any(isfg(x, y) for x in range(s, min(e+1, s+bandx*40)))]
    if ys:
        print(f'  x {s:5d}-{e:5d}: y {min(ys)}-{max(ys)}')

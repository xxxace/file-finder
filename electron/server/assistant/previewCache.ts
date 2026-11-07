/**
 * 带总字节预算的预览图缓存。
 *
 * 为什么不用裸 `Map`：原先只有「500 条 FIFO」一道闸，而**条数与字节无关** ——
 * 一张原图可达数百 KB，且 `avatarApply` 批量换头像时直接 `set` 会**绕过**条数闸。
 * 预算放在 Map 内部 ⇒ 任何写入方都受约束，调用点不必各自加守卫。
 *
 * 继承 `Map` 是为了让调用方签名零改动：`applyActressAvatars(..., previewCache)` 收的就是 Map。
 */

export type PreviewEntry = { buf: Buffer; type: string | null };

export class CappedPreviewCache extends Map<string, PreviewEntry> {
    private bytes = 0;

    constructor(
        private readonly maxBytes: number,
        private readonly maxCount: number,
    ) {
        super();
    }

    override set(key: string, value: PreviewEntry): this {
        const old = super.get(key);
        if (old) this.bytes -= old.buf.length;
        super.set(key, value);
        this.bytes += value.buf.length;

        // 先按条数、再按字节淘汰；**永不淘汰刚写进来的那一条**（否则等于没缓存）
        for (const [k, v] of this) {
            if (this.size <= this.maxCount && this.bytes <= this.maxBytes) break;
            if (k === key) continue;
            super.delete(k);
            this.bytes -= v.buf.length;
        }
        return this;
    }

    override delete(key: string): boolean {
        const old = super.get(key);
        if (old) this.bytes -= old.buf.length;
        return super.delete(key);
    }

    override clear(): void {
        this.bytes = 0;
        super.clear();
    }
}

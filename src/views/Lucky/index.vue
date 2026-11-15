<template>
    <div class="lucky-page">
        <div class="placeholder">手气不错</div>
    </div>
</template>

<script setup lang="ts">
/**
 * 手气不错 · 随机抽取（CD 专辑版）
 *
 * 当前只到 Task 1（骨架）：路由与左轨入口通，页面本身还没编排。
 * 数据层在 `useDraw.ts`，卡片在 `components/LuckyDiscCard`，包装盒在 `components/LuckyDiscCase`。
 * 设计与计划：`docs/DESIGN-LUCKY-DRAW-2026-11-15.md` / `docs/PLAN-LUCKY-DRAW-2026-11-15.md`
 */
</script>

<style scoped lang="less">
/* 与「3D 漫游」同形：外壳是 flex 纵向、页面必须自己撑满，否则高度塌成内容高 */
.lucky-page {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background: var(--ff-canvas);
}

.placeholder {
    font-size: var(--ff-fs-title);
    color: var(--ff-text-2);
}
</style>

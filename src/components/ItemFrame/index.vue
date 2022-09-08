<template>
    <div>{{props.src}}</div>
</template>

<script lang="ts" setup>
import { defineProps } from 'vue';

export interface ItemFrameProps {
    src?: string;
    label?: string | number;
    [key: string]: any
}

const props = defineProps<ItemFrameProps>({
    src: '123'
});
</script>

<style>

</style>
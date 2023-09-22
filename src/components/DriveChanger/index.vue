<template>
    <n-modal v-model:show="showModal">
        <n-card style="width: 400px" title="盘符更改" :bordered="false" size="huge" role="dialog" aria-modal="true">
            <n-form ref="formRef" :model="model" :rules="rules" label-placement="left"
                require-mark-placement="right-hanging" size="small" :disabled="loading">
                <n-form-item label="目标盘符" path="targetDrive">
                    <n-select v-model:value="model.targetDrive" placeholder="请选择目标盘符" :options="driveOptions" clearable />
                </n-form-item>
                <n-form-item label="变更盘符" path="replaceDrive">
                    <n-select v-model:value="model.replaceDrive" placeholder="请选择变更盘符" :options="driveOptions" clearable />
                </n-form-item>
                <div style="display: flex; justify-content: flex-end">
                    <n-button size="small" type="primary" @click="handleValidateButtonClick">
                        变更
                    </n-button>
                </div>
            </n-form>
        </n-card>
    </n-modal>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import { NForm, NSelect, NButton, NFormItem, FormInst, NCard, NModal, NSpin } from 'naive-ui'

export type DriveChangeParams = { targetDrive: string; replaceDrive: string; }
const formRef = ref<FormInst | null>(null);
const model = ref<Partial<DriveChangeParams>>({
    targetDrive: undefined,
    replaceDrive: undefined
})
const showModal = ref(false)
const loading = ref(false)
const driveOptions = ref(['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'].map(
    (v) => ({
        label: v,
        value: v
    })
));

const rules = ref({
    targetDrive: {
        required: true,
        trigger: ['blur', 'input'],
        message: '请选择目标盘符'
    },
    replaceDrive: {
        required: true,
        trigger: ['blur', 'input'],
        message: '请选择变更盘符'
    }
})

const setShowModal = function (val: boolean) {
    showModal.value = val;
}

const handleValidateButtonClick = function () {
    formRef.value?.validate(() => {

    })
}

defineExpose({
    setShowModal
})
</script>
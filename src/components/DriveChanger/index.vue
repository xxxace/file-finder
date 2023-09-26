<template>
    <n-modal v-model:show="showModal">
        <n-card style="width: 400px" title="盘符更改" :bordered="false" size="huge" role="dialog" aria-modal="true">
            <n-spin :show="loading">
                <template #description>
                    变更中...
                </template>
                <n-form ref="formRef" :model="model" :rules="rules" label-placement="left"
                    require-mark-placement="right-hanging" size="small" :disabled="loading">
                    <n-form-item label="目标盘符" path="targetDrive">
                        <n-select v-model:value="model.targetDrive" placeholder="请选择目标盘符" :options="driveOptions"
                            clearable />
                    </n-form-item>
                    <n-form-item label="变更盘符" path="replaceDrive">
                        <n-select v-model:value="model.replaceDrive" placeholder="请选择变更盘符" :options="driveOptions"
                            clearable />
                    </n-form-item>
                    <div style="display: flex; justify-content: flex-end">
                        <n-button size="small" type="primary" @click="handleValidateButtonClick" :loading="loading">
                            变更
                        </n-button>
                    </div>
                </n-form>
            </n-spin>
        </n-card>
    </n-modal>
</template>

<script lang="ts" setup>
import { ref, toRaw } from 'vue';
import { NForm, NSelect, NButton, NFormItem, FormInst, NCard, NModal, NSpin, useMessage } from 'naive-ui'
import { postAction } from "@/utils/request";

export type DriveChangeParams = { targetDrive: string; replaceDrive: string; }
const message = useMessage()
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
    replaceDrive: [{
        required: true,
        trigger: ['blur', 'input'],
        message: '请选择变更盘符'
    }, {
        validator: (rule: any, value: any) => {
            return !(model.value.targetDrive === value)
        },
        trigger: ['blur', 'input'],
        message: '变更盘符与目标盘符相同'
    }]
})

const setShowModal = function (val: boolean) {
    showModal.value = val;
}

const handleValidateButtonClick = function () {
    formRef.value?.validate(async (error) => {
        if (!error) {
            loading.value = true
            const postData = toRaw(model.value)
            try {
                const res = await postAction('http://localhost:3060/updateDrive', postData)
                message.success(`变更成功,共影响${res.result.length}条数据！`)
            } catch (e) {
                console.log(e)
                message.error("变更失败！")
            }
            loading.value = false
        }
    }).catch(e => {
        console.log(e)
    })
}

defineExpose({
    setShowModal
})
</script>
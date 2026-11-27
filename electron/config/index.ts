import fs from 'node:fs';
import path from 'node:path';

function getDefaultUserBasePath(): string {
    const userPath = process.env.USERPROFILE || process.env.USER || '/';
    return path.resolve(userPath, './.file-finder');
}

export const DEFAULT_USER_BASE_PATH = getDefaultUserBasePath();
export const DATA_DIR_POINTER_FILE = path.join(DEFAULT_USER_BASE_PATH, 'data-dir.json');

function resolveUserBasePath(): string {
    try {
        const raw = fs.readFileSync(DATA_DIR_POINTER_FILE, 'utf8');
        const parsed = JSON.parse(raw) as { dataDir?: unknown };
        const dir = typeof parsed?.dataDir === 'string' ? parsed.dataDir.trim() : '';
        if (dir && path.isAbsolute(dir)) {
            return path.resolve(dir);
        }
    } catch {
        // 未配置或指针损坏时回落默认目录
    }
    return DEFAULT_USER_BASE_PATH;
}

export default {
    userBasePath: resolveUserBasePath(),
};
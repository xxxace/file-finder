export function parseSize(bytes: number) {
    const s = {
        gb: bytes / 1024 / 1024 / 1024 % 1024,
        mb: bytes / 1024 / 1024 % 1024,
        kb: bytes / 1024 % 1024,
    }
    return s
}
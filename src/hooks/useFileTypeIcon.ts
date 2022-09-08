// https://fileicons.org/?branch=release&view=classic
const moudles = import.meta.glob('../assets/fileTypeIcon/*.**');
const moudlesKeys = Object.keys(moudles);

export default async function useFileTypeIcon(ext: string): Promise<string> {
    const extRegExp = new RegExp(`(${ext}).(svg|png)$`);
    const filepath = moudlesKeys.find(m => extRegExp.test(m));

    if (filepath && ext) {
        return (await (await moudles[filepath]() as Promise<{ default: string; }>)).default;
    } else if (!ext) {
        return (await (await moudles['../assets/fileTypeIcon/folder.png']() as Promise<{ default: string; }>)).default;
    } else {
        return (await (await moudles['../assets/fileTypeIcon/blank.svg']() as Promise<{ default: string; }>)).default;
    }
}
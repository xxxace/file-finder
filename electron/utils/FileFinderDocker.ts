import fs from 'node:fs';

export interface IDiskInfo {
    name: string;
    hasDocker: boolean;
}

export interface IDiskMap {
    [key: string]: IDiskInfo
}

export type DiskType = 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

const ExtraDiskList = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

export class FileFinderDockerManager {
    diskMap: IDiskMap;
    manageList: string[];

    constructor(manageList?: string[]) {
        if (!manageList || !manageList.length) manageList = ExtraDiskList;
        this.manageList = manageList;
        this.diskMap = {};
    }

    detect() {
        const { manageList } = this;
        for (let i = 0; i < manageList.length; i++) {
            const name = manageList[i];
            const fullname = manageList[i] + ':/';
            try {
                let hasDocker = false;
                const dockerPatch = `${fullname}/file-docker`
                fs.statSync(fullname);

                try {
                    fs.statSync(dockerPatch);
                    hasDocker = true;
                } catch (err) { }

                this.diskMap[name] = { name, hasDocker };
            } catch (err) { }
        }
    }

    hasDocker(diskname: DiskType): boolean {
        return this.diskMap[diskname].hasDocker;
    }

    mkdocker(diskname: DiskType): boolean {
        const dockerpath = `${diskname}:/file-docker`;
        try {
            fs.mkdirSync(dockerpath);
            const dir = process.cwd() + '/file-docker-list.txt';
            // 记录file-docker地址
            fs.appendFile(dir, dockerpath + '\n', {}, () => { });
            return true;
        } catch (err) {
            return false;
        }
    }

    hasFile(diskname: DiskType, filename: string): boolean {
        const filepath = `${diskname}:/file-docker/${filename}`;
        try {
            fs.statSync(filepath);
            return true;
        } catch (err) {
            return false;
        }
    }

    getFileDockerPath(diskname: DiskType): string {
        return `${diskname}:/file-docker`;
    }
}
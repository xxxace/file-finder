import url from 'node:url';
import http from 'node:http';
import events from 'node:events';
import util from 'node:util';
import * as fsasync from 'node:fs/promises';
import * as fs from 'fs';
import path from 'node:path';
import { mkthumbnial } from '../utils/ffmpeg';
import { DiskType, FileFinderDockerManager } from '../utils/FileFinderDocker';
import nedb, { OpenMode, SearchCache, getHistoryList } from './nedb';
import dayjs from 'dayjs';

const fileFinderDockerManager = new FileFinderDockerManager();
fileFinderDockerManager.detect();

const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];
const excludedFiles = ['System Volume Information', '$RECYCLE.BIN', 'Config.Msi', 'found.000', 'found.001'];
const event = new events.EventEmitter();

export type FileInfoFiles = fs.Stats & { name: string };

export type FileInfo = fs.Stats & {
    dir: string;
    name: string;
    isDirectory: boolean;
    base64?: string | boolean;
    ext?: string;
    files?: FileInfoFiles[];
    type: string;
    [key: string]: any
};
function isImage(ext: string) {
    return ext ? IMAGE_EXT.includes(ext.toLocaleLowerCase()) : false
}
function isVideo(ext: string) {
    return ext ? VIDEO_EXT.includes(ext.toLocaleLowerCase()) : false
}

function getBase64(path: string): Promise<string> {

    return new Promise(async resolve => {
        try {
            const file = await fsasync.readFile(path);
            resolve(`data:image/jpg;base64,${file.toString('base64')}`);
        } catch (e) {
            console.log(e);
            resolve('');
        }
    });
}

function getFilename(filename: string) {
    if (filename) {
        let index = filename.lastIndexOf('.');
        if (index !== -1) return filename.substring(0, index);
    }
    return filename;
}

function getFileType(ext?: string) {
    if (!ext) return 'folder';
    if (isVideo(ext)) return 'video';
    if (isImage(ext)) return 'image';
    return 'file';
}

function getExt(filename: string) {
    if (filename.indexOf('.') === -1) return '';
    return filename ? filename.substring(filename.lastIndexOf('.') + 1) : filename;
}

async function getThumbnail(filepath: string): Promise<string> {

    const fileInfo = path.parse(filepath);
    let root = fileInfo.root.replace(/(:|\\|\/)/g, '') as DiskType;

    if (!fileFinderDockerManager.hasDocker(root)) {
        fileFinderDockerManager.mkdocker(root);
    }

    const fileDockerPath = fileFinderDockerManager.getFileDockerPath(root);

    if (!fileFinderDockerManager.hasFile(root, fileInfo.name + '.png')) {
        await mkthumbnial(filepath, {
            timestamps: ['1%'],
            filename: fileInfo.name + '.png',
            folder: fileDockerPath,
            // size: '320x240'
        });
    }

    return await getBase64(`${fileDockerPath}/${fileInfo.name}.png`);
}

function readFolder(path: string, mode: string): Promise<FileInfo[]> {
    const dir = path;
    const folder: FileInfo[] = [];

    return new Promise(async (resolve) => {
        try {
            const files = await fsasync.readdir(dir);

            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                if (file.indexOf('.') === 0 || excludedFiles.includes(file)) continue;
                const filepath = dir + '/' + file;
                const stat = await fsasync.stat(filepath);
                let info!: FileInfo


                if (mode === 'cover' && stat.isDirectory()) {
                    folder.push(...(await handleCover(filepath)));
                } else {
                    if (mode === 'cover' && file === 'avatar.jpg') continue
                    const ext = getExt(file);

                    info = Object.assign({}, stat, {
                        dir: dir,
                        name: getFilename(file),
                        isDirectory: stat.isDirectory(),
                        ext: ext,
                        type: getFileType(ext)
                    });

                    if (info.type === 'folder') {
                        info.avatar = await getBase64(filepath + '/' + 'avatar.jpg');
                    }

                    if (isImage(ext)) {
                        info.base64 = await getBase64(filepath);
                    } else if (isVideo(ext)) {
                        info.base64 = await getThumbnail(filepath);
                    }
                }

                if (info) {
                    folder.push(info);
                }
            }

            resolve(folder);
        } catch (e) {
            console.log(e)
            resolve([]);
        }
    });
}

function handleCover(path: string): Promise<FileInfo[]> {
    const dir = path;
    const folder: FileInfo[] = [];

    return new Promise(async (resolve) => {
        try {
            let index = -1;
            let info!: FileInfo;
            let size = 0;
            let filenames = await fsasync.readdir(dir);
            let files: FileInfoFiles[] = [];

            for (let i = 0; i < filenames.length; i++) {
                const file = filenames[i];
                if (index === -1 && /\.(jpe?g|png|bmp|gif|svg|psd|webp)$/.test(file as string)) {
                    index = i;
                    continue;
                } else {
                    const filepath = dir + '/' + file;
                    const filestat = await fsasync.stat(filepath)
                    size += filestat.size;
                    files.push({
                        name: file,
                        ...filestat
                    });
                }
            }

            if (index !== -1) {
                const file = filenames[index];
                const filepath = dir + '/' + file;
                const stat = await fsasync.stat(filepath);
                const ext = getExt(file);
                size += stat.size;
                if (!isVideo(ext)) {
                    info = Object.assign({}, stat, {
                        dir: dir,
                        name: getFilename(file),
                        isDirectory: false,
                        ext: ext,
                        files: files,
                        size,
                        type: getFileType(ext)
                    });

                    info.base64 = await getBase64(filepath);
                }

                info && folder.push(info);
            } else {
                folder.push(...(await readFolder(path, 'folder')));
            }

            resolve(folder);
        } catch (e) {
            console.log(e)
            resolve([]);
        }
    });
}

function collectCodeList(root: string): any[] {
    function traverse(path: string, level: number) {
        const result: Record<string, any>[] = [];
        const dir = fs.readdirSync(path);
        dir.forEach(d => {
            const sub: Record<string, any> = {}
            const absolutePath = path + '/' + d
            sub.name = d;
            sub.level = level;
            if (fs.statSync(absolutePath).isDirectory()) {
                sub.children = traverse(absolutePath, level + 1);
            }
            result.push(sub);
        })
        return result;
    }

    return traverse(root, 0);
}

function getVideoCodeList(req: Req, res: http.ServerResponse) {
    const path = req.params?.get('path');
    const result = collectCodeList(path as string);

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('chartset', 'utf-8');
    res.end(JSON.stringify(result));
}

type Req = http.IncomingMessage & { params?: URLSearchParams }
const findOneAsync = util.promisify(nedb.findOne.bind(nedb));
// 封装缓存查询函数
async function searchCache(path: string) {
    try {
        const doc = await findOneAsync({ path }) as unknown as SearchCache;
        if (doc) {
            return doc.data;
        }
    } catch (err) {
        console.error(err);
    }
    return null;
}

const insertAsync = util.promisify<SearchCache, Error>(nedb.insert.bind(nedb));
// 封装读取文件夹信息函数
async function readFolderInfo(path: string, mode: OpenMode): Promise<FileInfo[]> {
    try {
        const folder = await readFolder(path, mode);
        const newDoc = { path, mode, data: folder, create_at: dayjs().format('YYYY-MM-DD HH:mm:ss') };
        // 使用 Promise 包装 insert 函数
        await insertAsync(newDoc);
        return folder;
    } catch (err) {
        console.error(err);
        return [];
    }
}

const removeAsync = util.promisify<any, any, (error: Error, numRemoved: number) => void>(nedb.remove.bind(nedb))
async function openFolderController(req: Req, res: http.ServerResponse) {
    let folder: FileInfo[] = [];
    let path = req.params?.get('path');
    const mode: OpenMode = (req.params?.get('mode') || 'folder') as OpenMode;
    const noCache = req.params?.get('noCache');

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('chartset', 'utf-8');

    if (path) {
        path = path.replace('&noCache=(true|false)', '');
        if (noCache) {
            await removeAsync({ path }, {})
            folder = await readFolderInfo(path, mode)
        } else {
            folder = await searchCache(path) || await readFolderInfo(path, mode);
        }
    }

    res.end(JSON.stringify(folder));
}

async function getHistory(req: Req, res: http.ServerResponse) {
    const path = req.params?.get('path');
    const pageNo = req.params?.get('pageNo') as number | undefined;
    const pageSize = req.params?.get('pageSize') as number | undefined;

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('chartset', 'utf-8');

    try {
        const ret = await getHistoryList(path, pageNo, pageSize);
        res.end(JSON.stringify(ret));
    } catch (e) {
        res.end(JSON.stringify({
            code: 500,
            error: e
        }));
    }
}

event.on('/getHistory', getHistory);
event.on('/getFileTree', getVideoCodeList);
event.on('/openFolder', openFolderController);
event.on('/', function (req, res) {
    req.headers['content-type'] = 'text/plain';
    res.end('hi! i`m ace.');
});

event.on('*', function (req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found\n');
});

const app = http.createServer((req: Req, res) => {
    const u = url.parse(req.url!);
    req.params = new URLSearchParams(u.search!);
    let path: string = u.pathname!;
    const listener = events.getEventListeners(event, path);

    if (!listener.length) path = '*';

    event.emit(path, req, res);
});

app.listen(3060, function () {
    console.log(`Local Server: http://127.0.0.1:3060/`);
});

function imageController(req: any, res: any) {
    throw new Error('Function not implemented.');
}

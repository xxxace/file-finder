import url from 'node:url';
import http from 'node:http';
import events from 'node:events';
import * as fsasync from 'node:fs/promises';
import * as fs from 'fs';
import path from 'node:path';
import { mkthumbnial } from '../utils/ffmpeg';
import { DiskType, FileFinderDockerManager } from '../utils/FileFinderDocker';

const fileFinderDockerManager = new FileFinderDockerManager();
fileFinderDockerManager.detect();

const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];
const excludedFiles = ['System Volume Information', '$RECYCLE.BIN', 'Config.Msi', 'found.000', 'found.001'];
const event = new events.EventEmitter();

export type FileInfo = fs.Stats & {
    dir: string;
    name: string;
    isDirectory: boolean;
    base64?: string | boolean;
    ext?: string;
    files?: string[];
    type: string;
};

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
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (IMAGE_EXT.includes(ext)) return 'image';
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
                const ext = getExt(file);

                if (mode === 'cover' && stat.isDirectory()) {
                    folder.push(...(await handleCover(filepath)));
                } else {
                    info = Object.assign({}, stat, {
                        dir: dir,
                        name: getFilename(file),
                        isDirectory: stat.isDirectory(),
                        ext: ext,
                        type: getFileType(ext)
                    });

                    if (IMAGE_EXT.includes(ext)) {
                        info.base64 = await getBase64(filepath);
                    } else if (VIDEO_EXT.includes(ext)) {
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
            const files = await fsasync.readdir(dir);

            files.some((file, i) => {
                if (/\.(jpe?g|png|bmp|gif|svg|psd|webp)$/.test(file)) {
                    index = i;
                    return true;
                }
            });

            if (index !== -1) {
                const file = files[index];
                const filepath = dir + '/' + file;
                const stat = await fsasync.stat(filepath);
                const ext = getExt(file);

                if (!VIDEO_EXT.includes(ext)) {
                    files.splice(index, 1);

                    info = Object.assign({}, stat, {
                        dir: dir,
                        name: getFilename(file),
                        isDirectory: false,
                        ext: ext,
                        files: files,
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

type Req = http.IncomingMessage & { params?: URLSearchParams }

async function openFolderController(req: Req, res: http.ServerResponse) {
    const path = req.params?.get('path');
    const mode = req.params?.get('mode') || 'folder';
    const folder = path ? await readFolder(path, mode) : [];

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('chartset', 'utf-8');
    res.end(JSON.stringify(folder));
}

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
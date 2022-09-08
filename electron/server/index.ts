import url from 'node:url';
import http from 'node:http';
import events from 'node:events';
import * as fsasync from 'node:fs/promises';
import { Stats } from 'fs';
import path from 'node:path';

const VIDEO_EXT = ['mp4', 'mkv', 'avi', 'wmv', 'flv', 'mpeg'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'svg', 'psd', 'webp'];

const event = new events.EventEmitter();

event.on('/', function (req, res) {
    req.headers['content-type'] = 'text/plain';
    res.end('hi! i`m ace.');
});

event.on('*', function (req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found\n');
});

export type FileInfo = Stats & {
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

function readFolder(path, mode): Promise<FileInfo[]> {
    const dir = path;
    const folder: FileInfo[] = [];

    return new Promise(async (resolve) => {
        try {
            const files = await fsasync.readdir(dir);

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file === 'System Volume Information' || file === '$RECYCLE.BIN') continue;
                const filepath = dir + '/' + file;
                const stat = await fsasync.stat(filepath);
                let info!: FileInfo
                const ext = getExt(file);

                if (mode === 'cover') {
                    if (stat.isDirectory()) {
                        folder.push(...(await handleCover(filepath)));
                    } else {
                        info = Object.assign({}, stat, {
                            dir: dir,
                            name: getFilename(file),
                            isDirectory: false,
                            ext: ext,
                            type: getFileType(ext)
                        });

                        if (IMAGE_EXT.includes(ext)) {
                            info.base64 = await getBase64(filepath);
                        } else if (VIDEO_EXT.includes(ext)) {
                            // dosomething
                        }
                    }
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
                        // dosomething
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
event.on('/openFolder', async function (req: Req, res: http.ServerResponse) {
    const path = req.params?.get('path');
    const mode = req.params?.get('mode');

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const folder = await readFolder(path, mode);
    res.setHeader('chartset', 'utf-8');
    res.end(JSON.stringify(folder));
});

const app = http.createServer((req: Req, res) => {
    const u = url.parse(req.url!);
    req.params = new URLSearchParams(u.search!);
    let path: string = u.pathname!;
    const listener = events.getEventListeners(event, path);

    if (!listener.length) path = '*';

    event.emit(path, req, res);
});

app.listen(3060);



import Nedb from 'nedb';
import { FileInfo } from './index';
import config from '../config';
import path from 'node:path';

export type OpenMode = 'cover' | 'folder'

export interface SearchCache {
    _id?: string;
    path: string;
    data: FileInfo[];
    create_at: string;
    mode: OpenMode;
}

export interface Pagination {
    total: number;
    current: number;
    size: number;
}

export interface BrowseHistory {
    records: Partial<SearchCache>[]
}

export type BrowseHistoryWithPagination = Pagination & BrowseHistory

const nedb = new Nedb<SearchCache>({ filename: path.join(config.userBasePath, 'searchCache.db') });
nedb.loadDatabase();

export function getHistoryList(path: string | null | undefined, pageNo?: number, pageSize?: number): Promise<BrowseHistoryWithPagination> {
    const current = Number(pageNo) || 1;
    const size = Number(pageSize) || 10;

    return new Promise((resolve, reject) => {
        nedb.count({}, function (err, count) {
            if (err) {
                reject(err);
            } else {
                nedb.find({ path: new RegExp(path || '') }).sort({ path: 1 }).skip((current - 1) * size).limit(size).exec(function (e, docs) {
                    if (e) {
                        reject(e);
                    } else {
                        resolve({
                            records: docs.map(d => ({ path: d.path, mode: d.mode, create_at: d.create_at })),
                            total: count,
                            current: current,
                            size: size
                        });
                    }
                })
            }
        })
    })
}

export function findAllByPath(path: string | null | undefined): Promise<Array<SearchCache>> {
    return new Promise((resolve, reject) => {
        nedb.find({ path: new RegExp(path || '') }).sort({ path: 1 }).exec(function (e, docs) {
            if (e) {
                reject(e)
            } else {
                resolve(docs)
            }
        })
    })
}

export default nedb;
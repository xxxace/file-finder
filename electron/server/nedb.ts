import Nedb from 'nedb';
import { FileInfo } from './index';

export interface SearchCache {
    path: string;
    data: FileInfo[]
}

export interface Pagination {
    total: number;
    current: number;
    size: number;
}

export interface BrowseHistory {
    records: string[]
}



export
    const nedb = new Nedb<SearchCache>({ filename: 'searchCache.db' });
nedb.loadDatabase();

export function getHistoryList(path: string | null | undefined, pageNo?: number, pageSize?: number): Promise<Pagination & BrowseHistory> {
    const current = pageNo || 1;
    const size = pageSize || 10;

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
                            records: docs.map(d => d.path),
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

export default nedb;
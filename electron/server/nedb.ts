import Nedb from 'nedb';
import { FileInfo } from './index';

export interface SearchCache {
    path: string;
    data: FileInfo[]
}
const nedb = new Nedb<SearchCache>({ filename: 'searchCache.db' });
nedb.loadDatabase();

export default nedb;
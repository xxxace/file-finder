import path from 'node:path';

function getUserBasePath() {
    const userPath = process.env.USERPROFILE || process.env.USER || '/';
    return path.resolve(userPath, './.file-finder');
}

export default {
    userBasePath: getUserBasePath()
}
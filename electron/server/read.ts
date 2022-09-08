import process from 'child_process';

const cmd = {
    getAllDrive: () => 'wmic logicaldisk get deviceid',
    getDriveNameByDeviceId: (deviceid) => `wmic logicaldisk where name="${deviceid}:" get volumename`
}
export type DiskInfo = {
    deviceid: string;
    volumename: string;
}

// export function getAllDrive() {
//     process.exec(cmd.getAllDrive(), (error, stdout) => {
//         if (error) {
//             console.log(error);
//         } else {
//             let deviceids = stdout.replace(/\r|\s|\n|DeviceID/g, '').split(':');
//             deviceids.splice(deviceids.length - 1, 1);

//             console.log(deviceids);
//         }
//     });
// }

// export function readdisk() {
//     const disks: DiskInfo[] = [];
//     return new Promise(function (resolve, reject) {
//         getAllDrive()
//     })
// }


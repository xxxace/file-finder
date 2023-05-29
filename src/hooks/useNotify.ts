import { useNotification, NotificationType } from 'naive-ui';

const notification = useNotification();
export default function useNotify() {
    return function (type: NotificationType, title?: string, message?: string) {
        notification[type]({
            content: title,
            meta: message,
            duration: 2500,
            keepAliveOnHover: true
        })
    }
}
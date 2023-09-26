import { useNotification, NotificationType } from 'naive-ui';

export default function useNotify() {
    const notification = useNotification();
    return function (type: NotificationType, title?: string, message?: string) {
        notification[type]({
            content: title,
            meta: message,
            duration: 2500,
            keepAliveOnHover: true
        })
    }
}
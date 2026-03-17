self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'New message';
  const options = {
    body: data.body || '',
    icon: '/studio-sms/icon.png',
    badge: '/studio-sms/icon.png',
    tag: data.contact || 'sms',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { contact: data.contact }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes('sms-inbox') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open it
      return clients.openWindow('/studio-sms/sms-inbox.html');
    })
  );
});

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Config from environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Set up VAPID for push notifications (only if keys are set)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL || 'hello@example.com'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ── One-time VAPID key generator (hit this URL once to get your keys) ──
// Once you've saved the keys to Render env vars, this endpoint does nothing harmful
app.get('/vapid-keys', (req, res) => {
  if (process.env.VAPID_PUBLIC_KEY) {
    return res.json({ message: 'VAPID keys already set — you are good to go!' });
  }
  const keys = webpush.generateVAPIDKeys();
  res.json({
    message: 'Copy these into your Render environment variables, then restart the service.',
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey
  });
});

// GET /vapid-public-key — frontend fetches this to subscribe
app.get('/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// POST /subscribe — save a device's push subscription
app.post('/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription' });

  await supabase.from('push_subscriptions')
    .upsert({ endpoint: subscription.endpoint, subscription }, { onConflict: 'endpoint' });

  res.json({ success: true });
});

// GET /conversations — list all unique contacts with their last message
app.get('/conversations', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .order('timestamp', { ascending: false });

  if (error) return res.status(500).json({ error });

  const map = {};
  data.forEach(msg => {
    if (!map[msg.contact]) {
      map[msg.contact] = {
        contact: msg.contact,
        lastMessage: msg.body,
        lastTime: msg.timestamp,
        lastDirection: msg.direction,
        messageCount: 1
      };
    } else {
      map[msg.contact].messageCount++;
    }
  });

  res.json(Object.values(map));
});

// GET /messages/:contact — full thread for one contact
app.get('/messages/:contact', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('contact', req.params.contact)
    .order('timestamp', { ascending: true });

  if (error) return res.status(500).json({ error });
  res.json(data);
});

// POST /send — send a message to a lead
app.post('/send', async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

  try {
    await twilioClient.messages.create({ from: FROM_NUMBER, to, body });
    await supabase.from('messages').insert({ contact: to, body, direction: 'outbound' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /incoming — Twilio webhook for incoming texts
app.post('/incoming', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  // Store message
  await supabase.from('messages').insert({ contact: from, body, direction: 'inbound' });

  // Send push notifications to all subscribed devices
  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  if (subs && subs.length > 0) {
    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: `New text from ${from}`,
          body: body,
          contact: from
        }));
      } catch (e) {
        // Remove expired/invalid subscriptions automatically
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }));
  }

  // Reply with empty TwiML so Twilio doesn't error
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.listen(3000, () => console.log('Studio SMS backend running'));

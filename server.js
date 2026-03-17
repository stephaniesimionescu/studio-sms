const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Config from environment variables
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const MY_PHONE = process.env.MY_PHONE;
const BOSS_PHONE = process.env.BOSS_PHONE;

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

  await supabase.from('messages').insert({ contact: from, body, direction: 'inbound' });

  // Notify you and your boss by text
  const notifyMsg = `New lead text from ${from}: "${body}"`;
  const toNotify = [MY_PHONE, BOSS_PHONE].filter(Boolean);
  await Promise.all(toNotify.map(phone =>
    twilioClient.messages.create({ from: FROM_NUMBER, to: phone, body: notifyMsg })
  ));

  // Reply with empty TwiML so Twilio doesn't complain
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.listen(3000, () => console.log('Studio SMS backend running'));

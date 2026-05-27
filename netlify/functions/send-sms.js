exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const { to, message } = JSON.parse(event.body || '{}');
  if (!to || !message) {
    return { statusCode: 400, body: 'Missing to or message' };
  }

  const accountSid = process.env.TWILIO_SID;
  const authToken  = process.env.TWILIO_TOKEN;
  const fromNumber = 'whatsapp:+14155238886';
  const toNumber   = `whatsapp:${to}`;

  if (!accountSid || !authToken) {
    return { statusCode: 500, body: 'Twilio credentials not configured' };
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body = new URLSearchParams({ To: toNumber, From: fromNumber, Body: message });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data = await res.json();
    if (res.ok) {
      return { statusCode: 200, body: JSON.stringify({ success: true, sid: data.sid }) };
    } else {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

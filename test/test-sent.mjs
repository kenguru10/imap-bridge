import http from 'http';
import { spawn } from 'child_process';
import net from 'net';
import nodemailer from 'nodemailer';

const accounts = [{ accountId: 1, email: 'me@example.com', name: 'Me', sort: 1 }];
const emails = [];
let nextEmailId = 1000;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    let result;
    if (url.pathname === '/api/login') {
      result = { code: 200, message: 'ok', data: { token: 'TESTTOKEN' } };
    } else if (url.pathname === '/api/account/list') {
      result = { code: 200, message: 'ok', data: accounts };
    } else if (url.pathname === '/api/email/list') {
      result = { code: 200, message: 'ok', data: { list: emails, total: emails.length, latestEmail: emails[0] || {emailId:0,accountId:1,userId:1} } };
    } else if (url.pathname === '/api/email/latest') {
      result = { code: 200, message: 'ok', data: [] };
    } else if (url.pathname === '/api/email/read') {
      result = { code: 200, message: 'ok', data: null };
    } else if (url.pathname === '/api/email/delete') {
      result = { code: 200, message: 'ok', data: null };
    } else if (url.pathname === '/api/email/send') {
      const payload = JSON.parse(body);
      const id = nextEmailId++;
      const emailResult = {
        emailId: id,
        sendEmail: 'me@example.com',
        name: 'Me',
        subject: payload.subject,
        text: payload.text,
        content: payload.content,
        recipient: JSON.stringify(payload.receiveEmail.map(e => ({address:e,name:''}))),
        createTime: new Date().toISOString(),
        messageId: `<sent-${id}@example.com>`,
      };
      result = { code: 200, message: 'ok', data: [emailResult] };
    } else {
      result = { code: 500, message: 'not implemented' };
    }
    res.end(JSON.stringify(result));
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  console.log('mock worker on', port);

  console.log('spawning bridge...');
  const bridge = spawn('node', ['src/index.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, CLOUD_MAIL_WORKER_URL: `http://127.0.0.1:${port}`, IMAP_PORT: '1143', SMTP_PORT: '1587' },
  });
  bridge.stdout.on('data', d => process.stdout.write(d));
  bridge.stderr.on('data', d => process.stderr.write(d));

  await new Promise(r => setTimeout(r, 1500));
  console.log('sending via SMTP...');

  const transporter = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 1587,
    secure: false,
    auth: { user: 'me@example.com', pass: 'pass' },
    tls: { rejectUnauthorized: false },
  });

  try {
    const info = await transporter.sendMail({
      from: 'me@example.com',
      to: 'friend@example.com',
      subject: 'Test sent',
      text: 'This is a test sent message',
      html: '<p>This is a test sent message</p>',
    });
    console.log('\nSMTP sent:', info.messageId);
  } catch (e) {
    console.error('\nSMTP send failed:', e.message);
  }

  await new Promise(r => setTimeout(r, 500));
  console.log('connecting IMAP...');

  const sock = net.createConnection({ host: '127.0.0.1', port: 1143 });
  let buf = '';
  sock.on('data', d => { buf += d.toString(); });
  const send = (cmd) => sock.write(cmd + '\r\n');
  const waitFor = (tag) => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (buf.includes(tag + ' OK') || buf.includes(tag + ' NO') || buf.includes(tag + ' BAD')) {
        clearInterval(iv);
        const out = buf;
        buf = '';
        resolve(out);
      }
    }, 50);
  });

  await new Promise(r => setTimeout(r, 300)); // wait for greeting
  send('A1 LOGIN me@example.com pass');
  await waitFor('A1');
  send('A2 SELECT Sent');
  const selectOut = await waitFor('A2');
  console.log('\nSELECT Sent:\n', selectOut);

  if (selectOut.includes(' EXISTS')) {
    send('A3 FETCH 1 (UID FLAGS RFC822.SIZE ENVELOPE)');
    const fetchOut = await waitFor('A3');
    console.log('\nFETCH Sent:\n', fetchOut);
  } else {
    send('A3 LIST "" "*"');
    const listOut = await waitFor('A3');
    console.log('\nLIST:\n', listOut);
  }
  send('A4 LOGOUT');
  await waitFor('A4');
  sock.end();

  bridge.kill('SIGINT');
  server.close();
  setTimeout(() => process.exit(0), 500);
});

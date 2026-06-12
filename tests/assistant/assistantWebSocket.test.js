const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const User = require('../../src/models/User');
const { attachAssistantSocketServer } = require('../../src/realtime/assistantSocketServer');

const waitForEvent = (socket, eventType) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error(`Timed out waiting for ${eventType}`));
  }, 5000);

  const listener = (raw) => {
    const payload = JSON.parse(String(raw || '{}'));
    if (payload.type !== eventType) {
      return;
    }
    clearTimeout(timeout);
    socket.off('message', listener);
    resolve(payload);
  };

  socket.on('message', listener);
});

describe('assistant websocket', () => {
  let server;
  let address;

  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    attachAssistantSocketServer(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = server.address();
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('accepts chunked input and streams an assistant response', async () => {
    const user = await User.create({
      name: 'Socket User',
      email: 'socket-user@example.com',
      password: 'password123',
      isVerified: true,
      onboardingCompleted: true,
      onboardingStatus: 'completed',
    });

    const token = jwt.sign(
      { userId: String(user._id), tokenVersion: user.tokenVersion || 0 },
      process.env.JWT_SECRET,
    );

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/assistant/ws?token=${token}`);

    await waitForEvent(socket, 'session.ready');

    socket.send(JSON.stringify({ type: 'input.append', chunk: 'How can I ' }));
    socket.send(JSON.stringify({ type: 'input.append', chunk: 'spend less on food?' }));
    socket.send(JSON.stringify({ type: 'input.commit' }));

    const saved = await waitForEvent(socket, 'message.saved');
    expect(saved.userMessage.content).toBe('How can I spend less on food?');
    expect(saved.assistantMessage.status).toBe('queued');

    const done = await waitForEvent(socket, 'assistant.done');
    expect(String(done.fullText || '').length).toBeGreaterThan(0);

    socket.close();
  });
});

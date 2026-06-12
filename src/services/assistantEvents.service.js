const { EventEmitter } = require('events');

const assistantEventBus = new EventEmitter();
assistantEventBus.setMaxListeners(200);

const CHAT_EVENT = 'assistant.chat';

const publishAssistantChatEvent = (chatId, event) => {
  if (!chatId || !event) return;
  assistantEventBus.emit(`${CHAT_EVENT}:${String(chatId)}`, {
    ...event,
    chatId: String(chatId),
    emittedAt: new Date().toISOString(),
  });
};

const subscribeToAssistantChatEvents = (chatId, listener) => {
  const eventKey = `${CHAT_EVENT}:${String(chatId)}`;
  assistantEventBus.on(eventKey, listener);

  return () => {
    assistantEventBus.off(eventKey, listener);
  };
};

module.exports = {
  publishAssistantChatEvent,
  subscribeToAssistantChatEvents,
};

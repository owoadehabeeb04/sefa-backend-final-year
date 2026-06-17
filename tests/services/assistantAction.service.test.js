const mongoose = require('mongoose');

const AssistantAction = require('../../src/models/AssistantAction');
const AssistantChat = require('../../src/models/AssistantChat');
const AssistantMessage = require('../../src/models/AssistantMessage');
const { planAssistantAction } = require('../../src/services/assistantAction.service');

describe('assistantAction.service', () => {
  it('keeps pending income follow-ups in the action flow and creates a confirmation action', async () => {
    const userId = new mongoose.Types.ObjectId();
    const chat = await AssistantChat.create({
      userId,
      title: 'Allowance',
      titleSource: 'auto',
      status: 'idle',
    });

    const assistantMessage1 = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: '',
      status: 'generating',
    });

    await AssistantAction.create({
      userId,
      chatId: chat._id,
      assistantMessageId: assistantMessage1._id,
      actionType: 'create_income',
      extractedPayload: {
        amount: 70000,
      },
      missingFields: ['source', 'date'],
      status: 'pending_fields',
      confirmationMessage: 'What should I use as the income source or category?',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const sourceMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: '',
      status: 'generating',
    });

    const sourcePlan = await planAssistantAction({
      userId,
      chatId: chat._id,
      assistantMessageId: sourceMessage._id,
      text: "Allowance, if it doesn't exist you can create.",
      history: [],
    });

    expect(sourcePlan.kind).toBe('missing_fields');
    expect(sourcePlan.missingFields).toEqual(['date']);
    expect(sourcePlan.payload.source).toBe('Allowance');

    const dateMessage = await AssistantMessage.create({
      chatId: chat._id,
      userId,
      role: 'assistant',
      content: '',
      status: 'generating',
    });

    const confirmationPlan = await planAssistantAction({
      userId,
      chatId: chat._id,
      assistantMessageId: dateMessage._id,
      text: 'Yeah June 16',
      history: [],
    });

    expect(confirmationPlan.kind).toBe('confirmation_required');
    expect(confirmationPlan.action.status).toBe('pending_confirmation');
    expect(confirmationPlan.action.extractedPayload).toMatchObject({
      amount: 70000,
      source: 'Allowance',
      categoryName: 'Allowance',
      dateLabel: 'june 16',
    });
  });
});

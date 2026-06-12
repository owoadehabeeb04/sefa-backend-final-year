const { decideAssistantWebLookup } = require('../../src/services/retrieval/liveWebRouter.service');

describe('liveWebRouter.service', () => {
  it('does not trigger live lookup for internal finance questions', () => {
    const result = decideAssistantWebLookup('Can I still reach month end with this spending?');

    expect(result.shouldSearch).toBe(false);
    expect(result.mode).toBe('none');
  });

  it('routes product affordability questions to shopping lookup', () => {
    const result = decideAssistantWebLookup('Can I get an LG TV this month?');

    expect(result.shouldSearch).toBe(true);
    expect(result.mode).toBe('shopping');
    expect(result.query).toMatch(/LG TV/i);
    expect(result.query).toMatch(/Nigeria/i);
  });

  it('routes current fact questions to general web lookup', () => {
    const result = decideAssistantWebLookup('Is fuel price up this week?');

    expect(result.shouldSearch).toBe(true);
    expect(result.mode).toBe('general_web');
  });
});

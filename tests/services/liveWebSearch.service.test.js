jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

const axios = require('axios');

const {
  searchGeneralWeb,
  searchShoppingWeb,
} = require('../../src/services/retrieval/liveWebSearch.service');

describe('liveWebSearch.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes Tavily general web results', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        results: [
          {
            title: 'Fuel price rises in Nigeria',
            url: 'https://example.com/fuel-price',
            source: 'Example News',
            content: 'Pump price moved higher this week.',
          },
        ],
      },
    });

    const result = await searchGeneralWeb({
      query: 'Is fuel price up this week in Nigeria?',
      market: 'NG',
    });

    expect(result.status).toBe('used');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      title: 'Fuel price rises in Nigeria',
      sourceName: 'Example News',
      url: 'https://example.com/fuel-price',
    });
  });

  it('falls back from Google Shopping to Google Search when shopping results are sparse', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          shopping_results: [
            {
              title: 'LG 43 inch Smart TV',
              link: 'https://shop-one.example/lg-tv',
              source: 'Shop One',
              price: '₦420,000',
              extracted_price: 420000,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          organic_results: [
            {
              title: 'LG TV price in Nigeria',
              link: 'https://shop-two.example/lg-tv',
              source: 'Shop Two',
              snippet: 'Buy from ₦450,000 today',
              rich_snippet: {
                top: {
                  detected_extensions: ['₦450,000'],
                },
              },
            },
          ],
        },
      });

    const result = await searchShoppingWeb({
      query: 'LG TV price in Nigeria',
      market: 'NG',
    });

    expect(result.status).toBe('used');
    expect(result.providers).toContain('serpapi-google-shopping');
    expect(result.providers).toContain('serpapi-google-search');
    expect(result.sources).toHaveLength(2);
    expect(result.priceRangeSummary).toMatchObject({
      low: 420000,
      high: 450000,
      currency: 'NGN',
      sourceCount: 2,
    });
  });
});

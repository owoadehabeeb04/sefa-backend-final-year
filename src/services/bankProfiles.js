const normalizeBankText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const BANK_PROFILES = [
  {
    slug: 'access',
    displayName: 'Access Bank',
    aliases: ['access', 'access bank', 'accessbank'],
    statementKeywords: ['transaction date', 'value date', 'access bank plc'],
    parserKey: 'access_csv',
  },
  {
    slug: 'gtbank',
    displayName: 'GTBank',
    aliases: ['gtbank', 'gt bank', 'guaranty trust bank', 'guaranty trust'],
    statementKeywords: ['posting date', 'tranid', 'guaranty trust bank'],
    parserKey: 'gtbank_csv',
  },
  {
    slug: 'zenith',
    displayName: 'Zenith Bank',
    aliases: ['zenith', 'zenith bank'],
    statementKeywords: ['tran date', 'reference', 'zenith bank plc'],
    parserKey: 'zenith_csv',
  },
  {
    slug: 'uba',
    displayName: 'UBA',
    aliases: ['uba', 'united bank for africa', 'united bank for africa plc'],
    statementKeywords: ['trans ref', 'transaction details', 'united bank for africa'],
    parserKey: 'uba_csv',
  },
  {
    slug: 'firstbank',
    displayName: 'FirstBank',
    aliases: ['firstbank', 'first bank', 'first bank of nigeria'],
    statementKeywords: ['transaction date', 'narration', 'first bank of nigeria'],
    parserKey: 'firstbank_csv',
  },
  {
    slug: 'opay',
    displayName: 'OPay',
    aliases: ['opay', 'opay digital services', 'opay nigeria', 'opay wallet'],
    statementKeywords: [
      'balance after transaction',
      'transaction type',
      'opay digital services',
      'fee',
    ],
    parserKey: 'opay_csv',
  },
];

const BANK_PROFILE_BY_SLUG = new Map(BANK_PROFILES.map((profile) => [profile.slug, profile]));

const findBankProfile = (slug) => BANK_PROFILE_BY_SLUG.get(slug) || null;

const resolveBankProfile = (value) => {
  const normalized = normalizeBankText(value);
  if (!normalized) return null;

  for (const profile of BANK_PROFILES) {
    if (profile.slug === normalized) {
      return profile;
    }

    if (profile.aliases.some((alias) => normalizeBankText(alias) === normalized)) {
      return profile;
    }
  }

  return null;
};

const getSupportedBanks = () =>
  BANK_PROFILES.map((profile) => ({
    slug: profile.slug,
    displayName: profile.displayName,
  }));

module.exports = {
  BANK_PROFILES,
  findBankProfile,
  getSupportedBanks,
  normalizeBankText,
  resolveBankProfile,
};

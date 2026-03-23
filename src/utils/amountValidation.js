const MAX_SAFE_CURRENCY_AMOUNT = Number.MAX_SAFE_INTEGER / 100;

const AMOUNT_TOO_LARGE_MESSAGE = 'Amount is too large to process safely';

const isSafeCurrencyAmount = (amount) =>
  Number.isFinite(amount) && amount > 0 && amount <= MAX_SAFE_CURRENCY_AMOUNT;

module.exports = {
  MAX_SAFE_CURRENCY_AMOUNT,
  AMOUNT_TOO_LARGE_MESSAGE,
  isSafeCurrencyAmount,
};

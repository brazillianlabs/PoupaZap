// handlers.js
const { normalizeText, extractAmountFromString, getCategoryFromString, parseCurrencyValue } = require('./utils');
const { addTransaction, getMonthlyBalance, getCategoryExpenses, addScheduledExpenseToUser, addCreditCard, getCreditCardsForUser, getCreditCardByNickname, removeCreditCard, db } = require('./database');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function tryParseQuickExpense(text, userData) {
  const normalizedText = normalizeText(text);
  const expenseKeywords = ['gastei', 'paguei', 'comprei', 'despesa de', 'uma compra de'];
  if (!expenseKeywords.some(kw => normalizedText.includes(kw))) return { success: false };

  const amountResult = extractAmountFromString(normalizedText);
  if (!amountResult) return { success: false };
  const { amount, matchedString } = amountResult;
  let remainingText = normalizedText.replace(matchedString, ' ');

  let cardId = null;
  const cards = await getCreditCardsForUser(userData.jid);
  if (cards?.length) {
    for (const card of cards) {
      const regex = new RegExp(`(?:no|no cartao|pelo|com o|no credito)\s+${card.nickname}`, 'i');
      if (regex.test(remainingText)) {
        cardId = card.id;
        remainingText = remainingText.replace(regex, ' ');
        break;
      }
    }
  }

  let description = remainingText;
  const fillerWords = [...expenseKeywords, 'em', 'no', 'na', 'para', 'com', 'de'];
  fillerWords.forEach(word => {
    description = description.replace(new RegExp(`\\b${word}\\b`, 'gi'), ' ');
  });
  description = description.trim().replace(/\s+/g, ' ').replace(/^[.,!?]+|[.,!?]+$/g, '');

  let category = 'Outros';
  for (const word of description.split(' ')) {
    const found = getCategoryFromString(word, userData.categories);
    if (found) {
      category = found;
      break;
    }
  }
  if (!description) description = category;

  return { success: true, type: 'quick_expense', amount, category, description, cardId };
}

async function tryParseQuickIncome(text) {
  const normalizedText = normalizeText(text);
  const incomeKeywords = ['recebi', 'ganhei', 'pix de', 'pagamento de', 'entrou'];
  if (!incomeKeywords.some(kw => normalizedText.includes(kw))) return { success: false };

  const amountResult = extractAmountFromString(normalizedText);
  if (!amountResult) return { success: false };
  const { amount, matchedString } = amountResult;
  let description = normalizedText.replace(matchedString, ' ');
  incomeKeywords.forEach(word => {
    description = description.replace(new RegExp(word, 'gi'), '');
  });
  description = description.trim().replace(/\s+/g, ' ').replace(/^[.,!?]+|[.,!?]+$/g, '');

  return { success: true, type: 'quick_income', amount, description: description || 'Receita por voz' };
}

async function tryParseCreateGoalVoice(text) {
  const normalizedText = normalizeText(text);
  if (!normalizedText.startsWith('criar meta')) return { success: false };

  const valueMatch = normalizedText.match(/(?:de|com|valor de)\s*(\d+(?:[.,]\d{1,2})?)/);
  const monthsMatch = normalizedText.match(/em\s*(\d+)\s*meses?/);
  if (!monthsMatch) return { success: false };

  const months = parseInt(monthsMatch[1]);
  const value = valueMatch ? parseCurrencyValue(valueMatch[1]) : 0;

  let name = normalizedText
    .replace('criar meta', '')
    .replace(valueMatch ? valueMatch[0] : '', '')
    .replace(monthsMatch[0], '')
    .trim();

  if (!name) name = 'Nova Meta';

  if (months > 0) return { success: true, type: 'create_goal_intent', data: { name, value, months } };
  return { success: false };
}

module.exports = {
  tryParseQuickExpense,
  tryParseQuickIncome,
  tryParseCreateGoalVoice
};

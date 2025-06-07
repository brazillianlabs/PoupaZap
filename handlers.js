// handlers.js
const { normalizeText, extractAmountFromString, formatCurrency, getCategoryFromString, parseCurrencyValue } = require('./utils');
const { getMainMenu, getCategoryMenu, getCardsMenu, getHelp, mapInputToMenuOption } = require('./utils');
const { addTransaction, getMonthlyBalance, getCategoryExpenses, addScheduledExpenseToUser, addCreditCard, getCreditCardsForUser, getCreditCardByNickname, removeCreditCard, db } = require('./database');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Funções de NLU e Geração de Relatórios permanecem as mesmas
// tryParseQuickExpense, tryParseQuickIncome, getStatement, etc.
// Colei o arquivo completo abaixo para garantir

async function tryParseQuickExpense(text, userData) {
    const normalizedText = normalizeText(text);
    const expenseKeywords = ['gastei', 'paguei', 'comprei', 'despesa de', 'uma compra de'];
    if (!expenseKeywords.some(kw => normalizedText.includes(kw))) {
        return { success: false };
    }
    const amountResult = extractAmountFromString(normalizedText);
    if (!amountResult) return { success: false };
    const { amount, matchedString } = amountResult;
    let remainingText = normalizedText.replace(matchedString, ' ');
    const cards = await getCreditCardsForUser(userData.jid);
    let cardId = null;
    if (cards && cards.length > 0) {
        for (const card of cards) {
            if (card.nickname) {
                const cardRegex = new RegExp(`(?:no|no cartao|pelo|com o|no credito)\\s+(${card.nickname})`, 'i');
                if (remainingText.match(cardRegex)) {
                    cardId = card.id;
                    remainingText = remainingText.replace(cardRegex, ' ');
                    break;
                }
            }
        }
    }
    let description = remainingText;
    [...expenseKeywords, 'em', 'no', 'na', 'para', 'com', 'de'].forEach(word => {
        description = description.replace(new RegExp(`\\b${word}\\b`, 'gi'), ' ');
    });
    description = description.trim().replace(/\s+/g, ' ').replace(/^[.,!?]+|[.,!?]+$/g, '');
    let category = "Outros";
    const words = description.split(' ');
    for (const word of words) {
        const foundCategory = getCategoryFromString(word, userData.categories);
        if (foundCategory) { category = foundCategory; break; }
    }
    if (!description) description = category;
    return { success: true, type: 'quick_expense', amount, category, description, cardId };
}
async function tryParseQuickIncome(text) {
    const normalizedText = normalizeText(text);
    const keywords = ['recebi', 'ganhei', 'pix de', 'pagamento de', 'entrou'];
    if (!keywords.some(kw => normalizedText.includes(kw))) return { success: false };
    const amountResult = extractAmountFromString(normalizedText);
    if (!amountResult) return { success: false };
    const { amount, matchedString } = amountResult;
    let description = normalizedText.replace(matchedString, ' ').replace(/recebi|ganhei|pix de|pagamento de|entrou/gi, '').trim().replace(/\s+/g, ' ').replace(/^[.,!?]+|[.,!?]+$/g, '');
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
    let name = normalizedText.replace('criar meta', '').replace(valueMatch ? valueMatch[0] : '', '').replace(monthsMatch[0], '').trim();
    if (!name) name = "Nova Meta";
    if (months > 0) return { success: true, type: 'create_goal_intent', data: { name, value, months } };
    return { success: false };
}
async function getStatement(userData) {
    return new Promise((resolve) => {
        db.all("SELECT t.*, c.name as cardName FROM Transactions t LEFT JOIN CreditCards c ON t.cardId = c.id WHERE t.userJid = ? ORDER BY t.date DESC LIMIT 10", [userData.jid], (err, rows) => {
            if (err || !rows) return resolve(`📋 *Extrato*\n\nNão foi possível buscar as transações.`);
            if (rows.length === 0) return resolve(`📋 *Extrato*\n\nNenhuma transação encontrada.`);
            const recent = rows.map(t => {
                const dateObj = new Date(t.date);
                const icon = t.type === 'income' ? '💰' : '💸';
                const signal = t.type === 'income' ? '+' : '-';
                let categoryText = t.category;
                if (t.description) { categoryText = `${t.category} (${t.description})`; }
                if (t.cardName) { categoryText += ` [💳 ${t.cardName}]`; }
                return `${icon} ${signal}${formatCurrency(t.amount)} - ${categoryText}\n📅 ${dateObj.toLocaleDateString('pt-BR')} às ${dateObj.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
            }).join('\n\n');
            resolve(`📋 *Extrato - Últimas 10 transações*\n\n${recent}`);
        });
    });
}
async function getMonthlyReport(userData) {
    const { income, expenses, balance } = await getMonthlyBalance(userData.jid);
    const budget = userData.monthlyBudget;
    let budgetStatus = `🎯 Orçamento: ${budget > 0 ? formatCurrency(budget) : 'Não definido'}`;
    if (budget > 0) {
        const remainingBudget = budget - expenses;
        const percentageUsed = budget > 0 ? ((expenses / budget) * 100) : 0;
        budgetStatus += `\nUtilizado: ${formatCurrency(expenses)} de ${formatCurrency(budget)} (${percentageUsed.toFixed(0)}%)`;
        budgetStatus += `\nSaldo do Orçamento: ${formatCurrency(remainingBudget)}`;
        budgetStatus += `\n${expenses > budget ? '🔴 Status: Acima do orçamento' : '🟢 Status: Dentro do orçamento'}`;
    } else {
        budgetStatus = '⚠️ Orçamento mensal não definido.';
    }
    return `📊 *Resumo Mensal - ${new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}*\n\n💰 Receitas: ${formatCurrency(income)}\n💸 Despesas: ${formatCurrency(expenses)}\n📈 Saldo do Mês: ${formatCurrency(balance)}\n\n${budgetStatus}`;
}
async function getCategoryReport(userData) {
    const categoryExpenses = await getCategoryExpenses(userData.jid, userData.categories);
    const totalExpenses = Object.values(categoryExpenses).reduce((sum, val) => sum + val, 0);
    if (totalExpenses === 0) return `📊 *Gastos por Categoria*\n\nNenhuma despesa registrada este mês.`;
    
    let report = '📊 *Gastos por Categoria - Mês Atual*\n\n';
    Object.entries(categoryExpenses).forEach(([category, amount]) => {
        if (amount > 0) {
            const percentage = ((amount / totalExpenses) * 100).toFixed(1);
            report += `📂 ${category}: ${formatCurrency(amount)} (${percentage}%)\n`;
        }
    });
    report += `\n💸 *Total de Despesas:* ${formatCurrency(totalExpenses)}`;
    return report;
}
async function getSettings(userData) {
    const [transactionsCount, goalsCount] = await Promise.all([
        new Promise((res, rej) => db.get("SELECT COUNT(*) as count FROM Transactions WHERE userJid = ?", [userData.jid], (e, r) => e ? rej(e) : res(r.count))),
        new Promise((res, rej) => db.get("SELECT COUNT(*) as count FROM Goals WHERE userJid = ?", [userData.jid], (e, r) => e ? rej(e) : res(r.count)))
    ]);
    return `⚙️ *Configurações*\n\n📊 Total de transações: ${transactionsCount}\n🎯 Orçamento mensal: ${userData.monthlyBudget > 0 ? formatCurrency(userData.monthlyBudget) : 'Não definido'}\n🏆 Metas ativas: ${goalsCount}\n\n*Comandos:*\n• *limpar dados* para apagar tudo.\n• *menu* para voltar.`;
}

// --- NOVAS FUNÇÕES DE GERAÇÃO DE SUB-MENUS ---
function getReportsMenu() {
    return `*Meus Relatórios* 📊\n\nQual relatório você quer ver?\n\n1️⃣ Extrato Recente\n2️⃣ Resumo do Mês\n3️⃣ Gastos por Categoria\n\nDigite "menu" para voltar.`;
}
function getManageMenu() {
    return `*Gerenciar Finanças* 🛠️\n\nO que você quer gerenciar?\n\n1️⃣ Orçamento Mensal\n2️⃣ Minhas Metas\n3️⃣ Meus Cartões de Crédito\n4️⃣ Despesas Agendadas\n\nDigite "menu" para voltar.`;
}
function getManualEntryMenu() {
    return `*Lançar Manualmente* ✍️\n\nO que você quer lançar?\n\n1️⃣ Adicionar Despesa\n2️⃣ Adicionar Receita\n\nDigite "menu" para voltar.`;
}

// --- FUNÇÕES DE PROCESSAMENTO DE ESTADO (HANDLERS) ---
async function processMainMenu(userData, option) {
    switch (option) {
        case '1':
            userData.currentState = 'selecting_report';
            return getReportsMenu();
        case '2':
            userData.currentState = 'managing_finances';
            return getManageMenu();
        case '3':
            userData.currentState = 'manual_entry';
            return getManualEntryMenu();
        case '4':
            return getHelp();
        default:
            return `Opção inválida. Por favor, escolha uma das opções abaixo:\n\n${getMainMenu()}`;
    }
}
async function processSelectingReport(userData, option) {
    let response;
    switch (option) {
        case '1': response = await getStatement(userData); break;
        case '2': response = await getMonthlyReport(userData); break;
        case '3': response = await getCategoryReport(userData); break;
        default: response = `Opção inválida.\n\n${getReportsMenu()}`; break;
    }
    userData.currentState = 'menu';
    return response;
}
async function processManagingFinances(userData, option) {
    switch (option) {
        case '1':
            userData.currentState = 'setting_budget';
            return `🎯 *Definir Orçamento Mensal*\n\nDigite o valor:`;
        case '2':
            userData.currentState = 'adding_goal';
            return `🎯 *Criar Meta Financeira*\n\nDigite no formato:\nNome | Valor total | Prazo em meses`;
        case '3':
            userData.currentState = 'managing_cards_menu';
            return await getCardsMenu(getCreditCardsForUser, userData.jid);
        case '4':
            userData.currentState = 'selecting_category';
            userData.tempData = { transactionType: 'expense', scheduled: true };
            return getCategoryMenu('Despesa Agendada', userData.categories);
        default:
            return `Opção inválida.\n\n${getManageMenu()}`;
    }
}
async function processManualEntry(userData, option) {
    switch (option) {
        case '1':
            userData.currentState = 'selecting_category';
            userData.tempData = { transactionType: 'expense', scheduled: false };
            return getCategoryMenu('Despesa Única', userData.categories);
        case '2':
            userData.currentState = 'adding_income';
            return `💰 *Adicionar Receita*\n\nDigite o valor da receita:`;
        default:
            return `Opção inválida.\n\n${getManualEntryMenu()}`;
    }
}
async function processAwaitingNextEntry(userData, message) {
    const quickExpense = await tryParseQuickExpense(message, userData);
    if (quickExpense.success) {
        Object.assign(userData.tempData, quickExpense);
        return await processConfirmQuickExpense(userData, 'sim');
    }
    const quickIncome = await tryParseQuickIncome(message);
    if (quickIncome.success) {
        Object.assign(userData.tempData, quickIncome);
        return await processConfirmQuickIncome(userData, 'sim');
    }
    const normalizedInput = normalizeText(message);
    if (['nao', 'n', 'chega', 'parar', 'menu', 'cancelar'].includes(normalizedInput)) {
        userData.currentState = 'menu';
        userData.tempData = {};
        return getMainMenu();
    }
    return `Não entendi. Deseja lançar outra transação ou voltar ao "menu"?`;
}
async function processExpenseDescription(userData, message) {
    const normalizedInput = normalizeText(message);
    let finalDescription = (normalizedInput !== 'nao' && normalizedInput !== 'pular' && normalizedInput !== 'n') ? message.trim() : (userData.tempData.description || '');
    await addTransaction(userData.jid, 'expense', userData.tempData.amount, userData.tempData.category, finalDescription, userData.tempData.cardId, userData.tempData.isVoiceInput || false);
    const response = `✅ Despesa de ${formatCurrency(userData.tempData.amount)} (${finalDescription || userData.tempData.category}) registrada.`;
    userData.currentState = 'awaiting_next_entry';
    userData.tempData = {};
    return `${response} Deseja lançar outra?`;
}
async function processAddingTransaction(userData, message, type) {
    const amount = parseCurrencyValue(message);
    if (isNaN(amount) || amount <= 0) return `❌ Valor inválido! Digite um valor numérico positivo.`;
    if (type === 'income') {
        await addTransaction(userData.jid, 'income', amount, 'Receita', 'Receita manual');
        const response = `✅ Receita de ${formatCurrency(amount)} registrada.`;
        userData.currentState = 'awaiting_next_entry';
        userData.tempData = {};
        return `${response} Deseja lançar outra?`;
    } else {
        userData.tempData.amount = amount;
        userData.currentState = 'awaiting_expense_description';
        return `✅ Valor ${formatCurrency(amount)} anotado.\n📝 Quer adicionar uma descrição? (Ou digite "não")`;
    }
}
async function processConfirmQuickExpense(userData, message) {
    if (normalizeText(message).startsWith('s')) {
        return await processExpenseDescription(userData, 'pular');
    }
    userData.currentState = 'menu';
    userData.tempData = {};
    return `Ok, lançamento cancelado.`;
}
async function processConfirmQuickIncome(userData, message) {
    if (normalizeText(message).startsWith('s')) {
        await addTransaction(userData.jid, 'income', userData.tempData.amount, 'Receita', userData.tempData.description, null, true);
        const successMsg = `✅ Receita de ${formatCurrency(userData.tempData.amount)} (${userData.tempData.description || 'Receita por voz'}) registrada.`;
        userData.currentState = 'awaiting_next_entry';
        userData.tempData = {};
        return `${successMsg} Deseja lançar outra?`;
    }
    userData.currentState = 'menu';
    userData.tempData = {};
    return `Ok, lançamento cancelado.`;
}
async function processSettingBudget(userData, message) {
    const budget = parseCurrencyValue(message);
    if (isNaN(budget) || budget <= 0) return `❌ Valor inválido!`;
    userData.monthlyBudget = budget;
    db.run("UPDATE Users SET monthlyBudget = ? WHERE jid = ?", [budget, userData.jid]);
    userData.currentState = 'menu';
    return `✅ Orçamento mensal definido para ${formatCurrency(budget)}.`;
}
async function processAddingGoal(userData, message) {
    const parts = message.split('|').map(p => p.trim());
    if (parts.length !== 3) return `❌ Formato inválido!\nUse: Nome | Valor | Meses`;
    const [name, valueStr, monthsStr] = parts;
    const value = parseCurrencyValue(valueStr);
    const months = parseInt(normalizeText(monthsStr));
    if (isNaN(value) || isNaN(months) || value <= 0 || months <= 0) return `❌ Valores inválidos!`;
    return new Promise(resolve => {
        db.run("INSERT INTO Goals (userJid, name, targetValue, months, monthlyTarget, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
            [userData.jid, name, value, months, value / months, new Date().toISOString()], (err) => {
                if (err) resolve(`❌ Erro ao salvar.`);
                userData.currentState = 'menu';
                resolve(`✅ *Meta "${name}" criada!*\n💰 Valor: ${formatCurrency(value)}\n📅 Prazo: ${months} meses`);
            });
    });
}
async function processAddingGoalAskValueFromVoice(userData, message) {
    const value = parseCurrencyValue(message);
    if (isNaN(value) || value <= 0) return `❌ Valor inválido! Qual o valor total para a meta?`;
    userData.tempData.goalTargetValue = value;
    userData.currentState = 'confirm_voice_goal';
    return `🎙️ Ok! Meta: "${userData.tempData.goalName}", Valor: ${formatCurrency(value)}, Prazo: ${userData.tempData.goalMonths} meses. Correto? (Sim/Não)`;
}
async function processConfirmVoiceGoal(userData, message) {
    if (normalizeText(message).startsWith('s')) {
        const { goalName, goalTargetValue, goalMonths } = userData.tempData;
        return await processAddingGoal(userData, `${goalName} | ${goalTargetValue} | ${goalMonths}`);
    }
    userData.currentState = 'menu';
    userData.tempData = {};
    return `Ok, criação de meta cancelada.`;
}
const stateHandlers = {
    'menu': processMainMenu,
    'selecting_report': processSelectingReport,
    'managing_finances': processManagingFinances,
    'manual_entry': processManualEntry,
    'awaiting_next_entry': processAwaitingNextEntry,
    'adding_income': (userData, message) => processAddingTransaction(userData, message, 'income'),
    'awaiting_expense_description': processExpenseDescription,
    'setting_budget': processSettingBudget,
    'adding_goal': processAddingGoal,
    'confirm_quick_expense': processConfirmQuickExpense,
    'confirm_quick_income': processConfirmQuickIncome,
    'adding_goal_ask_value_from_voice': processAddingGoalAskValueFromVoice,
    'confirm_voice_goal': processConfirmVoiceGoal,
};
async function processCommand(userData, message) {
    if (message === 'nav_menu_principal') {
        userData.currentState = 'menu';
        userData.tempData = {};
        return getMainMenu();
    }
    const currentHandler = stateHandlers[userData.currentState];
    if (currentHandler) {
        return await currentHandler(userData, message);
    }
    logger.warn({ jid: userData.jid, state: userData.currentState, message }, `[PoupaZap] Nenhum handler encontrado para o estado atual. Resetando para menu.`);
    userData.currentState = 'menu';
    userData.tempData = {};
    return `😕 Não entendi. Voltando ao menu principal.\n\n${getMainMenu()}`;
}
module.exports = {
    processCommand,
    tryParseQuickExpense,
    tryParseCreateGoalVoice,
    tryParseQuickIncome,
};
// whatsapp.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const { processCommand, tryParseQuickExpense, tryParseCreateGoalVoice, tryParseQuickIncome } = require('./handlers');
const { transcribeAudio, awsConfigValid } = require('./aws');
const { getUserData, saveUserDataState } = require('./database');
const { mapInputToMenuOption, getMainMenu, formatCurrency } = require('./utils');

let whatsappSocket = null;

function getSocket() {
    return whatsappSocket;
}

async function connectToWhatsApp() {
    const PERSISTENT_DATA_ROOT = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname);
    const AUTH_STATE_FOLDER = path.join(PERSISTENT_DATA_ROOT, 'poupazap_persistent_data', 'baileys_auth_info');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_STATE_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    logger.info(`[Baileys] Usando v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'warn' }),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: Browsers.ubuntu('Chrome'),
    });

    whatsappSocket = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true }, (qrString) => {
                console.log("\n--[ ESCANEIE O QR CODE ]--\n" + qrString + "\n--------------------------\n");
            });
            fs.writeFileSync(path.join(__dirname, 'qr_code.txt'), qr, (err) => {
                if(err) logger.error({err}, "Erro ao salvar qr_code.txt");
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            logger.error({err: lastDisconnect.error}, `[Baileys] Conexão fechada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                logger.error("Não foi possível reconectar. O bot foi deslogado.");
            }
        } else if (connection === 'open') {
            logger.info(`[Baileys] Conexão aberta com sucesso!`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' || !m.messages[0]) return;

        const msgInfo = m.messages[0];
        if (msgInfo.key.fromMe || !msgInfo.message) return;
    
        const fromUserJid = msgInfo.key.remoteJid;
        let incomingMsgText = msgInfo.message.conversation || msgInfo.message.extendedTextMessage?.text || '';
        const isAudioMessage = !!msgInfo.message.audioMessage;
        let responseText = "";
    
        const userData = await getUserData(fromUserJid, msgInfo.pushName);
        
        if (isAudioMessage) {
            if (!awsConfigValid) {
                responseText = "Desculpe, a função de transcrição de áudio não está habilitada.";
            } else {
                try {
                    await sock.sendMessage(fromUserJid, { text: "🎙️ Ouvindo..." });
                    const transcribedText = await transcribeAudio(sock, msgInfo);
                    if (transcribedText) {
                        incomingMsgText = transcribedText;
                        userData.tempData.isVoiceInput = true;
                    } else {
                        responseText = "😕 Desculpe, não consegui entender o áudio.";
                    }
                } catch (e) {
                    responseText = "😕 Tive um problema ao processar seu áudio.";
                }
            }
        }
        
        if (!incomingMsgText.trim() && !responseText) return;
    
        if (responseText) {
            await sock.sendMessage(fromUserJid, { text: responseText });
            return;
        }
    
        try {
            if (['menu', 'awaiting_next_entry'].includes(userData.currentState)) {
                const intentParsers = [tryParseQuickExpense, tryParseQuickIncome, tryParseCreateGoalVoice];
                let parsedIntent;
                for (const parser of intentParsers) {
                    parsedIntent = await parser(incomingMsgText, userData);
                    if (parsedIntent && parsedIntent.success) break;
                }
                if (parsedIntent && parsedIntent.success) {
                    Object.assign(userData.tempData, parsedIntent);
                    if (parsedIntent.type === 'quick_expense') {
                        userData.currentState = 'confirm_quick_expense';
                        responseText = `🎙️ Entendi: Gastou ${formatCurrency(parsedIntent.amount)} em ${parsedIntent.category} (${parsedIntent.description}). Correto? (Sim/Não)`;
                    } else if (parsedIntent.type === 'quick_income') {
                        userData.currentState = 'confirm_quick_income';
                        responseText = `🎙️ Entendi: Recebeu ${formatCurrency(parsedIntent.amount)} (${parsedIntent.description}). Correto? (Sim/Não)`;
                    } else if (parsedIntent.type === 'create_goal_intent') {
                        const { name, months, value } = parsedIntent.data;
                        Object.assign(userData.tempData, { goalName: name, goalMonths: months });
                        if (value > 0) {
                            userData.currentState = 'confirm_voice_goal';
                            userData.tempData.goalTargetValue = value;
                            responseText = `🎙️ Meta: "${name}" de ${formatCurrency(value)} em ${months} meses. Correto?`;
                        } else {
                            userData.currentState = 'adding_goal_ask_value_from_voice';
                            responseText = `🎙️ Ok, meta "${name}" por ${months} meses. Qual o valor total?`;
                        }
                    }
                }
            }

            if (!responseText) {
                const mappedCommand = mapInputToMenuOption(incomingMsgText);
                responseText = await processCommand(userData, mappedCommand);
            }
            
            await saveUserDataState(userData);
            if (responseText) await sock.sendMessage(fromUserJid, { text: responseText });

        } catch (error) {
            logger.error({ err: error, jid: fromUserJid }, "Erro GRASSO ao processar mensagem");
            await sock.sendMessage(fromUserJid, { text: "😕 Ops! Ocorreu um erro interno." });
        }
    });
    
    return sock;
}

module.exports = {
    connectToWhatsApp,
    getSocket
};
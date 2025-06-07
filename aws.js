// aws.js
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
} catch (e) {
  logger.warn('[FFMPEG] @ffmpeg-installer/ffmpeg não encontrado, assumindo que ffmpeg está no PATH.');
}

const PERSISTENT_DATA_ROOT = process.env.RENDER_DISK_MOUNT_PATH || path.join(__dirname);
const DATA_DIR_NAME = 'poupazap_persistent_data';
const TEMP_AUDIO_DIR = path.join(PERSISTENT_DATA_ROOT, DATA_DIR_NAME, 'temp_audio');

let s3Client;
let transcribeClient;
let awsConfigValid = false;

const validateEnv = () => {
  const requiredVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET_NAME_FOR_TRANSCRIBE'];
  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    logger.error(`[AWS] Variáveis de ambiente faltando: ${missingVars.join(', ')}. Transcrição desabilitada.`);
    return false;
  }
  return true;
};

awsConfigValid = validateEnv();

if (awsConfigValid) {
    try {
        s3Client = new S3Client({ region: process.env.AWS_REGION });
        transcribeClient = new TranscribeClient({ region: process.env.AWS_REGION });
        logger.info(`[AWS] Clientes S3 e Transcribe configurados para a região: ${process.env.AWS_REGION}`);
    } catch (e) {
        logger.error({ err: e }, "[AWS] Erro ao inicializar clientes AWS.");
        awsConfigValid = false;
    }
}

async function transcribeAudio(sock, msgInfo) {
    if (!awsConfigValid) {
        logger.warn("[TranscribeAudio] Tentativa de transcrever áudio, mas a configuração da AWS é inválida.");
        return null;
    }

    const fromUserJid = msgInfo.key.remoteJid;
    const audioId = msgInfo.key.id;
    const timestamp = Date.now();
    const tempInputPath = path.join(TEMP_AUDIO_DIR, `${timestamp}-input.ogg`);
    const tempOutputPath = path.join(TEMP_AUDIO_DIR, `${timestamp}-output.mp3`);
    const s3Key = `audio-uploads/${fromUserJid}/${timestamp}.mp3`;
    const transcriptionJobName = `PoupaZap-Transcription-${timestamp}-${uuidv4().slice(0, 8)}`;
    const outputKey = `transcripts/${fromUserJid}/${transcriptionJobName}.json`;

    try {
        const audioBuffer = await downloadMediaMessage(msgInfo, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        await fsp.writeFile(tempInputPath, audioBuffer);

        await new Promise((resolve, reject) => {
            ffmpeg(tempInputPath)
                .toFormat('mp3')
                .on('error', reject)
                .on('end', resolve)
                .save(tempOutputPath);
        });

        const mp3Buffer = await fsp.readFile(tempOutputPath);
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE, Key: s3Key, Body: mp3Buffer, ContentType: 'audio/mpeg' }));

        await transcribeClient.send(new StartTranscriptionJobCommand({
            TranscriptionJobName: transcriptionJobName,
            LanguageCode: 'pt-BR',
            MediaFormat: 'mp3',
            Media: { MediaFileUri: `s3://${process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE}/${s3Key}` },
            OutputBucketName: process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE,
            OutputKey: outputKey
        }));

        let jobStatus;
        for (let i = 0; i < 30; i++) { // Tenta por até 2.5 minutos
            await new Promise(r => setTimeout(r, 5000));
            const jobDetails = await transcribeClient.send(new GetTranscriptionJobCommand({ TranscriptionJobName: transcriptionJobName }));
            jobStatus = jobDetails.TranscriptionJob.TranscriptionJobStatus;
            if (jobStatus === 'COMPLETED' || jobStatus === 'FAILED') break;
        }

        if (jobStatus === 'COMPLETED') {
            const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE, Key: outputKey }));
            const transcriptBody = await s3Object.Body.transformToString();
            const transcriptData = JSON.parse(transcriptBody);
            return transcriptData.results?.transcripts?.[0]?.transcript;
        } else {
            logger.error(`[TranscribeAudio] Job de transcrição falhou ou expirou. Status: ${jobStatus}`);
            return null;
        }
    } catch (err) {
        logger.error({ err }, '[TranscribeAudio] Erro geral no processo de transcrição');
        return null;
    } finally {
        if (fs.existsSync(tempInputPath)) await fsp.unlink(tempInputPath);
        if (fs.existsSync(tempOutputPath)) await fsp.unlink(tempOutputPath);
        try {
            await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE, Key: s3Key }));
            await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME_FOR_TRANSCRIBE, Key: outputKey }));
        } catch (cleanupError) {
            // Ignora erros de limpeza se os arquivos nunca foram criados
        }
    }
}

module.exports = {
    transcribeAudio,
    awsConfigValid
};
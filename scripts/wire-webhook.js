/**
 * Aponta o número Twilio de voz (final 6311) para este servidor via ngrok.
 *
 * Uso:  npm run wire
 *
 * Requer no .env:
 *   PUBLIC_URL         — ex.: https://marchezini.ngrok.app
 *   VOICE_NUMBER_SID   — PN... do número de voz
 */
require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function main() {
  const base = process.env.PUBLIC_URL;
  if (!base || !base.startsWith('https://')) {
    console.error('  ✗ Configure PUBLIC_URL no .env com sua URL https do ngrok.');
    process.exit(1);
  }
  const voiceSid = process.env.VOICE_NUMBER_SID;
  if (!voiceSid) {
    console.error('  ✗ VOICE_NUMBER_SID não definido no .env');
    process.exit(1);
  }

  const updated = await client.incomingPhoneNumbers(voiceSid).update({
    voiceUrl: `${base}/voice/incoming`,
    voiceMethod: 'POST',
  });
  console.log(`  ✓ ${updated.phoneNumber} apontado`);
  console.log(`      Voice URL  ${updated.voiceUrl}`);
}

main().catch(err => {
  console.error('  ✗ Falhou:', err.message);
  process.exit(1);
});

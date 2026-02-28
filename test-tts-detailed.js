import { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } from './dist/config.js';
import { synthesizeSpeech } from './dist/voice.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

console.log('Configuration Check:');
console.log('- API Key present:', !!ELEVENLABS_API_KEY);
console.log('- API Key (masked):', ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.substring(0, 10) + '...' : 'NOT SET');
console.log('- Voice ID:', ELEVENLABS_VOICE_ID);
console.log('');

async function testTTS() {
  try {
    console.log('Testing ElevenLabs TTS API...');
    const testText = 'Hi Sia, voice mode is working now.';
    
    const audioBuffer = await synthesizeSpeech(testText);
    
    const outputPath = resolve('./test-audio-output.mp3');
    writeFileSync(outputPath, audioBuffer);
    
    console.log('✓ Success! Audio file saved to:', outputPath);
    console.log('✓ File size:', audioBuffer.length, 'bytes');
  } catch (error) {
    console.error('✗ Failed with error:');
    console.error('  Message:', error.message);
    if (error.response?.status) {
      console.error('  HTTP Status:', error.response.status);
    }
    if (error.response?.data) {
      console.error('  Response body:', error.response.data);
    }
  }
}

testTTS();

import { synthesizeSpeech } from './dist/voice.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

async function testTTS() {
  try {
    console.log('Testing ElevenLabs TTS API...');
    const testText = 'Hi Sia, voice mode is working now.';
    
    const audioBuffer = await synthesizeSpeech(testText);
    
    const outputPath = resolve('./test-audio-output.mp3');
    writeFileSync(outputPath, audioBuffer);
    
    console.log('Success! Audio file saved to:', outputPath);
    console.log('File size:', audioBuffer.length, 'bytes');
  } catch (error) {
    console.error('Failed with error:');
    console.error(error.message);
    if (error.response?.status) {
      console.error('Status:', error.response.status);
    }
    if (error.response?.data) {
      console.error('Response:', error.response.data);
    }
  }
}

testTTS();

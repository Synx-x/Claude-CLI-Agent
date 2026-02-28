import { synthesizeSpeech } from './dist/voice.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const text = "South Africa adjusted tax brackets and medical credits for 2026 27, first time in 2 years. Tax brackets up 3.4 percent, entry threshold now 99 thousand rand instead of 95,750. Medical credits up about 12 rand per month for main beneficiaries. Treasury loses 13.7 billion in revenue. Only covers last year's inflation, accumulated bracket creep still not fully addressed.";

async function main() {
  try {
    console.log('Synthesizing speech...');
    const audioBuffer = await synthesizeSpeech(text);
    
    const outputPath = join(process.cwd(), 'output.mp3');
    writeFileSync(outputPath, audioBuffer);
    
    console.log(`Audio file saved to: ${outputPath}`);
    console.log(`File size: ${audioBuffer.length} bytes`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
